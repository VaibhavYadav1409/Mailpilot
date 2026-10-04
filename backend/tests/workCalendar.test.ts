import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));
process.env.MAIL_DAY_TIMEZONE ??= "Asia/Kolkata";

const w = await import("../src/services/workCalendar");
const ev = await import("../src/services/misEvidence");
const mis = await import("../src/services/misService");
const circle = await import("../src/services/misCircle");

describe("working calendar", () => {
  it("knows Sundays, 2nd Saturdays and NSE holidays", () => {
    expect(w.offDay("2026-10-04")?.code).toBe("SU");
    expect(w.offDay("2026-10-10")?.code).toBe("SSO");
    expect(w.offDay("2026-10-24")).toBeNull(); // 4th Saturday works
    expect(w.offDay("2026-10-03")).toBeNull(); // 1st Saturday works
    expect(w.offDay("2026-10-17")).toBeNull(); // 3rd Saturday works
    expect(w.offDay("2026-10-02")).toEqual({ code: "H", name: "Mahatma Gandhi Jayanti" });
    expect(w.offDay("2026-10-20")?.name).toBe("Dussehra");
    expect(w.offDay("2026-08-15")?.code).toBe("H"); // Independence Day on a 3rd Saturday
    expect(w.offDay("2026-11-08")?.code).toBe("SU"); // Sunday wins
  });
  it("skips off days when looking back", () => {
    expect(w.previousWorkingDay("2026-10-05")).toBe("2026-10-03");
    expect(w.lastWorkingDays("2026-10-05", 2)).toEqual(["2026-10-03", "2026-10-01"]); // 2 Oct is a holiday
    expect(w.lastWorkingDays("2026-10-12", 2)).toEqual(["2026-10-09", "2026-10-08"]); // after a 2nd-Saturday weekend
    expect(w.lastWorkingDays("2026-10-21", 2)).toEqual(["2026-10-19", "2026-10-17"]); // Dussehra on the 20th
    expect(w.nextWorkingDay("2026-10-09")).toBe("2026-10-12");
  });
  it("applies company overrides", () => {
    const cal = w.buildCalendar([
      { date: "2026-10-02", name: "", isOff: false },
      { date: "2026-10-21", name: "Office Diwali puja", isOff: true },
    ]);
    expect(w.offDay("2026-10-02", cal)).toBeNull();
    expect(w.offDay("2026-10-21", cal)?.name).toBe("Office Diwali puja");
  });
  it("names the two MIS days", () => {
    expect(w.focusLabels("2026-10-07", "2026-10-06", "2026-10-05")).toEqual({ last: "Yesterday", previous: "Day before yesterday" });
    expect(w.focusLabels("2026-10-06", "2026-10-05", "2026-10-03")).toEqual({ last: "Yesterday", previous: "Previous working day" });
    expect(w.focusLabels("2026-10-05", "2026-10-03", "2026-10-01")).toEqual({ last: "Last working day", previous: "Previous working day" });
  });
  it("focuses the MIS pages on working days", () => {
    const f = mis.misFocusDates(new Date("2026-10-05T06:00:00Z"));
    expect([f.today, f.yesterday, f.dayBefore]).toEqual(["2026-10-05", "2026-10-03", "2026-10-01"]);
  });
  it("never gives a red circle on an off day", () => {
    expect(circle.autoCodeFor("MISSING", "2026-10-02")).toBe("H");
    expect(circle.autoCodeFor("MISSING", "2026-10-10")).toBe("SSO");
    expect(circle.autoCodeFor("MISSING", "2026-10-05")).toBe("CM");
  });
});

describe("evidence", () => {
  const cal = w.DEFAULT_CALENDAR;
  const base = { sourceId: "s1", sourceLabel: "MIS", blankCount: 0, note: null, fileModifiedBy: "Mamta Sharma" };
  it("deadline = end of the next working day (IST)", () => {
    const d = ev.deadlineFor("2026-10-01", cal, "Asia/Kolkata"); // next working day: Sat 3 Oct
    expect(d.day).toBe("2026-10-03");
    expect(d.at.toISOString()).toBe("2026-10-03T18:30:00.000Z");
  });
  it("records not filled at the deadline, then filled late", () => {
    const d = ev.deadlineFor("2026-10-05", cal, "Asia/Kolkata"); // until end of Tue 6 Oct
    const e = ev.buildEvidence(
      [
        { ...base, at: new Date("2026-10-06T05:00:00Z"), status: "MISSING", filledCount: 0, blankCount: 30, fileModifiedAt: new Date("2026-10-05T12:00:00Z"), note: "Not filled for 05-10-2026 — 30 of 30 usual entries are blank." },
        { ...base, at: new Date("2026-10-07T05:00:00Z"), status: "COMPLETE", filledCount: 30, fileModifiedAt: new Date("2026-10-07T04:40:00Z") },
      ],
      d,
      "Asia/Kolkata",
      new Date("2026-10-07T06:00:00Z"),
    );
    expect(e.atDeadline?.status).toBe("MISSING");
    expect(e.atDeadline?.savedBy).toBe("Mamta Sharma");
    expect(e.filledLateAt).toBe("2026-10-07T04:40:00.000Z");
    expect(e.timeline.map((t) => t.afterDeadline)).toEqual([false, true]);
    expect(e.lines.join(" ")).toMatch(/Filled late: 07-10-2026 10:10 AM/);
    expect(ev.reasonAtDeadline(e.atDeadline!)).toBe("Not filled for 05-10-2026 — 30 of 30 usual entries are blank — still the case at the deadline.");
  });
  it("counts a file saved before the deadline as on time even if read later", () => {
    const d = ev.deadlineFor("2026-10-05", cal, "Asia/Kolkata");
    const e = ev.buildEvidence(
      [{ ...base, at: new Date("2026-10-07T03:00:00Z"), status: "COMPLETE", filledCount: 28, fileModifiedAt: new Date("2026-10-06T15:00:00Z") }],
      d,
      "Asia/Kolkata",
    );
    expect(e.atDeadline?.status).toBe("COMPLETE");
    expect(e.completedAt).toBe("2026-10-06T15:00:00.000Z");
    expect(e.filledLateAt).toBeNull();
  });
  it("says so when nothing was read before the deadline", () => {
    const d = ev.deadlineFor("2026-10-05", cal, "Asia/Kolkata");
    const e = ev.buildEvidence(
      [{ ...base, at: new Date("2026-10-08T03:00:00Z"), status: "COMPLETE", filledCount: 28, fileModifiedAt: new Date("2026-10-08T02:00:00Z") }],
      d,
      "Asia/Kolkata",
      new Date("2026-10-08T04:00:00Z"),
    );
    expect(e.atDeadline).toBeNull();
    expect(e.lines.join(" ")).toMatch(/did not read the file before the deadline/);
  });
  it("formats times in IST", () => {
    expect(ev.fmtWhen("2026-10-05T12:32:00Z", "Asia/Kolkata")).toBe("05-10-2026 06:02 PM");
  });
});
