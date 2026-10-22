import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));
process.env.MAIL_DAY_TIMEZONE ??= "Asia/Kolkata";

const w = await import("../src/services/misWeekly");
const { DEFAULT_CALENDAR } = await import("../src/services/workCalendar");
const IST = "Asia/Kolkata";
const at = (s: string) => new Date(`${s}+05:30`);

describe("weekly reporters", () => {
  it("weeks run Monday–Saturday; the deadline is Saturday night", () => {
    expect(w.weekStartOf("2026-10-22")).toBe("2026-10-19"); // Thu -> Mon
    expect(w.weekStartOf("2026-10-25")).toBe("2026-10-19"); // Sun -> same week
    expect(w.weekStartOf("2026-10-19")).toBe("2026-10-19");
    expect(w.weekDeadline("2026-10-19", IST).toISOString()).toBe(at("2026-10-25T00:00:00").toISOString()); // end of Sat 24 Oct
  });
  it("uploaded by Saturday night: every working day of the week is green", () => {
    const m = w.weekMarks("2026-10-19", { submittedAt: at("2026-10-24T21:15:00"), fileName: "week.pdf" }, DEFAULT_CALENDAR, "2026-10-19", at("2026-10-26T10:00:00"), IST)!;
    // 20 Oct is Dussehra (market holiday) — not a working day.
    expect(m.map((x) => [x.date, x.code])).toEqual([
      ["2026-10-19", "NC"],
      ["2026-10-21", "NC"],
      ["2026-10-22", "NC"],
      ["2026-10-23", "NC"],
      ["2026-10-24", "NC"],
    ]);
    expect(m[0].reason).toMatch(/^Weekly report uploaded 24-10-2026 09:15 PM \(week\.pdf\) — counts for the whole week Mon 19 Oct – Sat 24 Oct\.$/);
  });
  it("counts as soon as it is uploaded, even mid-week (later days included)", () => {
    const m = w.weekMarks("2026-10-19", { submittedAt: at("2026-10-21T10:00:00"), fileName: "w.pdf" }, DEFAULT_CALENDAR, "2026-10-19", at("2026-10-21T10:05:00"), IST)!;
    expect(m.every((x) => x.code === "NC")).toBe(true);
    expect(m).toHaveLength(5);
  });
  it("still open and nothing uploaded: no marks yet", () => {
    expect(w.weekMarks("2026-10-19", null, DEFAULT_CALENDAR, "2026-10-19", at("2026-10-24T23:59:00"), IST)).toBeNull();
  });
  it("missed: ONE red circle on the last working day, the rest WK", () => {
    const m = w.weekMarks("2026-10-19", null, DEFAULT_CALENDAR, "2026-10-19", at("2026-10-25T00:00:01"), IST)!;
    expect(m.filter((x) => x.code === "CM").map((x) => x.date)).toEqual(["2026-10-24"]);
    expect(m.filter((x) => x.code === "WK")).toHaveLength(4);
    expect(m.find((x) => x.code === "CM")!.reason).toBe("Weekly report for Mon 19 Oct – Sat 24 Oct was not uploaded by Saturday night (Sat 24 Oct, 11:59 PM).");
  });
  it("uploaded after Saturday night is late: still the red circle, with the time it came", () => {
    const m = w.weekMarks("2026-10-19", { submittedAt: at("2026-10-25T09:00:00"), fileName: "w.pdf" }, DEFAULT_CALENDAR, "2026-10-19", at("2026-10-25T09:01:00"), IST)!;
    expect(m.find((x) => x.code === "CM")!.reason).toMatch(/uploaded late, on 25-10-2026 09:00 AM/);
  });
  it("2nd-Saturday week: the red circle falls on Friday; days before the start date are ignored", () => {
    const m = w.weekMarks("2026-11-09", null, DEFAULT_CALENDAR, "2026-11-11", at("2026-11-16T09:00:00"), IST)!;
    // 10 Nov is a holiday, 14 Nov is the 2nd Saturday, 9 Nov is before the start date.
    expect(m.map((x) => [x.date, x.code])).toEqual([
      ["2026-11-11", "WK"],
      ["2026-11-12", "WK"],
      ["2026-11-13", "CM"],
    ]);
  });
});
