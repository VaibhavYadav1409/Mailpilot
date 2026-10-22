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

describe("MIS Alert (9:30) and MIS Status (12:00) emails", () => {
  const base = {
    employeeId: "e1",
    name: "Mamta Sharma",
    email: "mamta@farsight.example, mamta2@farsight.example",
    hasMis: true,
    date: "2026-10-05",
    label: "Yesterday",
    deadlineText: "Tue 6 Oct, 12:00 PM",
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
  it("MIS Alert: only \"incomplete\" and the deadline — no percentages, no footer", async () => {
    for (const p of [base, { ...base, status: "INCOMPLETE", note: "Incomplete — 24 of 36 boxes filled (66%); at least 80% (29 of 36) is needed.", blanks: ["Calls made (cell AA23)"] }]) {
      const e = m.buildWarningEmail(p, settings, "contactus@farsightshares.com");
      expect(e.subject).toBe("MIS Alert: Mon 5 Oct — please complete by Tue 6 Oct, 12:00 PM");
      expect(e.html).toContain("MIS Alert — Mon 5 Oct");
      expect(e.html).toContain("Your MIS for Mon 5 Oct is incomplete.");
      expect(e.html).toContain("Please complete it by Tue 6 Oct, 12:00 PM.");
      for (const gone of ["66%", "24 of 36", "Calls made", "Automatic email from MailPilot", "need no MIS", "red circles so far", "salary"]) expect(e.html).not.toContain(gone);
      expect(e.text).toContain("Contact HR: Mamta");
    }
    if (process.env.MIS_EMAIL_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_EMAIL_HTML_OUT, m.buildWarningEmail(base, settings, null).html);
  });
  it("only warns people who haven't submitted (and not people on leave)", () => {
    expect(m.needsWarning(base)).toBe(true);
    expect(m.needsWarning({ ...base, status: "INCOMPLETE" })).toBe(true);
    expect(m.needsWarning({ ...base, status: "COMPLETE" })).toBe(false);
    expect(m.needsWarning({ ...base, manual: true, code: "OL" })).toBe(false);
    expect(m.needsWarning({ ...base, hasMis: false })).toBe(false);
  });
  it("MIS Status: two outcomes only — Complete (green) or Incomplete (red), no footer", async () => {
    const red = m.buildResultEmail({ ...base, code: "CM", reason: "Incomplete — only 39 of 50 boxes filled (78%) at the deadline; at least 80% is needed." }, settings, null)!;
    expect(red.outcome).toBe("RED");
    expect(red.subject).toBe("MIS Status for Mon 5 Oct: incomplete — red circle");
    expect(red.html).toContain("Incomplete — red circle");
    expect(red.html).toContain("Your MIS for Mon 5 Oct was incomplete at the deadline (Tue 6 Oct, 12:00 PM). A red circle has been marked.");
    const green = m.buildResultEmail({ ...base, code: "NC" }, settings, null)!;
    expect(green.outcome).toBe("GREEN");
    expect(green.subject).toBe("MIS Status for Mon 5 Oct: complete — green circle");
    expect(green.html).toContain("Complete — green circle");
    expect(green.html).toContain("Your MIS for Mon 5 Oct is complete. Thank you.");
    for (const e of [red, green]) for (const gone of ["78%", "Automatic email from MailPilot", "need no MIS", "salary"]) expect(e.html).not.toContain(gone);
    expect(m.buildResultEmail({ ...base, code: "CM", manual: true }, settings, null)!.html).toContain("This was marked by HR.");
    expect(m.buildResultEmail({ ...base, code: "IN" }, settings, null)).toBeNull(); // only two outcomes
    expect(m.buildResultEmail({ ...base, code: "OL", manual: true }, settings, null)).toBeNull();
    if (process.env.MIS_RESULT_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_RESULT_HTML_OUT, red.html);
    if (process.env.MIS_GREEN_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_GREEN_HTML_OUT, green.html);
  });
  it("HR status report lists red first, with the reason", async () => {
    const hr = m.buildHrSummary([{ ...base, name: "Zed", code: "NC" }, { ...base, code: "CM", reason: "No entry dated 05-10-2026 yet — still the case at the deadline." }], null);
    expect(hr.subject).toBe("MIS Status Report Mon 5 Oct — 1 complete, 1 incomplete");
    expect(hr.html).not.toContain("Automatic email from MailPilot");
    expect(hr.html.indexOf("Mamta Sharma")).toBeLessThan(hr.html.indexOf("Zed"));
    expect(hr.html).toContain("There was no column for Mon 5 Oct in their MIS file by Tue 6 Oct, 12:00 PM.");
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
