import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const m = await import("../src/services/misEmail");
const mic = await import("../src/services/misMicrosoft");

describe("scheduledOccurrence (IST)", () => {
  it("finds tonight's run", () => {
    // 23:40 IST on 5 Oct = 18:10 UTC
    expect(m.scheduledOccurrence(new Date("2026-10-05T18:10:00Z"), "23:30", "Asia/Kolkata")).toEqual({ date: "2026-10-05", minutesSince: 10 });
  });
  it("a midnight run belongs to the new date; a minute early still counts", () => {
    expect(m.scheduledOccurrence(new Date("2026-10-05T18:31:00Z"), "00:00", "Asia/Kolkata")).toEqual({ date: "2026-10-06", minutesSince: 1 });
    expect(m.scheduledOccurrence(new Date("2026-10-05T18:29:00Z"), "00:00", "Asia/Kolkata")).toEqual({ date: "2026-10-06", minutesSince: 0 });
  });
  it("after midnight, a 23:30 run is still yesterday's", () => {
    expect(m.scheduledOccurrence(new Date("2026-10-05T18:45:00Z"), "23:30", "Asia/Kolkata")).toEqual({ date: "2026-10-05", minutesSince: 45 });
  });
});

describe("email helpers", () => {
  it("parses HR email lists", () => {
    expect(m.parseEmailList("hr@x.com, Boss@X.com;hr@x.com\nops@x.com")).toEqual(["hr@x.com", "boss@x.com", "ops@x.com"]);
    expect(m.isEmail("a@b.co")).toBe(true);
    expect(m.isEmail("anjali")).toBe(false);
  });
  it("only refreshes with Mail.Send when it was granted", () => {
    expect(mic.scopesAllowMail("https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Mail.Send")).toBe(true);
    expect(mic.scopesAllowMail("Files.Read.All User.Read Mail.Send")).toBe(true);
    expect(mic.scopesAllowMail("https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/User.Read")).toBe(false);
    expect(mic.scopesAllowMail(null)).toBe(false);
  });
});

describe("MIS Alert (9:30) and MIS Status (11:00) emails", () => {
  const base = {
    employeeId: "e1",
    name: "Mamta Sharma",
    email: "mamta@farsight.example, mamta2@farsight.example",
    hasMis: true,
    date: "2026-10-05",
    label: "Yesterday",
    deadlineText: "Tue 6 Oct, 11:00 AM",
    status: "MISSING",
    blanks: [] as string[],
    note: "No entry dated 05-10-2026 yet.",
    code: null as string | null,
    manual: false,
    reason: null as string | null,
    circles: 2,
    pendingCircles: 0,
    deductionDays: 0,
    untilNext: 1,
    circleDates: ["Thu 1 Oct", "Sat 3 Oct"],
    monthLabel: "October 2026",
  };
  const settings = { intro: null, footer: "Contact HR: {first}" };
  it("MIS Alert: a missing MIS, with the likely reason and no red-circle box", async () => {
    const e = m.buildWarningEmail(base, settings, "contactus@farsightshares.com");
    expect(e.subject).toBe("MIS Alert: your MIS for Mon 5 Oct is not filled yet — please fill it by Tue 6 Oct, 11:00 AM");
    expect(e.html).toContain("MIS Alert — Mon 5 Oct");
    expect(e.html).toContain("Reason: There is no column for Mon 5 Oct in your MIS file yet.");
    expect(e.html).toContain("Please complete it by Tue 6 Oct, 11:00 AM. If it is not done by then, a red circle will be marked.");
    expect(e.html).not.toContain("red circles so far");
    expect(e.html).not.toContain("salary");
    expect(e.text).toContain("Contact HR: Mamta");
    if (process.env.MIS_EMAIL_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_EMAIL_HTML_OUT, e.html);
  });
  it("MIS Alert: below 80% says how many boxes are missing and lists them (escaped)", async () => {
    const e = m.buildWarningEmail(
      { ...base, status: "INCOMPLETE", note: "Incomplete — 39 of 50 boxes filled (78%); at least 80% (40 of 50) is needed.", blanks: ["Calls made <today> (cell AA23)"] },
      settings,
      null,
    );
    expect(e.subject).toBe("MIS Alert: your MIS for Mon 5 Oct is incomplete — please complete it by Tue 6 Oct, 11:00 AM");
    expect(e.html).toContain("Reason: Only 39 of 50 boxes are filled (78%). You need at least 80% — 40 boxes — so please fill at least 1 more.");
    expect(e.html).toContain("Calls made &lt;today&gt; (cell AA23)");
    if (process.env.MIS_ALERT2_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_ALERT2_HTML_OUT, e.html);
  });
  it("MIS Alert: a copied day", () => {
    const e = m.buildWarningEmail({ ...base, note: "Copied from 02-10-2026 — all 9 entries are exactly the same as on 02-10-2026 …" }, settings, null);
    expect(e.html).toContain("Reason: Your entries for Mon 5 Oct are exactly the same as on Fri 2 Oct, so they look copied.");
  });
  it("only warns people who haven't submitted (and not people on leave)", () => {
    expect(m.needsWarning(base)).toBe(true);
    expect(m.needsWarning({ ...base, status: "INCOMPLETE" })).toBe(true);
    expect(m.needsWarning({ ...base, status: "COMPLETE" })).toBe(false);
    expect(m.needsWarning({ ...base, manual: true, code: "OL" })).toBe(false);
    expect(m.needsWarning({ ...base, hasMis: false })).toBe(false);
  });
  it("MIS Status: red circle with a 1–2 line reason, no red-circle box", async () => {
    const red = m.buildResultEmail(
      { ...base, code: "CM", circles: 3, deductionDays: 1, untilNext: 3, reason: "Incomplete — only 39 of 50 boxes filled (78%) at the deadline; at least 80% is needed." },
      settings,
      null,
    )!;
    expect(red.outcome).toBe("RED");
    expect(red.subject).toBe("MIS Status for Mon 5 Oct: red circle marked");
    expect(red.html).toContain("MIS Status — Mon 5 Oct");
    expect(red.html).toContain("A red circle has been marked for Mon 5 Oct.");
    expect(red.html).toContain("Reason: Only 39 of 50 boxes were filled (78%) by Tue 6 Oct, 11:00 AM. At least 80% (40 boxes) is needed.");
    expect(red.html).not.toContain("red circles:");
    expect(red.html).not.toContain("salary");
    const notFilled = m.buildResultEmail({ ...base, code: "CM", reason: "No entry dated 05-10-2026 yet — still the case at the deadline." }, settings, null)!;
    expect(notFilled.html).toContain("Reason: There was no column for Mon 5 Oct in your MIS file by Tue 6 Oct, 11:00 AM.");
    const hr = m.buildResultEmail({ ...base, code: "CM", manual: true, reason: "Absent without leave" }, settings, null)!;
    expect(hr.html).toContain("Reason: Marked by HR: Absent without leave.");
    const green = m.buildResultEmail({ ...base, code: "NC", reason: "Submitted before the deadline — 48 of 50 boxes filled (96%)." }, settings, null)!;
    expect(green.outcome).toBe("GREEN");
    expect(green.subject).toBe("MIS Status for Mon 5 Oct: submitted on time");
    expect(green.html).toContain("Your MIS for Mon 5 Oct was submitted on time (48 of 50 boxes filled). Thank you.");
    expect(m.buildResultEmail({ ...base, code: "IN" }, settings, null)!.outcome).toBe("YELLOW"); // only set by hand now
    expect(m.buildResultEmail({ ...base, code: "OL", manual: true }, settings, null)).toBeNull();
    if (process.env.MIS_RESULT_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_RESULT_HTML_OUT, red.html);
    if (process.env.MIS_GREEN_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_GREEN_HTML_OUT, green.html);
  });
  it("HR status report lists red first, with the reason", async () => {
    const hr = m.buildHrSummary([{ ...base, name: "Zed", code: "NC" }, { ...base, code: "CM", reason: "No entry dated 05-10-2026 yet — still the case at the deadline." }], null);
    expect(hr.subject).toBe("MIS Status Report Mon 5 Oct — 1 red circle, 1 submitted");
    expect(hr.html.indexOf("Mamta Sharma")).toBeLessThan(hr.html.indexOf("Zed"));
    expect(hr.html).toContain("There was no column for Mon 5 Oct in their MIS file by Tue 6 Oct, 11:00 AM.");
    if (process.env.MIS_HR_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_HR_HTML_OUT, hr.html);
  });
});

describe("dueKind", () => {
  // Deadline: Tue 6 Oct 11:00 IST = 05:30 UTC
  const t = { today: "2026-10-06", deadlineIsToday: true, deadline: { at: new Date("2026-10-06T05:30:00Z") } };
  const s = { warnEnabled: true, warnTime: "09:30", resultEnabled: true, lastWarnDate: null as string | null, lastResultDate: null as string | null };
  it("warning from 9:30 until the deadline, result from 11:00", () => {
    expect(m.dueKind(s, t, new Date("2026-10-06T03:55:00Z"))).toBeNull(); // 9:25
    expect(m.dueKind(s, t, new Date("2026-10-06T04:00:00Z"))).toBe("WARN"); // 9:30
    expect(m.dueKind(s, t, new Date("2026-10-06T05:20:00Z"))).toBe("WARN"); // 10:50 (server was asleep)
    expect(m.dueKind({ ...s, lastWarnDate: "2026-10-06" }, t, new Date("2026-10-06T05:20:00Z"))).toBeNull();
    expect(m.dueKind({ ...s, lastWarnDate: "2026-10-06" }, t, new Date("2026-10-06T05:30:00Z"))).toBe("RESULT"); // 11:00
    expect(m.dueKind({ ...s, lastWarnDate: "2026-10-06", lastResultDate: "2026-10-06" }, t, new Date("2026-10-06T06:00:00Z"))).toBeNull();
  });
  it("nothing on a day off", () => {
    expect(m.dueKind(s, { ...t, deadlineIsToday: false }, new Date("2026-10-06T04:00:00Z"))).toBeNull();
  });
});

describe("matching pasted names and addresses", () => {
  const staff = [
    { name: "Anjali Jha", email: "anjali" },
    { name: "Deepshikha", email: "deepshikha" },
    { name: "Diya", email: "diya" },
    { name: "Aman Nair", email: "aman nair" },
    { name: "Sohan", email: "sohan" },
  ];
  it.each([
    ["Anjali Jha", "Anjali Jha"],
    ["Deepskhikha", "Deepshikha"], // typo
    ["Diya", "Diya"],
    ["Aman Nair", "Aman Nair"],
    ["sohan", "Sohan"],
  ])("%s -> %s", (input, want) => {
    expect(m.matchPersonByName(staff, input)?.name).toBe(want);
  });
  it("doesn't guess when unsure", () => {
    expect(m.matchPersonByName(staff, "Rajiv")).toBeNull();
  });
  it("keeps several addresses for one person", () => {
    expect(m.cleanAddressList("farsightkunjee@gmail.com,  INFO@trryitt.com")).toEqual({ value: "farsightkunjee@gmail.com, info@trryitt.com", bad: [] });
    expect(m.cleanAddressList("x@y.com amd").bad).toEqual(["amd"]);
  });
});
