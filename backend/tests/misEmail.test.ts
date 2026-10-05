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

describe("warning (9:30) and result (11:00) emails", () => {
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
    note: "Not filled for 05-10-2026 — 24 of 30 usual entries are blank.",
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
  it("warns about a missing MIS and what a red circle would mean", async () => {
    const e = m.buildWarningEmail(base, settings, "contactus@farsightshares.com");
    expect(e.subject).toBe("Reminder: your MIS for Mon 5 Oct is not submitted — submit it before 11:00 AM");
    expect(e.html).toContain("Please submit it before Tue 6 Oct, 11:00 AM. If it is not submitted by then, a red circle will be marked.");
    expect(e.html).toContain("you will have 3 — that means 1 day of salary deducted");
    expect(e.text).toContain("Contact HR: Mamta");
    if (process.env.MIS_EMAIL_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_EMAIL_HTML_OUT, e.html);
  });
  it("lists the blank cells for an incomplete MIS (escaped)", () => {
    const e = m.buildWarningEmail({ ...base, status: "INCOMPLETE", blanks: ["AA23 — Calls made <today>"] }, settings, null);
    expect(e.subject).toContain("is incomplete");
    expect(e.html).toContain("AA23 — Calls made &lt;today&gt;");
  });
  it("only warns people who haven't submitted (and not people on leave)", () => {
    expect(m.needsWarning(base)).toBe(true);
    expect(m.needsWarning({ ...base, status: "INCOMPLETE" })).toBe(true);
    expect(m.needsWarning({ ...base, status: "COMPLETE" })).toBe(false);
    expect(m.needsWarning({ ...base, manual: true, code: "OL" })).toBe(false);
    expect(m.needsWarning({ ...base, hasMis: false })).toBe(false);
  });
  it("result: red / yellow / green", async () => {
    const red = m.buildResultEmail({ ...base, code: "CM", circles: 3, deductionDays: 1, untilNext: 3, reason: "Not filled — still the case at the deadline." }, settings, null)!;
    expect(red.outcome).toBe("RED");
    expect(red.subject).toBe("MIS Mon 5 Oct: not submitted — red circle marked");
    expect(red.html).toContain("was not submitted by Tue 6 Oct, 11:00 AM, so a red circle has been marked.");
    expect(red.html).toContain("3 red circles ÷ 3 = 1 day.");
    const yellow = m.buildResultEmail({ ...base, code: "IN" }, settings, null)!;
    expect(yellow.outcome).toBe("YELLOW");
    expect(yellow.subject).toContain("incomplete — marked yellow");
    const green = m.buildResultEmail({ ...base, code: "NC" }, settings, null)!;
    expect(green.outcome).toBe("GREEN");
    expect(green.subject).toBe("MIS Mon 5 Oct: submitted — green (no circle)");
    expect(m.buildResultEmail({ ...base, code: "OL", manual: true }, settings, null)).toBeNull();
    if (process.env.MIS_RESULT_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_RESULT_HTML_OUT, red.html);
  });
  it("HR summary lists red first", () => {
    const hr = m.buildHrSummary([{ ...base, name: "Zed", code: "NC" }, { ...base, code: "CM" }], null);
    expect(hr.subject).toBe("MIS result Mon 5 Oct — 1 red circle, 0 incomplete, 1 submitted");
    expect(hr.html.indexOf("Mamta Sharma")).toBeLessThan(hr.html.indexOf("Zed"));
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
