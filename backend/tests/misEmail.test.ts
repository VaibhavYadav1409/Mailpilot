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

describe("buildPersonEmail", () => {
  const src = (over: object) => ({ id: "s", label: "", fileName: "MIS.xlsx", webUrl: "", checkedBy: null, approvedBy: null, status: "COMPLETE", rowCount: 30, missingColumns: [], blanks: [], note: null, checkedAt: null, completedAt: null, fileSavedAt: null, fileSavedBy: null, ...over });
  const person = {
    employeeId: "e1",
    name: "Mamta Sharma",
    email: "mamta@farsight.example",
    hasMis: true,
    days: [
      {
        date: "2026-10-05",
        label: "Yesterday",
        open: true,
        deadlineText: "Tue 6 Oct, 11:59 PM",
        mis: { status: "INCOMPLETE", submitted: false, completedAt: null, missingColumns: ["Calls"], sources: [src({ status: "INCOMPLETE", blanks: [{ sheet: "Oct", cell: "AA23", field: "Calls made <today>" }] })] },
        code: "IN",
        reason: null,
      },
      { date: "2026-10-03", label: "Previous working day", open: false, deadlineText: "", mis: null, code: "CM", reason: "Not filled for 03-10-2026 — 24 of 30 usual entries are blank — still the case at the deadline." },
    ],
    circles: 4,
    pendingCircles: 0,
    deductionDays: 1,
    untilNext: 2,
    circleDates: ["Thu 1 Oct", "Sat 3 Oct"],
    monthLabel: "October 2026",
  };
  it("explains both days, the deadline and the month, and escapes text", async () => {
    const e = m.buildPersonEmail(person as never, { subject: null, intro: null, footer: "Contact HR: {first}" }, "contactus@farsightshares.com", "2026-10-06");
    expect(e.subject).toBe("MIS update — Mamta Sharma — Tue 6 Oct");
    expect(e.hasIssue).toBe(true);
    expect(e.html).toContain("AA23 — Calls made &lt;today&gt;");
    expect(e.html).toContain("Deadline: Tue 6 Oct, 11:59 PM");
    expect(e.html).toContain("Red circle");
    expect(e.html).toContain("4 red circles ÷ 3 = 1 day (1 circle left over");
    expect(e.html).toContain("2 more red circles = 2 days");
    expect(e.text).toContain("Contact HR: Mamta");
    if (process.env.MIS_EMAIL_HTML_OUT) (await import("node:fs")).writeFileSync(process.env.MIS_EMAIL_HTML_OUT, e.html);
  });
  it("uses the admin's subject template", () => {
    const e = m.buildPersonEmail(person as never, { subject: "MIS {date} — {first}", intro: "Dear {name}", footer: null }, null, "2026-10-06");
    expect(e.subject).toBe("MIS Tue 6 Oct — Mamta");
    expect(e.html).toContain("Dear Mamta Sharma");
  });
  it("builds the HR summary", () => {
    const hr = m.buildHrSummary([person as never], "2026-10-06", null);
    expect(hr.subject).toBe("MIS summary — Tue 6 Oct — 1 new red circle");
    expect(hr.html).toContain("Mamta Sharma");
  });
});
