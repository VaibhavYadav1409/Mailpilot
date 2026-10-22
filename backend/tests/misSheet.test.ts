import { describe, expect, it } from "vitest";
import { checkMisWorkbook, distinctive, parseMisDate, readDateRow, sheetsWorthReading } from "../src/services/misSheet";

const TODAY = "2026-09-29";
/** Excel serial for a date — what Graph returns for a real date cell. */
const serial = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;

describe("parseMisDate", () => {
  it.each([
    ["29/09/2026", TODAY],
    ["29-09-26", TODAY],
    ["29.09.2026", TODAY],
    ["29.9.26", TODAY],
    ["29-Sep-2026", TODAY],
    ["29 Sept 26", TODAY],
    ["Sep 29, 2026", TODAY],
    ["2026-09-29", TODAY],
    ["13/08/2026 - leave ", "2026-08-13"],
    ["31/02/2026", null],
    ["Total", null],
    ["", null],
  ])("%s -> %s", (input, want) => {
    expect(parseMisDate(input)).toBe(want);
  });
  it("reads Excel serials", () => {
    expect(parseMisDate(serial(TODAY))).toBe(TODAY);
  });
});

describe("readDateRow", () => {
  it("un-swaps dates Excel stored month-first (01/09 saved as 9 Jan)", () => {
    // Typed 01/09/2026, 02/09/2026 on a US-locale PC -> stored as 9 Jan, 9 Feb; then typed text.
    const row = ["Particulars", serial("2026-01-09"), serial("2026-02-09"), "14/9/2026"];
    expect(readDateRow(row, 1).map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-14"]);
  });
  it("uses the previous date as the reference", () => {
    const row = ["x", "31-08-2026", serial("2026-01-09")];
    expect(readDateRow(row, 1).map((d) => d.date)).toEqual(["2026-08-31", "2026-09-01"]);
  });
  it("keeps real dates that are not ambiguous", () => {
    const row = ["x", serial("2026-09-14"), serial("2026-09-15")];
    expect(readDateRow(row, 1).map((d) => d.date)).toEqual(["2026-09-14", "2026-09-15"]);
  });
});

describe("checkMisWorkbook — dates across the top (Farsight MIS layout)", () => {
  // Days are columns; particulars run down the side. "A DP Account" is a section heading.
  const days = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28"];
  const header = ["SL. NO.", "Particulars", ...days.map((d) => d.split("-").reverse().join("."))];
  const sheet = (today: unknown[] | null, extra: unknown[][] = []) => ({
    name: "Sep-2026",
    values: [
      ["DAILY MIS - DP Activities"],
      today ? [...header, TODAY.split("-").reverse().join(".")] : header,
      ["A", "DP Account"],
      [1, "Accounts received", "Nil", 2, "Nil", 1, "Nil", 3, ...(today ? [today[0]] : [])],
      [2, "Accounts activated", "N.A", 2, "N.A", 1, "N.A", 3, ...(today ? [today[1]] : [])],
      [3, "Weekly Checking", "", "", "", "", "", "", ...(today ? [""] : [])],
      [4, "MIS Approved By Yogesh Ji", "", "ok", "ok", "ok", "ok", "ok", ...(today ? [""] : [])],
      ...extra,
    ],
  });

  it("COMPLETE when every regularly-filled particular has today's entry", () => {
    const r = checkMisWorkbook([sheet(["Nil", "N.A"])], { date: TODAY });
    expect(r.status).toBe("COMPLETE");
    expect(r.layout).toBe("DAY_COLUMNS");
    expect(r.filledCount).toBe(2);
    // Section heading, a label row nobody ever fills and the manager's approval row are not boxes.
    expect(r.fields.filter((f) => f.required).map((f) => f.name)).toEqual(["1 Accounts received", "2 Accounts activated"]);
  });

  it("INCOMPLETE names the blank particulars and their cells", () => {
    const r = checkMisWorkbook([sheet(["Nil", ""])], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toEqual(["2 Accounts activated"]);
    expect(r.blanks).toEqual([{ sheet: "Sep-2026", cell: "I5", field: "2 Accounts activated" }]);
  });

  it("a date column added but not filled counts as not submitted", () => {
    const r = checkMisWorkbook([sheet(["", ""])], { date: TODAY });
    expect(r.status).toBe("MISSING");
    expect(r.filledCount).toBe(0);
    expect(r.blanks).toEqual([]);
  });

  // Six earlier working days, then 29 Sep.
  const days6 = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];
  const head6 = ["#", "Particulars", ...days6.map((d) => d.split("-").reverse().join(".")), "29.09.2026"];
  /** n boxes that are always filled; today the first `filledToday` are filled. */
  const boxes = (n: number, filledToday: number) =>
    Array.from({ length: n }, (_, i) => [i + 1, `Task ${i + 1}`, ...days6.map(() => "done"), i < filledToday ? "done" : ""]);

  it("80% rule: 40 of 50 boxes is submitted, 39 of 50 is incomplete", () => {
    const ok = checkMisWorkbook([{ name: "S", values: [head6, ...boxes(50, 40)] }], { date: TODAY });
    expect(ok.status).toBe("COMPLETE");
    expect(ok.note).toBe("40 of 50 boxes filled (80%).");
    expect(ok.blanks).toHaveLength(10); // still listed, so they can be filled
    const short = checkMisWorkbook([{ name: "S", values: [head6, ...boxes(50, 39)] }], { date: TODAY });
    expect(short.status).toBe("INCOMPLETE");
    expect(short.note).toBe("Incomplete — 39 of 50 boxes filled (78%); at least 80% (40 of 50) is needed.");
    expect(short.blankCount).toBe(11);
  });

  it("a few filled boxes is incomplete, nothing filled is not filled", () => {
    expect(checkMisWorkbook([{ name: "S", values: [head6, ...boxes(25, 4)] }], { date: TODAY }).note).toMatch(/^Incomplete — 4 of 25 boxes filled \(16%\)/);
    const none = checkMisWorkbook([{ name: "S", values: [head6, ...boxes(25, 0)] }], { date: TODAY });
    expect(none.status).toBe("MISSING");
    expect(none.note).toBe("Not filled for 29-09-2026 — all 25 boxes are blank.");
  });

  it("no scaling down: a box filled even once in the last 40 working days counts every day", () => {
    // 10 boxes filled daily + 40 the person skips most days (filled once, on 21 Sep).
    const rows = [
      ...boxes(10, 10),
      ...Array.from({ length: 40 }, (_, i) => [i + 11, `Skipped ${i + 1}`, "x", "", "", "", "", "", ""]),
    ];
    const r = checkMisWorkbook([{ name: "S", values: [head6, ...rows] }], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.note).toMatch(/^Incomplete — 10 of 50 boxes filled \(20%\)/);
  });

  it("labels nobody has filled in 40 working days are not boxes", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => [i + 1, `Group label ${i + 1}`, "", "", "", "", "", "", ""]),
      ...boxes(3, 2).map((r, i) => [31 + i, `Daily ${i + 1}`, ...r.slice(2)]),
    ];
    const r = checkMisWorkbook([{ name: "S", values: [head6, ...rows] }], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toEqual(["33 Daily 3"]);
    expect(r.note).toMatch(/2 of 3 boxes/);
  });

  it("a new sheet with little history: every row except headings is a box", () => {
    const head2 = ["#", "Particulars", "26.09.2026", "28.09.2026", "29.09.2026"];
    const rows = [[1, "Rarely used", "", "", ""], [2, "Daily", "x", "x", "x"]];
    const r = checkMisWorkbook([{ name: "S", values: [head2, ...rows] }], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.note).toMatch(/1 of 2 boxes/);
  });

  it("a section heading filled with NIL answers for the rows under it", () => {
    const rows = [
      ["M", "Overseas Account", ...days6.map(() => "NIL"), "NIL"],
      [1, "Received", "x", ...days6.slice(1).map(() => ""), ""], // a box (filled once), blank today but covered by NIL
      [2, "Opened", ...days6.map(() => ""), ""],
      ["N", "Daily work", ...days6.map(() => ""), ""],
      ...boxes(4, 4).map((r, i) => [i + 1, `Work ${i + 1}`, ...r.slice(2)]),
    ];
    const r = checkMisWorkbook([{ name: "S", values: [head6, ...rows] }], { date: TODAY });
    expect(r.status).toBe("COMPLETE");
    expect(r.note).toBe("6 of 6 boxes filled (100%).");
    // The same heading with real text (not NIL) does not cover anything.
    const text = rows.map((row, i) => (i === 0 ? [...row.slice(0, -1), "see below"] : row));
    expect(checkMisWorkbook([{ name: "S", values: [head6, ...text] }], { date: TODAY }).missingFields).toEqual(["1 Received"]);
  });

  it("MISSING when today's column doesn't exist yet", () => {
    const r = checkMisWorkbook([sheet(null)], { date: TODAY });
    expect(r.status).toBe("MISSING");
    expect(r.note).toMatch(/29-09-2026/);
  });

  it("an admin-pinned list overrides what was learned", () => {
    const r = checkMisWorkbook([sheet(["Nil", "N.A"])], { date: TODAY, requiredColumns: ["Weekly Checking", "Accounts received"] });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toEqual(["3 Weekly Checking"]);
  });

  it("finds the day on the right sheet when several months share a workbook", () => {
    const aug = { name: "Aug-2026", values: [["x", "Particulars", "28.08.2026", "31.08.2026"], [1, "Accounts received", "Nil", "Nil"]] };
    const r = checkMisWorkbook([aug, sheet(["Nil", "N.A"])], { date: TODAY });
    expect(r.sheet).toBe("Sep-2026");
    expect(r.status).toBe("COMPLETE");
  });
});

describe("checkMisWorkbook — one row per entry with a Date column", () => {
  const header = ["S.No", "Date", "Client Name", "Scheme", "Amount", "Remarks"];
  const sheet = (rows: unknown[][]) => ({ name: "Log", values: [header, ...rows] });

  it("COMPLETE when today's rows are fully filled (S.No / Remarks optional)", () => {
    const r = checkMisWorkbook([sheet([[1, serial("2026-09-28"), "A", "X", 1, ""], [2, serial(TODAY), "B", "Y", 2, ""]])], { date: TODAY });
    expect(r.status).toBe("COMPLETE");
    expect(r.layout).toBe("DAY_ROWS");
  });

  it("INCOMPLETE lists blank columns with cell references", () => {
    const r = checkMisWorkbook([sheet([[1, "29/09/2026", "B", "", 5, ""]])], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.blanks).toEqual([{ sheet: "Log", cell: "D2", field: "Scheme" }]);
  });

  it("MISSING when nothing is dated today", () => {
    expect(checkMisWorkbook([sheet([[1, "28/09/2026", "A", "X", 1, ""]])], { date: TODAY }).status).toBe("MISSING");
  });
});

describe("sheetsWorthReading", () => {
  it("skips month sheets far from the day being checked", () => {
    const probe = (name: string, a: string, b: string) => ({ name, values: [["x", "Particulars", a, b]] });
    const picked = sheetsWorthReading(
      [probe("Sep", "01.09.2026", "28.09.2026"), probe("Aug", "01.08.2026", "31.08.2026"), probe("Jan", "01.01.2026", "30.01.2026")],
      [TODAY],
    );
    expect(picked).toEqual(["Sep", "Aug"]);
  });
});

describe("checkMisWorkbook — off days don't count when learning usual entries", () => {
  // Fri 11, (Sat 12 = 2nd Saturday, Sun 13, Mon 14 = Ganesh Chaturthi), Tue 15; checking Wed 16 Sep 2026.
  const days = ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];
  const sheet = {
    name: "Sep-2026",
    values: [
      ["Particulars", ...days.map((d) => d.split("-").reverse().join("."))],
      ["Calls made", 5, "", "", "", 7, ""],
      ["Accounts opened", 1, 1, "", 1, 2, 3],
    ],
  };
  const off = new Set(["2026-09-12", "2026-09-13", "2026-09-14"]);
  it("a row filled on working days is a box even if holidays are blank", () => {
    const r = checkMisWorkbook([sheet], { date: "2026-09-16", isOffDay: (d) => off.has(d) });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toEqual(["Calls made"]);
  });
  it("every box counts with or without the calendar", () => {
    const r = checkMisWorkbook([sheet], { date: "2026-09-16" });
    expect(r.status).toBe("INCOMPLETE");
  });
});

describe("copied days (an exact copy of an earlier day's column)", () => {
  // Working days 1–15 Sep 2026 (no Sundays, no 2nd Saturday 12 Sep).
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15"];
  const off = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0 || d === "2026-09-12";
  const statuses = ["not due", "Reconciled", "done entry", "submitted", "NA", "Nil"];
  /** Column i: three figures that change daily + six statuses that never change. */
  const col = (i: number) => [100 + i * 7, 2000 + i * 13, `updated till ${String(i + 1).padStart(2, "0")}-09-2026`, ...statuses];
  const build = (cols: unknown[][]) => ({
    name: "Sep-2026",
    values: [
      ["Particulars", ...days.slice(0, cols.length).map((d) => d.split("-").reverse().join("."))],
      ...["Accounts opened", "Amount collected", "Bank register", "TDS", "Bank reco", "Rent", "Report", "Other", "Misc"].map((label, r) => [label, ...cols.map((c) => c[r])]),
      ["MIS Approved By Yogesh Ji", ...cols.map(() => "ok")],
    ],
  });
  const genuine = days.map((_, i) => col(i));
  const last = days[days.length - 1];

  it("flags a day pasted from the previous working day", () => {
    const cols = [...genuine.slice(0, -1), genuine[genuine.length - 2]];
    const r = checkMisWorkbook([build(cols)], { date: last, isOffDay: off });
    expect(r.status).toBe("MISSING");
    expect(r.copiedFrom).toBe("2026-09-14");
    expect(r.note).toMatch(/^Copied from 14-09-2026 — all 9 entries are exactly the same as on 14-09-2026, including 3 that change every day/);
  });
  it("does not flag a genuinely filled day whose statuses repeat", () => {
    const r = checkMisWorkbook([build(genuine)], { date: last, isOffDay: off });
    expect(r.status).toBe("COMPLETE");
    expect(r.copiedFrom ?? null).toBeNull();
  });
  it("does not flag when only some daily figures are the same", () => {
    const cols = [...genuine.slice(0, -1), [genuine[10][0], genuine[10][1], "updated till 15-09-2026", ...statuses]];
    expect(checkMisWorkbook([build(cols)], { date: last, isOffDay: off }).copiedFrom ?? null).toBeNull();
  });
  it("does not flag repeated leave days", () => {
    const leave = ["leave", "leave", "leave", "leave", "leave", "leave", "leave", "leave", "leave"];
    const cols = [...genuine.slice(0, -2), leave, leave];
    expect(checkMisWorkbook([build(cols)], { date: last, isOffDay: off }).copiedFrom ?? null).toBeNull();
  });
  it("can be switched off", () => {
    const cols = [...genuine.slice(0, -1), genuine[genuine.length - 2]];
    expect(checkMisWorkbook([build(cols)], { date: last, isOffDay: off, detectCopies: false }).status).toBe("COMPLETE");
  });
  it("only distinctive values count as daily-changing", () => {
    expect(distinctive("Nil")).toBeNull();
    expect(distinctive("not due")).toBeNull();
    expect(distinctive("On Leave")).toBeNull();
    expect(distinctive(5)).toBeNull();
    expect(distinctive("12,000")).toBe("12000");
    expect(distinctive("updated till 14-09-2026")).toBe("updated till 14-09-2026");
  });
});
