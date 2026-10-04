/**
 * The company's working calendar for MIS: which days an MIS is expected.
 *
 * Off days (no MIS required, never a red circle, never shown as a day to fill):
 *   - every Sunday                         (SU)
 *   - the 2nd Saturday of a month          (SSO) — company weekly off
 *     (1st, 3rd, 4th and 5th Saturdays are working days)
 *   - Indian stock market trading holidays (H) — NSE circulars, built in below
 *   - extra company holidays an admin adds (H)
 * An admin can also turn a built-in holiday into a working day.
 *
 * Everything that used to say "yesterday" / "day before" now means the last
 * working day / the working day before it, so a Monday after a 2nd-Saturday
 * weekend looks at Friday and Thursday, and a holiday is simply skipped.
 */
import { prisma } from "../lib/db";

/**
 * NSE trading holidays 2026 (equity & equity derivatives), from NSE circular
 * Ref. 212/2025 dated 12 Dec 2025, plus the special holiday on 15 Jan 2026
 * (Maharashtra municipal elections). Weekend entries are listed for
 * completeness. 2027 is published by NSE around mid-December — add it in
 * MailPilot (MIS Circle Report → Holidays) or extend this list.
 */
export const MARKET_HOLIDAYS: Record<string, string> = {
  "2026-01-15": "Municipal Corporation Election (Maharashtra)",
  "2026-01-26": "Republic Day",
  "2026-02-15": "Mahashivratri",
  "2026-03-03": "Holi",
  "2026-03-21": "Id-Ul-Fitr (Ramadan Eid)",
  "2026-03-26": "Shri Ram Navami",
  "2026-03-31": "Shri Mahavir Jayanti",
  "2026-04-03": "Good Friday",
  "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
  "2026-05-01": "Maharashtra Day",
  "2026-05-28": "Bakri Id",
  "2026-06-26": "Muharram",
  "2026-08-15": "Independence Day",
  "2026-09-14": "Ganesh Chaturthi",
  "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-10-20": "Dussehra",
  "2026-11-08": "Diwali Laxmi Pujan (Muhurat Trading)",
  "2026-11-10": "Diwali-Balipratipada",
  "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
  "2026-12-25": "Christmas",
};
export const MARKET_HOLIDAY_SOURCE = "NSE trading holiday circular (Ref. 212/2025, 12 Dec 2025)";

export type OffCode = "SU" | "SSO" | "H";

export interface HolidayOverride {
  date: string;
  name: string;
  /** true = holiday (company added), false = a built-in holiday the company works on. */
  isOff: boolean;
}

export interface WorkCalendar {
  /** Holidays in effect: date -> name. */
  holidays: Map<string, string>;
}

/** Built-in holidays plus the company's overrides. */
export function buildCalendar(overrides: HolidayOverride[] = []): WorkCalendar {
  const holidays = new Map(Object.entries(MARKET_HOLIDAYS));
  for (const o of overrides) {
    if (o.isOff) holidays.set(o.date, o.name || "Company holiday");
    else holidays.delete(o.date);
  }
  return { holidays };
}

/** Built-in calendar only (no database) — used by pure code and tests. */
export const DEFAULT_CALENDAR: WorkCalendar = buildCalendar();

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const saturdayNumber = (date: string) => Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1;

export function addDaysTo(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Why a date is off, or null for a working day. Sunday wins over a holiday on a Sunday. */
export function offDay(date: string, cal: WorkCalendar = DEFAULT_CALENDAR): { code: OffCode; name: string } | null {
  const d = weekday(date);
  if (d === 0) return { code: "SU", name: "Sunday" };
  const h = cal.holidays.get(date);
  if (h) return { code: "H", name: h };
  if (d === 6 && saturdayNumber(date) === 2) return { code: "SSO", name: "Second Saturday (weekly off)" };
  return null;
}

export const isWorkingDay = (date: string, cal: WorkCalendar = DEFAULT_CALENDAR) => offDay(date, cal) === null;

/** The nearest working day strictly before `date`. */
export function previousWorkingDay(date: string, cal: WorkCalendar = DEFAULT_CALENDAR): string {
  let d = addDaysTo(date, -1);
  for (let i = 0; i < 60 && !isWorkingDay(d, cal); i++) d = addDaysTo(d, -1);
  return d;
}

/** The nearest working day strictly after `date`. */
export function nextWorkingDay(date: string, cal: WorkCalendar = DEFAULT_CALENDAR): string {
  let d = addDaysTo(date, 1);
  for (let i = 0; i < 60 && !isWorkingDay(d, cal); i++) d = addDaysTo(d, 1);
  return d;
}

/** The last `n` working days strictly before `today`, newest first. */
export function lastWorkingDays(today: string, n: number, cal: WorkCalendar = DEFAULT_CALENDAR): string[] {
  const out: string[] = [];
  let d = today;
  while (out.length < n) {
    d = previousWorkingDay(d, cal);
    out.push(d);
  }
  return out;
}

/** "Fri 2 Oct" */
export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Names for the two MIS days: "Yesterday" / "Day before yesterday" when they
 * really are, otherwise "Last working day" / "Previous working day".
 */
export function focusLabels(today: string, last: string, previous: string) {
  const isYesterday = last === addDaysTo(today, -1);
  return {
    last: isYesterday ? "Yesterday" : "Last working day",
    previous: isYesterday && previous === addDaysTo(today, -2) ? "Day before yesterday" : "Previous working day",
  };
}

// ---------------------------------------------------------------------------
// Company overrides (database), cached
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; cal: WorkCalendar }>();
const TTL_MS = 5 * 60_000;

/** The company's calendar (built-ins + overrides). Falls back to the built-ins if the table can't be read. */
export async function getWorkCalendar(companyId: string): Promise<WorkCalendar> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cal;
  try {
    const rows = await prisma.misHoliday.findMany({ where: { companyId } });
    const cal = buildCalendar(rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), name: r.name, isOff: r.isOff })));
    cache.set(companyId, { at: Date.now(), cal });
    return cal;
  } catch (e) {
    console.error("[MIS] couldn't load holidays, using the built-in list:", e instanceof Error ? e.message : e);
    return DEFAULT_CALENDAR;
  }
}

export function invalidateWorkCalendar(companyId: string) {
  cache.delete(companyId);
}

export class HolidayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface HolidayListItem {
  date: string;
  name: string;
  /** NSE = built-in market holiday, COMPANY = added by an admin. */
  source: "NSE" | "COMPANY";
  /** false = built-in holiday the company has turned into a working day. */
  isOff: boolean;
  weekday: string;
}

/** Every holiday of a year, built-in and company, including built-ins switched off. */
export async function listHolidays(companyId: string, year: number): Promise<HolidayListItem[]> {
  const rows = await prisma.misHoliday.findMany({
    where: { companyId, date: { gte: new Date(`${year}-01-01T00:00:00Z`), lte: new Date(`${year}-12-31T00:00:00Z`) } },
  });
  const over = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));
  const out: HolidayListItem[] = [];
  const wd = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  for (const [date, name] of Object.entries(MARKET_HOLIDAYS)) {
    if (!date.startsWith(`${year}-`)) continue;
    const o = over.get(date);
    out.push({ date, name: o?.isOff ? o.name : name, source: "NSE", isOff: o ? o.isOff : true, weekday: wd(date) });
    over.delete(date);
  }
  for (const [date, o] of over) out.push({ date, name: o.name, source: "COMPANY", isOff: o.isOff, weekday: wd(date) });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Add a company holiday, or switch a built-in one on/off. */
export async function setHoliday(companyId: string, actorId: string, input: { date: string; name?: string | null; isOff: boolean }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) throw new HolidayError(400, "Invalid date.");
  const builtIn = MARKET_HOLIDAYS[input.date];
  const name = input.name?.trim().slice(0, 120) || builtIn || "Company holiday";
  const date = new Date(`${input.date}T00:00:00.000Z`);
  if (builtIn && input.isOff && !input.name?.trim()) {
    // Back to the default: just drop the override.
    await prisma.misHoliday.deleteMany({ where: { companyId, date } });
  } else if (!builtIn && !input.isOff) {
    await prisma.misHoliday.deleteMany({ where: { companyId, date } });
  } else {
    await prisma.misHoliday.upsert({
      where: { companyId_date: { companyId, date } },
      create: { companyId, date, name, isOff: input.isOff, createdById: actorId },
      update: { name, isOff: input.isOff, createdById: actorId },
    });
  }
  invalidateWorkCalendar(companyId);
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_HOLIDAY_CHANGED", metadata: { date: input.date, name, isOff: input.isOff } } })
    .catch(() => undefined);
}
