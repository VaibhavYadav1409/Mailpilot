import { describe, expect, it } from "vitest";
import { checkMisWorkbook, parseMisDate, readDateRow, sheetsWorthReading } from "../src/services/misSheet";

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
      [3, "Weekly Checking", "", "", "", "", "done", "", ...(today ? [""] : [])],
      [4, "MIS Approved By Yogesh Ji", "", "ok", "ok", "ok", "ok", "ok", ...(today ? [""] : [])],
      ...extra,
    ],
  });

  it("COMPLETE when every regularly-filled particular has today's entry", () => {
    const r = checkMisWorkbook([sheet(["Nil", "N.A"])], { date: TODAY });
    expect(r.status).toBe("COMPLETE");
    expect(r.layout).toBe("DAY_COLUMNS");
    expect(r.filledCount).toBe(2);
    // Section heading, weekly row and manager's approval row are not demanded.
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

  it("20+ blanks among the usually-filled particulars counts as not submitted", () => {
    const days2 = ["2026-09-26", "2026-09-28"];
    const head = ["#", "Particulars", ...days2.map((d) => d.split("-").reverse().join(".")), "29.09.2026"];
    const rows = Array.from({ length: 25 }, (_, i) => [i + 1, `Task ${i + 1}`, "done", "done", i < 4 ? "done" : ""]);
    const r = checkMisWorkbook([{ name: "S", values: [head, ...rows] }], { date: TODAY });
    expect(r.status).toBe("MISSING");
    expect(r.note).toMatch(/21 of 25/);
    const few = rows.map((row, i) => (i < 6 ? [...row.slice(0, 4), ""] : [...row.slice(0, 4), "done"]));
    expect(checkMisWorkbook([{ name: "S", values: [head, ...few] }], { date: TODAY }).status).toBe("INCOMPLETE");
  });

  it("rows that are usually left empty don't count towards the 20", () => {
    const days2 = ["2026-09-26", "2026-09-28"];
    const head = ["#", "Particulars", ...days2.map((d) => d.split("-").reverse().join(".")), "29.09.2026"];
    // 30 rows that are never filled + 3 rows that always are.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => [i + 1, `Rarely used ${i + 1}`, "", "", ""]),
      [31, "Daily A", "x", "x", "x"],
      [32, "Daily B", "x", "x", "x"],
      [33, "Daily C", "x", "x", ""],
    ];
    const r = checkMisWorkbook([{ name: "S", values: [head, ...rows] }], { date: TODAY });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toEqual(["33 Daily C"]);
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
