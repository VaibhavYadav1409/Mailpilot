import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", () => ({ prisma: {} }));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));

const c = await import("../src/services/misCircle");

describe("calendar", () => {
  it("knows Sundays and the 2nd Saturday", () => {
    expect(c.calendarCode("2026-10-04")).toBe("SU"); // Sunday
    expect(c.calendarCode("2026-10-03")).toBeNull(); // 1st Saturday is a working day
    expect(c.calendarCode("2026-10-10")).toBe("SSO");
    expect(c.calendarCode("2026-10-17")).toBeNull(); // 3rd Saturday
    expect(c.calendarCode("2026-10-24")).toBeNull(); // 4th Saturday works
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

const cell = (code: string | null, extra: Partial<import("../src/services/misCircle").CircleCell> = {}) => ({
  code,
  source: "AUTO" as const,
  note: null,
  pending: false,
  autoCode: null,
  reason: code === "CM" ? "Not filled for the day — 24 of 30 usual entries are blank." : null,
  markedBy: "MIS check (automatic)",
  evidence: null as import("../src/services/misEvidence").CircleEvidence | null,
  ...extra,
});

/** A person with red circles on the given October dates. */
function personWith(circleDates: string[], pending?: string) {
  const cells: Record<string, ReturnType<typeof cell>> = {};
  for (const d of c.monthDates("2026-10")) cells[d] = c.calendarCode(d) ? cell(c.calendarCode(d), { source: "CALENDAR" as never }) : cell("NC");
  for (const d of circleDates) cells[d] = cell("CM");
  if (pending) cells[pending] = cell("CM", { pending: true });
  return cells;
}

describe("red circle details — which circle cost which day", () => {
  const dates = c.monthDates("2026-10");
  it("numbers circles in date order and marks every 3rd as a deduction", () => {
    const cells = personWith(["2026-10-01", "2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14", "2026-10-21", "2026-10-22"]);
    const e = c.redCircleEntries({ cells }, dates);
    expect(e.map((x) => x.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(e.filter((x) => x.triggersDeduction).map((x) => x.date)).toEqual(["2026-10-07", "2026-10-21"]);
    expect(e[2].effect).toBe("3rd red circle → 1st day's salary deducted.");
    expect(e[5].effect).toBe("6th red circle → 2nd day's salary deducted.");
    expect(e[0].effect).toBe("1st red circle — 2 more = 1st day's salary deducted.");
    expect(e[6].effect).toBe("7th red circle — 2 more = 3rd day's salary deducted.");
    expect(e[0].reason).toMatch(/24 of 30/);
    expect(c.deductionTriggers(e)).toBe("Day 1: 3rd circle on 07-10-2026 · Day 2: 6th circle on 21-10-2026");
  });
  it("keeps a pending circle out of the count and says what would happen", () => {
    const cells = personWith(["2026-10-05", "2026-10-06"], "2026-10-07");
    const e = c.redCircleEntries({ cells }, dates);
    expect(e.map((x) => x.number)).toEqual([1, 2, null]);
    expect(e[2].effect).toMatch(/becomes the 3rd red circle and the 1st day's salary is deducted/);
  });
  it.each([
    [0, "0 red circles → 0 days."],
    [2, "2 red circles ÷ 3 = 0 days — a deduction starts only at the 3rd red circle."],
    [3, "3 red circles ÷ 3 = 1 day."],
    [6, "6 red circles ÷ 3 = 2 days."],
    [7, "7 red circles ÷ 3 = 2 days (1 circle left over, counting towards the next day)."],
  ])("writes the sum out for %i circles", (n, text) => {
    expect(c.deductionCalculation(n)).toBe(text);
  });
  it("uses correct ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(c.ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  });
});

describe("reasons", () => {
  const src = (over: object) => ({ id: "s", label: "", fileName: "MAMTA MIS.xlsx", webUrl: "", checkedBy: null, approvedBy: null, status: "COMPLETE", rowCount: 30, missingColumns: [], blanks: [], note: null, checkedAt: null, ...over });
  it("explains a not-submitted day from the check note", () => {
    const r = c.reasonFromDay({ sources: [src({ status: "MISSING", note: "Not filled for 05-10-2026 — 24 of 30 usual entries are blank." })] } as never, "2026-10-05");
    expect(r).toBe("Not filled for 05-10-2026 — 24 of 30 usual entries are blank");
  });
  it("lists blank cells for an incomplete day", () => {
    const r = c.reasonFromDay({ sources: [src({ status: "INCOMPLETE", blanks: [{ sheet: "S", cell: "AA23", field: "Calls made" }] })] } as never, "2026-10-05");
    expect(r).toBe("Filled, but 1 usual entry left blank: Calls made (AA23)");
  });
  it("names each file when a person has two", () => {
    const r = c.reasonFromDay({ sources: [src({ label: "Sales" }), src({ label: "Ops", status: "MISSING", note: null })] } as never, "2026-10-05");
    expect(r).toBe("Sales: submitted — every usual entry filled (30 filled) | Ops: not filled for 05-10-2026");
  });
  it("says when an admin removed a circle", () => {
    const r = c.manualReason("OL", "Sick leave approved", "CM", "Not filled for 05-10-2026 — 24 of 30 usual entries are blank.");
    expect(r).toBe(
      'Set by admin to OL (On leave): "Sick leave approved" The MIS check had said CM (Circle marked) — Not filled for 05-10-2026 — 24 of 30 usual entries are blank. So this day is NOT counted as a red circle.',
    );
  });
  it("knows when a month is final", () => {
    expect(c.monthStatus("2026-09-30", "2026-09-01", "2026-10-01", "2026-10-02").final).toBe(true);
    expect(c.monthStatus("2026-09-30", "2026-09-01", "2026-09-30", "2026-10-01").final).toBe(false);
    expect(c.monthStatus("2026-10-31", "2026-10-01", "2026-10-01", "2026-10-02").text).toMatch(/in progress/);
  });
});

describe("circleWorkbook", () => {
  it("builds a valid xlsx with the six tabs, every reason and the evidence", async () => {
    const dates = c.monthDates("2026-10");
    const ev = await import("../src/services/misEvidence");
    const w = await import("../src/services/workCalendar");
    const anjali = personWith(["2026-10-01", "2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14", "2026-10-21"], "2026-10-23");
    anjali["2026-10-07"].evidence = ev.buildEvidence(
      [
        { sourceId: "s", sourceLabel: "ANJALI MIS", at: new Date("2026-10-08T05:00:00Z"), status: "MISSING", filledCount: 2, blankCount: 27, fileModifiedAt: new Date("2026-10-07T12:00:00Z"), fileModifiedBy: "Anjali Jha", note: "Not filled for 07-10-2026 — 27 of 29 usual entries are blank." },
        { sourceId: "s", sourceLabel: "ANJALI MIS", at: new Date("2026-10-09T05:00:00Z"), status: "COMPLETE", filledCount: 29, blankCount: 0, fileModifiedAt: new Date("2026-10-09T04:00:00Z"), fileModifiedBy: "Anjali Jha", note: null },
      ],
      ev.deadlineFor("2026-10-07", w.DEFAULT_CALENDAR, "Asia/Kolkata"),
      "Asia/Kolkata",
      new Date("2026-10-25T05:00:00Z"),
    );
    const data = {
      month: "2026-10",
      title: "MIS CIRCLE REPORT — OCTOBER 2026",
      today: "2026-10-25",
      yesterday: "2026-10-24",
      days: dates.map((d) => ({ date: d, day: Number(d.slice(8)), dow: "MO", isOff: !!c.calendarCode(d), offName: w.offDay(d)?.name ?? null })),
      rows: [
        {
          employeeId: "e1",
          name: "Anjali Jha",
          username: "ANJALI",
          hasMis: true,
          cells: anjali,
          summary: c.summarize(6, 1),
        },
        { employeeId: "e2", name: "Mamta", username: "MAMTA", hasMis: true, cells: personWith(["2026-10-06", "2026-10-08"]), summary: c.summarize(2) },
      ],
      codes: c.CIRCLE_CODES,
      rules: c.circleRules(),
      totals: { people: 2, circles: 8, deductionDays: 2, peopleWithDeduction: 1 },
      status: c.monthStatus("2026-10-31", "2026-10-01", "2026-10-24", "2026-10-25"),
    };
    const buf = c.circleWorkbook(data, { generatedAt: new Date("2026-10-25T05:00:00Z") });
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    for (let i = 1; i <= 6; i++) expect(buf.includes(Buffer.from(`xl/worksheets/sheet${i}.xml`))).toBe(true);
    for (const t of [
      "Salary Deduction",
      "Circle Sheet",
      "Red Circles",
      "Evidence Log",
      "Day by Day",
      "Rules &amp; Codes",
      "Anjali Jha",
      "6th red circle → 2nd day",
      "24 of 30 usual entries",
      "2 red circles ÷ 3 = 0 days",
      "08-10-2026 11:59 PM", // deadline for 7 Oct = end of Thu 8 Oct
      "07-10-2026 05:30 PM", // Excel saved before the deadline
      "09-10-2026 09:30 AM", // filled late
      "Mahatma Gandhi Jayanti",
    ])
      expect(buf.includes(Buffer.from(t)), t).toBe(true);
    if (process.env.CIRCLE_XLSX_OUT) (await import("node:fs")).writeFileSync(process.env.CIRCLE_XLSX_OUT, buf);
  });
});
