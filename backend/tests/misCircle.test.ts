import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const c = await import("../src/services/misCircle");

describe("calendar", () => {
  it("knows Sundays and the 2nd / 4th Saturday", () => {
    expect(c.calendarCode("2026-10-04")).toBe("SU"); // Sunday
    expect(c.calendarCode("2026-10-03")).toBeNull(); // 1st Saturday is a working day
    expect(c.calendarCode("2026-10-10")).toBe("SSO");
    expect(c.calendarCode("2026-10-17")).toBeNull(); // 3rd Saturday
    expect(c.calendarCode("2026-10-24")).toBe("FSO");
    expect(c.calendarCode("2026-10-05")).toBeNull(); // Monday
  });
  it("lists every day of the month", () => {
    expect(c.monthDates("2026-10")).toHaveLength(31);
    expect(c.monthDates("2026-02")).toHaveLength(28);
  });
});

describe("autoCodeFor", () => {
  it("turns MIS results into sheet codes", () => {
    expect(c.autoCodeFor("COMPLETE", "2026-10-05")).toBe("NC");
    expect(c.autoCodeFor("INCOMPLETE", "2026-10-05")).toBe("IN");
    expect(c.autoCodeFor("MISSING", "2026-10-05")).toBe("CM");
    expect(c.autoCodeFor("MISSING", "2026-10-10")).toBe("SSO"); // not filled on a day off = no circle
    expect(c.autoCodeFor("ERROR", "2026-10-05")).toBeNull(); // never a circle for our own read failure
  });
});

describe("summarize — every 3 red circles = 1 day's salary", () => {
  it.each([
    [0, 0, 3],
    [1, 0, 2],
    [2, 0, 1],
    [3, 1, 3],
    [5, 1, 1],
    [6, 2, 3],
    [7, 2, 2],
  ])("%i circles → %i day(s) deducted, %i more until the next", (circles, days, next) => {
    const s = c.summarize(circles);
    expect(s.deductionDays).toBe(days);
    expect(s.untilNextDeduction).toBe(next);
  });
  it("explains a pending circle that would trigger a deduction", () => {
    expect(c.summarize(2, 1).message).toMatch(/1 day will be deducted/);
  });
});

describe("circleWorkbook", () => {
  it("builds a valid xlsx (zip) with the sheet", () => {
    const data = {
      month: "2026-10",
      title: "MIS CIRCLE REPORT — OCTOBER 2026",
      today: "2026-10-02",
      yesterday: "2026-10-01",
      days: c.monthDates("2026-10").map((d) => ({ date: d, day: Number(d.slice(8)), dow: "MO", isOff: false })),
      rows: [
        {
          employeeId: "e1",
          name: "Anjali Jha",
          username: "ANJALI",
          hasMis: true,
          cells: { "2026-10-01": { code: "CM", source: "AUTO" as const, note: null, pending: true, autoCode: null } },
          summary: c.summarize(0, 1),
        },
      ],
      codes: c.CIRCLE_CODES,
      rules: c.circleRules(),
      totals: { people: 1, circles: 0, deductionDays: 0, peopleWithDeduction: 0 },
    };
    const buf = c.circleWorkbook(data);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.includes(Buffer.from("xl/worksheets/sheet1.xml"))).toBe(true);
    expect(buf.includes(Buffer.from("Anjali Jha"))).toBe(true);
  });
});
