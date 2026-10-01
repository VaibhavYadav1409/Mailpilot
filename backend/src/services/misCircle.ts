/**
 * MIS Circle Report — the monthly sheet the company already keeps by hand:
 * staff down the side, the days of the month across the top, one code per
 * cell. A RED CIRCLE (CM) means the MIS for that day was not submitted.
 *
 *   Every 3 red circles in a calendar month = 1 day's salary deducted.
 *   They don't need to be consecutive. The count starts again each month.
 *
 * Cells fill themselves from the MIS check (CM / NC / IN, Sundays, 2nd and 4th
 * Saturdays). An admin can override any cell (leave, absent, on duty, …);
 * a manual mark always wins and is never overwritten by the check.
 */
import { prisma } from "../lib/db";
import { emitToCompany } from "../sockets";
import { buildXlsx, colName, type XlsxCell, type XlsxStyle } from "../lib/xlsx";
import { getMisStatusForDate, misFocusDates, type MisSourceStatus } from "./misService";
import { addDays, dateColumnValue } from "./msiService";

/** How many red circles cost one day's salary. */
export const CIRCLES_PER_DEDUCTION = 3;

export type CircleTone = "red" | "green" | "amber" | "grey" | "blue" | "purple";

export interface CircleCode {
  code: string;
  label: string;
  meaning: string;
  /** Counts towards salary deduction. */
  isCircle: boolean;
  tone: CircleTone;
  /** An admin can set this by hand. */
  manual: boolean;
}

/** Every code that can appear in a cell — the legend of the sheet. */
export const CIRCLE_CODES: CircleCode[] = [
  { code: "CM", label: "Circle marked", meaning: "MIS not submitted for the day (red circle). Counts towards salary deduction.", isCircle: true, tone: "red", manual: true },
  { code: "NC", label: "No circle", meaning: "MIS submitted — every usual entry filled.", isCircle: false, tone: "green", manual: true },
  { code: "IN", label: "Incomplete", meaning: "MIS filled but a few usual entries (fewer than 20) were blank. Shown as a warning; not a red circle.", isCircle: false, tone: "amber", manual: true },
  { code: "OL", label: "On leave", meaning: "On approved leave — no MIS expected, no circle.", isCircle: false, tone: "blue", manual: true },
  { code: "A", label: "Absent", meaning: "Absent — handled by attendance, not counted as an MIS circle.", isCircle: false, tone: "purple", manual: true },
  { code: "ON", label: "On duty", meaning: "On official duty outside — no MIS expected, no circle.", isCircle: false, tone: "blue", manual: true },
  { code: "SO", label: "Saturday off", meaning: "Saturday off for this person — no circle.", isCircle: false, tone: "grey", manual: true },
  { code: "SSO", label: "Second Saturday off", meaning: "Second Saturday of the month — off for everyone, no circle.", isCircle: false, tone: "grey", manual: true },
  { code: "FSO", label: "Fourth Saturday off", meaning: "Fourth Saturday of the month — off for everyone, no circle.", isCircle: false, tone: "grey", manual: true },
  { code: "SU", label: "Sunday", meaning: "Sunday — off, no circle.", isCircle: false, tone: "grey", manual: false },
  { code: "H", label: "Holiday", meaning: "Company holiday — no circle.", isCircle: false, tone: "grey", manual: true },
];
const BY_CODE = new Map(CIRCLE_CODES.map((c) => [c.code, c]));
export const MANUAL_CODES = CIRCLE_CODES.filter((c) => c.manual).map((c) => c.code);

export const isCircleCode = (code: string | null | undefined) => !!code && BY_CODE.get(code)?.isCircle === true;

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SAT"];

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 2 for the second Saturday of its month, etc. */
export function saturdayNumber(date: string): number {
  return Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1;
}

/** The code the calendar alone gives a day (Sunday, 2nd/4th Saturday), or null for a working day. */
export function calendarCode(date: string): string | null {
  const d = weekday(date);
  if (d === 0) return "SU";
  if (d === 6) {
    const n = saturdayNumber(date);
    if (n === 2) return "SSO";
    if (n === 4) return "FSO";
  }
  return null;
}

/** "2026-10" -> every date of that month. */
export function monthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Code a day's MIS result turns into. Null = nothing to mark (not read yet / couldn't read). */
export function autoCodeFor(status: MisSourceStatus | null | undefined, date: string): string | null {
  switch (status) {
    case "COMPLETE":
      return "NC";
    case "INCOMPLETE":
      return "IN";
    case "MISSING":
      // Not filled on a day that's off anyway is not a circle.
      return calendarCode(date) ?? "CM";
    case "OFF":
      return calendarCode(date) ?? "SU";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Deduction maths
// ---------------------------------------------------------------------------

export interface CircleSummary {
  circles: number;
  /** Red circles on yesterday, which can still be fixed today. */
  pendingCircles: number;
  deductionDays: number;
  /** Red circles still allowed before the next day is deducted. */
  untilNextDeduction: number;
  message: string;
}

export function summarize(finalCircles: number, pendingCircles = 0): CircleSummary {
  const deductionDays = Math.floor(finalCircles / CIRCLES_PER_DEDUCTION);
  const untilNext = CIRCLES_PER_DEDUCTION - (finalCircles % CIRCLES_PER_DEDUCTION);
  const day = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  let message: string;
  if (finalCircles === 0) message = "No red circles this month.";
  else if (deductionDays === 0)
    message = `${finalCircles} red circle${finalCircles === 1 ? "" : "s"} — ${untilNext} more = 1 day's salary deducted.`;
  else
    message = `${finalCircles} red circles = ${day(deductionDays)}' salary deducted. ${untilNext} more = ${day(deductionDays + 1)}.`;
  if (pendingCircles > 0) {
    const after = Math.floor((finalCircles + pendingCircles) / CIRCLES_PER_DEDUCTION);
    message += ` Yesterday's MIS is still missing — if it isn't filled today it becomes a red circle${after > deductionDays ? ` and ${day(after)} will be deducted` : ""}.`;
  }
  return { circles: finalCircles, pendingCircles, deductionDays, untilNextDeduction: untilNext, message };
}

// ---------------------------------------------------------------------------
// Recording marks from the MIS check
// ---------------------------------------------------------------------------

/**
 * Writes the AUTO mark for every person with an MIS for each date. Manual
 * marks are never touched (only their remembered autoCode is refreshed).
 */
export async function recordAutoMarks(companyId: string, dates: string[]): Promise<void> {
  for (const date of dates) {
    const byEmployee = await getMisStatusForDate(companyId, date);
    for (const [employeeId, day] of byEmployee) {
      const code = autoCodeFor(day.status, date);
      if (!code) continue;
      const where = { employeeId_date: { employeeId, date: dateColumnValue(date) } };
      const existing = await prisma.misCircleMark.findUnique({ where });
      if (existing?.source === "MANUAL") {
        if (existing.autoCode !== code) await prisma.misCircleMark.update({ where, data: { autoCode: code } });
        continue;
      }
      if (existing?.code === code) continue;
      await prisma.misCircleMark.upsert({
        where,
        create: { companyId, employeeId, date: dateColumnValue(date), code, autoCode: code, source: "AUTO" },
        update: { code, autoCode: code, source: "AUTO" },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The month sheet
// ---------------------------------------------------------------------------

export class CircleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface CircleCell {
  code: string | null;
  source: "AUTO" | "MANUAL" | "CALENDAR" | null;
  note: string | null;
  /** Yesterday: can still change today. */
  pending: boolean;
  /** What the MIS check said, when an admin overrode it. */
  autoCode: string | null;
}

export interface CircleRow {
  employeeId: string;
  name: string;
  username: string;
  hasMis: boolean;
  cells: Record<string, CircleCell>;
  summary: CircleSummary;
}

export interface CircleMonth {
  month: string;
  title: string;
  today: string;
  yesterday: string;
  days: { date: string; day: number; dow: string; isOff: boolean }[];
  rows: CircleRow[];
  codes: CircleCode[];
  rules: string[];
  totals: { people: number; circles: number; deductionDays: number; peopleWithDeduction: number };
}

export function circleRules(): string[] {
  return [
    `A red circle (CM) means the MIS for that day was not submitted: no column for the day, nothing filled, or 20 or more of the person's usual entries left blank.`,
    `Every ${CIRCLES_PER_DEDUCTION} red circles in a calendar month = 1 day's salary deducted. They do not need to be on consecutive days. ${CIRCLES_PER_DEDUCTION * 2} circles = 2 days, ${CIRCLES_PER_DEDUCTION * 3} = 3 days, and so on.`,
    `The count starts again from zero on the 1st of every month.`,
    `Staff get one day to fill their MIS: a day is checked the next day and becomes final the day after. Yesterday's red circle is shown as "pending" and can still turn green if the MIS is filled today.`,
    `Sundays, the 2nd and 4th Saturday, leave (OL), on duty (ON), Saturday off (SO), holidays (H) and absent (A) never count as red circles.`,
    `Incomplete (IN, amber) = filled with a few blanks — shown as a warning, not a red circle.`,
    `An admin can change any cell (e.g. mark leave). A changed cell shows who changed it and is never overwritten by the automatic check.`,
  ];
}

function monthTitle(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).toUpperCase();
}

export function validMonth(month: string | undefined, now = new Date()): string {
  const m = month ?? misFocusDates(now).yesterday.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new CircleError(400, "Invalid month — use YYYY-MM.");
  return m;
}

/**
 * The whole month for a company (or one person): who is on the sheet, every
 * cell, and each person's circles and salary deduction.
 */
export async function getCircleMonth(
  companyId: string,
  monthParam?: string,
  opts: { employeeId?: string; now?: Date } = {},
): Promise<CircleMonth> {
  const now = opts.now ?? new Date();
  const month = validMonth(monthParam, now);
  const { today, yesterday } = misFocusDates(now);
  const dates = monthDates(month);
  const first = dateColumnValue(dates[0]);
  const last = dateColumnValue(dates[dates.length - 1]);

  // People on the sheet: MIS staff (username logins), anyone with an MIS file
  // linked, and anyone who already has a mark this month.
  const [employees, marks] = await Promise.all([
    prisma.employee.findMany({
      where: {
        companyId,
        ...(opts.employeeId ? { id: opts.employeeId } : {}),
        OR: [
          { NOT: { email: { contains: "@" } }, status: { not: "SUSPENDED" } },
          { misSources: { some: {} } },
          { misCircleMarks: { some: { date: { gte: first, lte: last } } } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, email: true, _count: { select: { misSources: true } } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.misCircleMark.findMany({
      where: { companyId, date: { gte: first, lte: last }, ...(opts.employeeId ? { employeeId: opts.employeeId } : {}) },
    }),
  ]);

  const markOf = new Map(marks.map((m) => [`${m.employeeId}|${m.date.toISOString().slice(0, 10)}`, m]));

  // Days that ended before marks were being saved: derive from the stored MIS
  // checks (kept 7 days) so the sheet isn't empty on day one.
  const derived = new Map<string, string>();
  for (const date of dates) {
    if (date >= today || date < addDays(today, -7)) continue;
    const missing = employees.some((e) => e._count.misSources > 0 && !markOf.has(`${e.id}|${date}`));
    if (!missing) continue;
    const byEmp = await getMisStatusForDate(companyId, date, opts.employeeId);
    for (const [empId, day] of byEmp) {
      const code = autoCodeFor(day.status, date);
      if (code) derived.set(`${empId}|${date}`, code);
    }
  }

  const rows: CircleRow[] = employees.map((e) => {
    const cells: Record<string, CircleCell> = {};
    let finalCircles = 0;
    let pendingCircles = 0;
    for (const date of dates) {
      const k = `${e.id}|${date}`;
      const m = markOf.get(k);
      let cell: CircleCell;
      if (m) {
        cell = { code: m.code, source: m.source as "AUTO" | "MANUAL", note: m.note, pending: false, autoCode: m.source === "MANUAL" ? m.autoCode : null };
      } else if (derived.has(k)) {
        cell = { code: derived.get(k)!, source: "AUTO", note: null, pending: false, autoCode: null };
      } else if (date < today && calendarCode(date)) {
        cell = { code: calendarCode(date), source: "CALENDAR", note: null, pending: false, autoCode: null };
      } else if (date >= today && calendarCode(date)) {
        cell = { code: calendarCode(date), source: "CALENDAR", note: null, pending: false, autoCode: null };
      } else {
        cell = { code: null, source: null, note: null, pending: false, autoCode: null };
      }
      // Yesterday's automatic result can still change today.
      cell.pending = date === yesterday && cell.source === "AUTO";
      if (isCircleCode(cell.code)) {
        if (cell.pending) pendingCircles++;
        else finalCircles++;
      }
      cells[date] = cell;
    }
    return {
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`.trim(),
      username: e.email.toUpperCase(),
      hasMis: e._count.misSources > 0,
      cells,
      summary: summarize(finalCircles, pendingCircles),
    };
  });

  return {
    month,
    title: `MIS CIRCLE REPORT — ${monthTitle(month)}`,
    today,
    yesterday,
    days: dates.map((d) => ({ date: d, day: Number(d.slice(8, 10)), dow: DOW[weekday(d)], isOff: !!calendarCode(d) })),
    rows,
    codes: CIRCLE_CODES,
    rules: circleRules(),
    totals: {
      people: rows.length,
      circles: rows.reduce((n, r) => n + r.summary.circles, 0),
      deductionDays: rows.reduce((n, r) => n + r.summary.deductionDays, 0),
      peopleWithDeduction: rows.filter((r) => r.summary.deductionDays > 0).length,
    },
  };
}

/** Admin override for one cell; `code: null` puts the automatic value back. */
export async function setCircleMark(
  companyId: string,
  actorId: string,
  input: { employeeId: string; date: string; code: string | null; note?: string | null },
  now = new Date(),
) {
  const { today } = misFocusDates(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CircleError(400, "Invalid date.");
  if (input.date > today) throw new CircleError(400, "You can't mark a future day yet.");
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, companyId }, select: { id: true } });
  if (!emp) throw new CircleError(404, "Person not found.");
  const where = { employeeId_date: { employeeId: emp.id, date: dateColumnValue(input.date) } };
  const existing = await prisma.misCircleMark.findUnique({ where });
  const note = input.note?.trim() ? input.note.trim().slice(0, 300) : null;

  if (input.code === null) {
    if (existing?.source === "MANUAL") {
      if (existing.autoCode) {
        await prisma.misCircleMark.update({ where, data: { code: existing.autoCode, source: "AUTO", note: null, updatedById: actorId } });
      } else {
        await prisma.misCircleMark.delete({ where });
      }
    }
  } else {
    if (!MANUAL_CODES.includes(input.code)) throw new CircleError(400, "Unknown code.");
    const autoCode = existing ? (existing.source === "AUTO" ? existing.code : existing.autoCode) : null;
    await prisma.misCircleMark.upsert({
      where,
      create: { companyId, employeeId: emp.id, date: dateColumnValue(input.date), code: input.code, source: "MANUAL", autoCode, note, updatedById: actorId },
      update: { code: input.code, source: "MANUAL", autoCode, note, updatedById: actorId },
    });
  }
  await prisma.auditLog
    .create({
      data: {
        companyId,
        employeeId: actorId,
        action: "MIS_CIRCLE_MARKED",
        metadata: { targetEmployeeId: emp.id, date: input.date, code: input.code, previous: existing?.code ?? null },
      },
    })
    .catch(() => undefined);
  emitToCompany(companyId, "msi:updated", { source: "mis-circle", date: input.date });
}

// ---------------------------------------------------------------------------
// Excel download — same layout as the sheet kept by hand
// ---------------------------------------------------------------------------

const TONE_FILL: Record<CircleTone, string> = {
  red: "F8CBAD",
  green: "C6EFCE",
  amber: "FFEB9C",
  grey: "E7E6E6",
  blue: "BDD7EE",
  purple: "E4DFEC",
};
const TONE_FONT: Record<CircleTone, string> = {
  red: "9C0006",
  green: "006100",
  amber: "7F6000",
  grey: "595959",
  blue: "1F4E78",
  purple: "5B2C6F",
};

export function circleWorkbook(data: CircleMonth): Buffer {
  const styles: XlsxStyle[] = [];
  const style = (s: XlsxStyle) => {
    const key = JSON.stringify(s);
    const i = styles.findIndex((x) => JSON.stringify(x) === key);
    if (i >= 0) return i;
    styles.push(s);
    return styles.length - 1;
  };
  const title = style({ bold: true, size: 14, align: "left" });
  const sub = style({ size: 9, color: "595959", align: "left" });
  const head = style({ bold: true, fill: "D9E1F2", align: "center", border: true, wrap: true });
  const headOff = style({ bold: true, fill: "E7E6E6", align: "center", border: true });
  const nameCell = style({ border: true, align: "left" });
  const plain = style({ border: true, align: "center" });
  const toneCell = (t: CircleTone, bold = false) => style({ fill: TONE_FILL[t], color: TONE_FONT[t], bold, border: true, align: "center" });
  const pendingCell = style({ fill: "FCE4D6", color: "C00000", border: true, align: "center" });
  const bad = style({ bold: true, color: "C00000", border: true, align: "center" });
  const good = style({ color: "006100", border: true, align: "center" });
  const wrap = style({ border: true, wrap: true, size: 9, align: "left" });
  const legendHead = style({ bold: true, size: 11 });
  const legendText = style({ size: 9, wrap: true, align: "left" });

  const n = data.days.length;
  const lastCol = 2 + n + 3; // Sl, Name, days…, Circles, Deduction, Remarks
  const rows: (XlsxCell | string | number | null)[][] = [];
  rows.push([{ v: data.title, s: title }]);
  rows.push([{ v: `Generated by MailPilot · ${data.rows.length} staff · Every ${CIRCLES_PER_DEDUCTION} red circles (CM) in the month = 1 day's salary deducted`, s: sub }]);
  rows.push([
    { v: null, s: head },
    { v: null, s: head },
    ...data.days.map((d) => ({ v: d.dow, s: d.isOff ? headOff : head })),
    { v: null, s: head },
    { v: null, s: head },
    { v: null, s: head },
  ]);
  rows.push([
    { v: "Sl. No", s: head },
    { v: "Staff Name", s: head },
    ...data.days.map((d) => ({ v: d.day, s: d.isOff ? headOff : head })),
    { v: "Red circles", s: head },
    { v: "Salary deduction (days)", s: head },
    { v: "Remarks", s: head },
  ]);
  data.rows.forEach((r, i) => {
    rows.push([
      { v: i + 1, s: plain },
      { v: r.name, s: nameCell },
      ...data.days.map((d) => {
        const c = r.cells[d.date];
        if (!c?.code) return { v: null, s: plain };
        const def = BY_CODE.get(c.code);
        if (c.pending && isCircleCode(c.code)) return { v: `${c.code}?`, s: pendingCell };
        return { v: c.code, s: def ? toneCell(def.tone, def.isCircle) : plain };
      }),
      { v: r.summary.circles, s: r.summary.circles ? bad : good },
      { v: r.summary.deductionDays, s: r.summary.deductionDays ? bad : good },
      { v: r.hasMis ? r.summary.message : "No MIS file linked in MailPilot — mark this row by hand.", s: wrap },
    ]);
  });
  rows.push([]);
  rows.push([{ v: "CODES", s: legendHead }]);
  for (const c of CIRCLE_CODES) rows.push([{ v: c.code, s: toneCell(c.tone, c.isCircle) }, { v: `${c.label} — ${c.meaning}`, s: legendText }]);
  rows.push([{ v: "CM?", s: pendingCell }, { v: "Pending — yesterday's MIS is missing but can still be filled today.", s: legendText }]);
  rows.push([]);
  rows.push([{ v: "RULES", s: legendHead }]);
  data.rules.forEach((rule, i) => rows.push([{ v: i + 1, s: plain }, { v: rule, s: legendText }]));

  const firstLegendRow = 4 + data.rows.length + 3;
  const merges = [`A1:${colName(lastCol)}1`, `A2:${colName(lastCol)}2`];
  for (let r = firstLegendRow; r < rows.length + 1; r++) {
    if (rows[r - 1]?.length === 2) merges.push(`B${r}:${colName(lastCol)}${r}`);
  }

  return buildXlsx({
    name: `${data.month}`,
    rows,
    styles,
    merges,
    colWidths: [6, 26, ...Array(n).fill(5.2), 10, 12, 60],
    freeze: { row: 5, col: 3 },
    rowHeights: { 1: 22, 4: 30 },
  });
}
