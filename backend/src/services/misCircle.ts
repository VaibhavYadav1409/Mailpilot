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
import { buildWorkbook, colName, type XlsxCell, type XlsxStyle } from "../lib/xlsx";
import { getMisStatusForDate, misFocusDates, type MisEmployeeDay, type MisSourceStatus } from "./misService";
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

/** "2026-10-05" -> "05-10-2026" */
export function dmy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
}

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/**
 * Plain-English reason behind a day's MIS result, e.g.
 * "Not filled for 05-10-2026 — 24 of 30 usual entries are blank."
 * Stored with the mark, because the MIS checks themselves are only kept 7 days.
 */
export function reasonFromDay(day: Pick<MisEmployeeDay, "sources">, date: string): string {
  const multi = day.sources.length > 1;
  const parts = day.sources.map((s) => {
    let text: string;
    switch (s.status) {
      case "COMPLETE":
        text = `submitted — every usual entry filled (${s.rowCount} filled)`;
        break;
      case "INCOMPLETE": {
        const b = s.blanks ?? [];
        const list = b.slice(0, 6).map((x) => `${x.field} (${x.cell})`).join(", ");
        text = `filled, but ${b.length || "some"} usual entr${b.length === 1 ? "y" : "ies"} left blank${list ? `: ${list}` : ""}${b.length > 6 ? `, +${b.length - 6} more` : ""}`;
        break;
      }
      case "MISSING":
        text = s.note ? s.note.replace(/\.$/, "") : `not filled for ${dmy(date)}`;
        break;
      case "OFF":
        text = "Sunday — nothing filled (day off)";
        break;
      case "ERROR":
        text = `the file couldn't be read${s.note ? `: ${s.note.replace(/\.$/, "")}` : ""}`;
        break;
      default:
        text = "not checked yet";
    }
    return multi ? `${s.label || s.fileName || "MIS file"}: ${text}` : cap(text);
  });
  return parts.join(" | ").slice(0, 1000);
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
      const reason = reasonFromDay(day, date);
      const where = { employeeId_date: { employeeId, date: dateColumnValue(date) } };
      const existing = await prisma.misCircleMark.findUnique({ where });
      if (existing?.source === "MANUAL") {
        if (existing.autoCode !== code || existing.reason !== reason) await prisma.misCircleMark.update({ where, data: { autoCode: code, reason } });
        continue;
      }
      if (existing?.code === code && existing.reason === reason) continue;
      await prisma.misCircleMark.upsert({
        where,
        create: { companyId, employeeId, date: dateColumnValue(date), code, autoCode: code, source: "AUTO", reason },
        update: { code, autoCode: code, source: "AUTO", reason },
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
  /** Why the cell has this code, in plain words. */
  reason: string | null;
  /** "MIS check (automatic)", the admin's name, or "Calendar". */
  markedBy: string | null;
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
  /** Whether the month's figures can still change. */
  status: { final: boolean; text: string };
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

  // Names of admins who changed cells by hand.
  const updaterIds = [...new Set(marks.filter((m) => m.source === "MANUAL" && m.updatedById).map((m) => m.updatedById!))];
  const updaters = updaterIds.length
    ? await prisma.employee.findMany({ where: { id: { in: updaterIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const updaterName = new Map(updaters.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  // Days that ended before marks were being saved: derive from the stored MIS
  // checks (kept 7 days) so the sheet isn't empty on day one.
  const derived = new Map<string, { code: string; reason: string }>();
  for (const date of dates) {
    if (date >= today || date < addDays(today, -7)) continue;
    const missing = employees.some((e) => e._count.misSources > 0 && !markOf.has(`${e.id}|${date}`));
    if (!missing) continue;
    const byEmp = await getMisStatusForDate(companyId, date, opts.employeeId);
    for (const [empId, day] of byEmp) {
      const code = autoCodeFor(day.status, date);
      if (code) derived.set(`${empId}|${date}`, { code, reason: reasonFromDay(day, date) });
    }
  }

  const AUTO_BY = "MIS check (automatic)";
  const rows: CircleRow[] = employees.map((e) => {
    const cells: Record<string, CircleCell> = {};
    let finalCircles = 0;
    let pendingCircles = 0;
    for (const date of dates) {
      const k = `${e.id}|${date}`;
      const m = markOf.get(k);
      let cell: CircleCell;
      if (m) {
        const manual = m.source === "MANUAL";
        cell = {
          code: m.code,
          source: manual ? "MANUAL" : "AUTO",
          note: m.note,
          pending: false,
          autoCode: manual ? m.autoCode : null,
          reason: manual ? manualReason(m.code, m.note, m.autoCode, m.reason) : m.reason ?? genericReason(m.code),
          markedBy: manual ? (m.updatedById && updaterName.get(m.updatedById)) || "Admin" : AUTO_BY,
        };
      } else if (derived.has(k)) {
        const d = derived.get(k)!;
        cell = { code: d.code, source: "AUTO", note: null, pending: false, autoCode: null, reason: d.reason, markedBy: AUTO_BY };
      } else if (calendarCode(date)) {
        const c = calendarCode(date)!;
        cell = { code: c, source: "CALENDAR", note: null, pending: false, autoCode: null, reason: BY_CODE.get(c)?.meaning ?? null, markedBy: "Calendar" };
      } else {
        cell = { code: null, source: null, note: null, pending: false, autoCode: null, reason: null, markedBy: null };
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
    status: monthStatus(dates[dates.length - 1], dates[0], yesterday, today),
  };
}

/** Whether a month's figures are final yet. */
export function monthStatus(lastDate: string, firstDate: string, yesterday: string, today: string): { final: boolean; text: string } {
  if (firstDate >= today) return { final: false, text: `This month hasn't started yet.` };
  if (lastDate < yesterday) return { final: true, text: `Month closed — these are the final figures.` };
  if (lastDate === yesterday)
    return { final: false, text: `Month ended yesterday — the last day's MIS can still be filled today. Figures are final from tomorrow.` };
  return {
    final: false,
    text: `Month in progress — figures up to ${dmy(yesterday)} (that day is still pending). Download again after the month ends for the final sheet.`,
  };
}

const codeLabel = (c: string | null | undefined) => (c ? `${c} (${BY_CODE.get(c)?.label ?? c})` : "");

/** Why an AUTO mark has its code, for marks saved before reasons were stored. */
function genericReason(code: string): string {
  switch (code) {
    case "CM":
      return "The MIS check found the day's MIS not submitted.";
    case "NC":
      return "The MIS check found the day's MIS submitted.";
    case "IN":
      return "The MIS check found the day's MIS filled with a few usual entries blank.";
    default:
      return BY_CODE.get(code)?.meaning ?? code;
  }
}

/** Why a hand-set cell has its code, including what the MIS check had said. */
export function manualReason(code: string, note: string | null, autoCode: string | null, autoReason: string | null): string {
  let t = `Set by admin to ${codeLabel(code)}${note ? `: "${note}"` : "."}`;
  if (autoCode && autoCode !== code) {
    t += ` The MIS check had said ${codeLabel(autoCode)}${autoReason ? ` — ${autoReason.replace(/\.$/, "")}` : ""}.`;
    if (isCircleCode(autoCode) && !isCircleCode(code)) t += " So this day is NOT counted as a red circle.";
    if (!isCircleCode(autoCode) && isCircleCode(code)) t += " Counted as a red circle because of the admin's mark.";
  }
  return t;
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
// Per-person explanation — which circle cost which day
// ---------------------------------------------------------------------------

export function ordinal(n: number): string {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suf}`;
}

export interface RedCircleEntry {
  date: string;
  /** 1st, 2nd, … red circle of the month (null while pending). */
  number: number | null;
  pending: boolean;
  /** Whether this circle caused a day's salary to be deducted. */
  triggersDeduction: boolean;
  effect: string;
  reason: string;
  markedBy: string;
  note: string | null;
}

/** Every red circle of a person's month, in date order, with what each one did. */
export function redCircleEntries(row: Pick<CircleRow, "cells">, dates: string[]): RedCircleEntry[] {
  const out: RedCircleEntry[] = [];
  let n = 0;
  for (const date of dates) {
    const c = row.cells[date];
    if (!c || !isCircleCode(c.code)) continue;
    const base = { date, reason: c.reason ?? genericReason("CM"), markedBy: c.markedBy ?? "", note: c.note };
    if (c.pending) {
      const k = n + 1;
      out.push({
        ...base,
        number: null,
        pending: true,
        triggersDeduction: false,
        effect:
          k % CIRCLES_PER_DEDUCTION === 0
            ? `Pending — if not filled today it becomes the ${ordinal(k)} red circle and the ${ordinal(k / CIRCLES_PER_DEDUCTION)} day's salary is deducted.`
            : `Pending — if not filled today it becomes the ${ordinal(k)} red circle.`,
      });
      continue;
    }
    n++;
    const triggers = n % CIRCLES_PER_DEDUCTION === 0;
    const left = CIRCLES_PER_DEDUCTION - (n % CIRCLES_PER_DEDUCTION);
    out.push({
      ...base,
      number: n,
      pending: false,
      triggersDeduction: triggers,
      effect: triggers
        ? `${ordinal(n)} red circle → ${ordinal(n / CIRCLES_PER_DEDUCTION)} day's salary deducted.`
        : `${ordinal(n)} red circle — ${left} more = ${ordinal(Math.ceil(n / CIRCLES_PER_DEDUCTION))} day's salary deducted.`,
    });
  }
  return out;
}

/** The sum written out: "7 red circles ÷ 3 = 2 days (1 left over)". */
export function deductionCalculation(circles: number): string {
  const days = Math.floor(circles / CIRCLES_PER_DEDUCTION);
  const rest = circles % CIRCLES_PER_DEDUCTION;
  if (circles === 0) return "0 red circles → 0 days.";
  const head = `${circles} red circle${circles === 1 ? "" : "s"} ÷ ${CIRCLES_PER_DEDUCTION} = ${days} day${days === 1 ? "" : "s"}`;
  if (days === 0) return `${head} — a deduction starts only at the ${ordinal(CIRCLES_PER_DEDUCTION)} red circle.`;
  return `${head}${rest ? ` (${rest} circle${rest === 1 ? "" : "s"} left over, counting towards the next day)` : ""}.`;
}

/** "Day 1: 3rd circle on 07-10-2026 · Day 2: 6th circle on 21-10-2026" */
export function deductionTriggers(entries: RedCircleEntry[]): string {
  const t = entries.filter((e) => e.triggersDeduction);
  if (!t.length) return "—";
  return t.map((e, i) => `Day ${i + 1}: ${ordinal(e.number!)} circle on ${dmy(e.date)}`).join(" · ");
}

// ---------------------------------------------------------------------------
// Excel download — summary + the sheet kept by hand + every reason
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

type Row = (XlsxCell | string | number | null)[];

/** Worked examples shown on the Rules tab. */
export function deductionExamples(): { circles: number; days: number; why: string }[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 9, 10].map((c) => ({ circles: c, days: Math.floor(c / CIRCLES_PER_DEDUCTION), why: deductionCalculation(c) }));
}

/**
 * The downloadable workbook. Tabs:
 *  1. Salary Deduction — one line per person: circles, days deducted, the sum, which circle cost which day.
 *  2. Circle Sheet     — the familiar grid (days across, one code per cell).
 *  3. Red Circles      — one line per red circle: date, number, effect, WHY it is red, who marked it.
 *  4. Day by Day       — every day of every person with its code and reason.
 *  5. Rules & Codes    — rules, code meanings and worked examples.
 */
export function circleWorkbook(data: CircleMonth, opts: { generatedAt?: Date; person?: string } = {}): Buffer {
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
  const statusFinal = style({ bold: true, size: 10, color: "006100", align: "left" });
  const statusOpen = style({ bold: true, size: 10, color: "C55A11", align: "left" });
  const head = style({ bold: true, fill: "D9E1F2", align: "center", border: true, wrap: true });
  const headOff = style({ bold: true, fill: "E7E6E6", align: "center", border: true });
  const nameCell = style({ border: true, align: "left", bold: true });
  const text = style({ border: true, align: "left", wrap: true, size: 9 });
  const plain = style({ border: true, align: "center" });
  const toneCell = (t: CircleTone, bold = false) => style({ fill: TONE_FILL[t], color: TONE_FONT[t], bold, border: true, align: "center" });
  const pendingCell = style({ fill: "FCE4D6", color: "C00000", border: true, align: "center" });
  const bad = style({ bold: true, color: "C00000", border: true, align: "center" });
  const badBig = style({ bold: true, size: 12, color: "FFFFFF", fill: "C00000", border: true, align: "center" });
  const good = style({ color: "006100", border: true, align: "center" });
  const badText = style({ border: true, align: "left", wrap: true, size: 9, color: "9C0006", bold: true });
  const legendHead = style({ bold: true, size: 11 });
  const legendText = style({ size: 9, wrap: true, align: "left" });
  const totalLabel = style({ bold: true, fill: "F2F2F2", border: true, align: "right" });
  const totalNum = style({ bold: true, fill: "F2F2F2", border: true, align: "center" });

  const gen = opts.generatedAt ?? new Date();
  const genText = `Generated by MailPilot on ${gen.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} IST`;
  const ruleLine = `Rule: every ${CIRCLES_PER_DEDUCTION} red circles (CM) in the month = 1 day's salary deducted (not necessarily on consecutive days). The count starts again on the 1st.`;
  const statusRow: Row = [{ v: data.status.text, s: data.status.final ? statusFinal : statusOpen }];
  const workDates = data.days.map((d) => d.date);
  const entriesOf = new Map(data.rows.map((r) => [r.employeeId, redCircleEntries(r, workDates)]));
  const sheets: Parameters<typeof buildWorkbook>[0]["sheets"] = [];
  const titleMerges = (lastCol: number, n = 4) => Array.from({ length: n }, (_, i) => `A${i + 1}:${colName(lastCol)}${i + 1}`);

  // --- 1. Salary Deduction -------------------------------------------------
  {
    const headers = [
      "Sl. No",
      "Staff Name",
      "Login",
      "Red circles (final)",
      "Salary days deducted",
      "How it is calculated",
      "Which circle cost which day",
      "Red circle dates",
      "Pending (yesterday)",
      "Before the next deduction",
      "Submitted days (NC)",
      "Incomplete days (IN)",
      "Leave / absent / on duty / holiday",
      "Explanation",
    ];
    const rows: Row[] = [
      [{ v: `${data.title}${opts.person ? ` — ${opts.person}` : ""} — SALARY DEDUCTION SUMMARY`, s: title }],
      [{ v: ruleLine, s: sub }],
      statusRow,
      [{ v: `${genText}. Tabs: Salary Deduction · Circle Sheet · Red Circles (why each one is red) · Day by Day · Rules & Codes.`, s: sub }],
      headers.map((h) => ({ v: h, s: head })),
    ];
    data.rows.forEach((r, i) => {
      const entries = entriesOf.get(r.employeeId) ?? [];
      const final = entries.filter((e) => !e.pending);
      const counts: Record<string, number> = {};
      for (const d of workDates) {
        const c = r.cells[d]?.code;
        if (c) counts[c] = (counts[c] ?? 0) + 1;
      }
      const other = ["OL", "A", "ON", "SO", "H"].filter((c) => counts[c]).map((c) => `${c} ${counts[c]}`).join(", ");
      const s = r.summary;
      const left = s.untilNextDeduction;
      rows.push([
        { v: i + 1, s: plain },
        { v: r.name, s: nameCell },
        { v: r.username, s: plain },
        { v: s.circles, s: s.circles ? bad : good },
        { v: s.deductionDays, s: s.deductionDays ? badBig : good },
        { v: deductionCalculation(s.circles), s: s.deductionDays ? badText : text },
        { v: deductionTriggers(final), s: s.deductionDays ? badText : text },
        { v: final.map((e) => dmy(e.date)).join(", ") || "—", s: text },
        { v: s.pendingCircles ? `Yes — ${entries.filter((e) => e.pending).map((e) => dmy(e.date)).join(", ")}` : "No", s: s.pendingCircles ? bad : plain },
        { v: `${left} more red circle${left === 1 ? "" : "s"} = ${s.deductionDays + 1} day${s.deductionDays + 1 === 1 ? "" : "s"}`, s: text },
        { v: counts.NC ?? 0, s: plain },
        { v: counts.IN ?? 0, s: plain },
        { v: other || "—", s: plain },
        { v: r.hasMis ? s.message : `No MIS file linked in MailPilot — only hand-set marks are counted. ${s.message}`, s: text },
      ]);
    });
    const lastData = 5 + data.rows.length;
    rows.push([
      { v: null, s: totalLabel },
      { v: "TOTAL", s: totalLabel },
      { v: `${data.rows.length} staff`, s: totalNum },
      { v: data.totals.circles, s: totalNum },
      { v: data.totals.deductionDays, s: totalNum },
      { v: `${data.totals.peopleWithDeduction} of ${data.rows.length} staff have a salary deduction this month.`, s: totalLabel },
    ]);
    sheets.push({
      name: "Salary Deduction",
      rows,
      merges: [...titleMerges(headers.length), `F${lastData + 1}:${colName(headers.length)}${lastData + 1}`],
      colWidths: [6, 24, 14, 10, 11, 34, 34, 30, 14, 20, 10, 10, 16, 48],
      freeze: { row: 6, col: 3 },
      rowHeights: { 1: 22, 5: 32 },
      autoFilter: data.rows.length ? `A5:${colName(headers.length)}${lastData}` : undefined,
      tabColor: "C00000",
    });
  }

  // --- 2. Circle Sheet (the familiar grid) ---------------------------------
  {
    const n = data.days.length;
    const lastCol = 2 + n + 3;
    const rows: Row[] = [
      [{ v: data.title, s: title }],
      [{ v: `${ruleLine} The reason behind every red circle is on the "Red Circles" tab.`, s: sub }],
      statusRow,
      [
        { v: null, s: head },
        { v: null, s: head },
        ...data.days.map((d) => ({ v: d.dow, s: d.isOff ? headOff : head })),
        { v: null, s: head },
        { v: null, s: head },
        { v: null, s: head },
      ],
      [
        { v: "Sl. No", s: head },
        { v: "Staff Name", s: head },
        ...data.days.map((d) => ({ v: d.day, s: d.isOff ? headOff : head })),
        { v: "Red circles", s: head },
        { v: "Salary deduction (days)", s: head },
        { v: "Remarks", s: head },
      ],
    ];
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
        { v: r.hasMis ? r.summary.message : "No MIS file linked in MailPilot — mark this row by hand.", s: text },
      ]);
    });
    rows.push([]);
    rows.push([{ v: "CODES", s: legendHead }]);
    const legendStart = rows.length + 1;
    for (const c of CIRCLE_CODES) rows.push([{ v: c.code, s: toneCell(c.tone, c.isCircle) }, { v: `${c.label} — ${c.meaning}`, s: legendText }]);
    rows.push([{ v: "CM?", s: pendingCell }, { v: "Pending — yesterday's MIS is missing but can still be filled today.", s: legendText }]);
    const merges = titleMerges(lastCol, 3);
    for (let r = legendStart; r <= rows.length; r++) merges.push(`B${r}:${colName(lastCol)}${r}`);
    sheets.push({
      name: "Circle Sheet",
      rows,
      merges,
      colWidths: [6, 24, ...Array(n).fill(5.2), 10, 12, 60],
      freeze: { row: 6, col: 3 },
      rowHeights: { 1: 22, 5: 30 },
      tabColor: "2F5597",
    });
  }

  // --- 3. Red Circles — one line per circle, with the reason --------------
  {
    const headers = ["Sl. No", "Staff Name", "Date", "Day", "Circle no. this month", "What it does", "Why it is a red circle", "Marked by", "Admin note"];
    const rows: Row[] = [
      [{ v: `${data.title}${opts.person ? ` — ${opts.person}` : ""} — EVERY RED CIRCLE AND WHY`, s: title }],
      [{ v: ruleLine, s: sub }],
      statusRow,
      [{ v: "A day is a red circle when the MIS for it was not submitted: no column for the date, nothing filled, or 20 or more of the person's usual entries blank — or an admin marked it CM.", s: sub }],
      headers.map((h) => ({ v: h, s: head })),
    ];
    let k = 0;
    for (const r of data.rows) {
      for (const e of entriesOf.get(r.employeeId) ?? []) {
        k++;
        rows.push([
          { v: k, s: plain },
          { v: r.name, s: nameCell },
          { v: dmy(e.date), s: plain },
          { v: DOW_LONG[weekday(e.date)], s: plain },
          e.pending ? { v: "Pending", s: pendingCell } : { v: e.number, s: e.triggersDeduction ? badBig : bad },
          { v: e.effect, s: e.triggersDeduction ? badText : text },
          { v: e.reason, s: text },
          { v: e.markedBy, s: text },
          { v: e.note ?? "", s: text },
        ]);
      }
    }
    if (k === 0) rows.push([{ v: null, s: plain }, { v: "No red circles this month.", s: nameCell }]);
    sheets.push({
      name: "Red Circles",
      rows,
      merges: titleMerges(headers.length),
      colWidths: [6, 24, 12, 11, 11, 44, 60, 22, 30],
      freeze: { row: 6, col: 3 },
      rowHeights: { 1: 22, 5: 30 },
      autoFilter: k ? `A5:${colName(headers.length)}${5 + k}` : undefined,
      tabColor: "FF0000",
    });
  }

  // --- 4. Day by Day — every person, every day -----------------------------
  {
    const headers = ["Staff Name", "Date", "Day", "Code", "Meaning", "Red circle?", "Reason / details", "Marked by", "Admin note"];
    const rows: Row[] = [
      [{ v: `${data.title}${opts.person ? ` — ${opts.person}` : ""} — DAY BY DAY`, s: title }],
      [{ v: "Every day of the month for every person, with the code and the reason behind it. Use the filter buttons to look at one person or one code.", s: sub }],
      statusRow,
      headers.map((h) => ({ v: h, s: head })),
    ];
    let k = 0;
    for (const r of data.rows) {
      const numberOf = new Map((entriesOf.get(r.employeeId) ?? []).map((e) => [e.date, e]));
      for (const d of data.days) {
        const c = r.cells[d.date];
        if (d.date >= data.today && !c?.code) continue; // future days with nothing to show
        k++;
        const def = c?.code ? BY_CODE.get(c.code) : undefined;
        const circle = numberOf.get(d.date);
        rows.push([
          { v: r.name, s: nameCell },
          { v: dmy(d.date), s: plain },
          { v: DOW_LONG[weekday(d.date)], s: plain },
          c?.code
            ? c.pending && isCircleCode(c.code)
              ? { v: `${c.code}?`, s: pendingCell }
              : { v: c.code, s: def ? toneCell(def.tone, def.isCircle) : plain }
            : { v: "—", s: plain },
          { v: def ? def.label : d.date >= data.today ? "Not yet" : "Not marked", s: text },
          circle ? { v: circle.pending ? "Pending" : `Yes — ${ordinal(circle.number!)}`, s: circle.pending ? pendingCell : bad } : { v: "No", s: good },
          {
            v:
              c?.reason ??
              (d.date >= data.today
                ? "Not checked yet."
                : r.hasMis
                  ? "No result saved for this day (MailPilot wasn't checking yet, or the file couldn't be read)."
                  : "No MIS file linked — mark by hand if needed."),
            s: text,
          },
          { v: c?.markedBy ?? "", s: text },
          { v: c?.note ?? "", s: text },
        ]);
      }
    }
    sheets.push({
      name: "Day by Day",
      rows,
      merges: titleMerges(headers.length, 3),
      colWidths: [24, 12, 11, 7, 18, 12, 70, 22, 30],
      freeze: { row: 5, col: 2 },
      rowHeights: { 1: 22, 4: 24 },
      autoFilter: k ? `A4:${colName(headers.length)}${4 + k}` : undefined,
      tabColor: "548235",
    });
  }

  // --- 5. Rules & Codes ------------------------------------------------------
  {
    const rows: Row[] = [
      [{ v: "MIS CIRCLE REPORT — RULES, CODES AND EXAMPLES", s: title }],
      [{ v: genText, s: sub }],
      [],
      [{ v: "RULES", s: legendHead }],
    ];
    const merges: string[] = ["A1:D1", "A2:D2"];
    data.rules.forEach((rule, i) => {
      rows.push([{ v: i + 1, s: plain }, { v: rule, s: legendText }]);
      merges.push(`B${rows.length}:D${rows.length}`);
    });
    rows.push([]);
    rows.push([{ v: "HOW MANY DAYS ARE DEDUCTED", s: legendHead }]);
    rows.push([{ v: "Red circles", s: head }, { v: "Salary days deducted", s: head }, { v: "Why", s: head }]);
    merges.push(`C${rows.length}:D${rows.length}`);
    for (const ex of deductionExamples()) {
      rows.push([{ v: ex.circles, s: plain }, { v: ex.days, s: ex.days ? bad : good }, { v: ex.why, s: text }]);
      merges.push(`C${rows.length}:D${rows.length}`);
    }
    rows.push([]);
    rows.push([{ v: "CODES", s: legendHead }]);
    rows.push([{ v: "Code", s: head }, { v: "Name", s: head }, { v: "Red circle?", s: head }, { v: "Meaning", s: head }]);
    for (const c of CIRCLE_CODES) {
      rows.push([
        { v: c.code, s: toneCell(c.tone, c.isCircle) },
        { v: c.label, s: text },
        { v: c.isCircle ? "YES — counts" : "No", s: c.isCircle ? bad : good },
        { v: c.meaning, s: text },
      ]);
    }
    rows.push([
      { v: "CM?", s: pendingCell },
      { v: "Pending", s: text },
      { v: "Not yet", s: plain },
      { v: "Yesterday's MIS is missing but staff can still fill it today. If they don't, it becomes CM tomorrow.", s: text },
    ]);
    sheets.push({ name: "Rules & Codes", rows, merges, colWidths: [12, 22, 16, 90], tabColor: "7F7F7F" });
  }

  return buildWorkbook({ styles, sheets });
}

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
