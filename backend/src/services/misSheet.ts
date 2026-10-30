/**
 * MIS auto-check — pure spreadsheet logic (no I/O, unit-tested).
 *
 * Decides, for one MIS workbook and one business date, whether the person has
 * filled in that day's MIS:
 *   COMPLETE   — the day exists and at least 80% of its boxes are filled
 *   INCOMPLETE — the day exists but fewer than 80% of its boxes are filled (a red circle)
 *   MISSING    — the day isn't in the sheet yet
 *
 * Input is what Microsoft Graph's `usedRange(valuesOnly=true)` returns for a
 * worksheet: a grid of values where real dates are Excel serial numbers,
 * typed dates are strings, and blanks are "".
 *
 * Two layouts are understood, detected automatically:
 *
 * 1. DAY COLUMNS (how every Farsight MIS is built): one header row holds the
 *    dates across the top (01.09.2026 | 02.09.2026 | …), the "particulars"
 *    run down the left, and each day's work is a new column. The day's column
 *    must have at least 80% of its boxes filled. Every box counts — nothing is
 *    scaled down to what the person usually fills. Only manager rows and
 *    labels (headings / group names nobody filled in the last 40 working
 *    days) are not boxes. An admin can pin an explicit list instead.
 *
 * 2. DAY ROWS: a normal table with a "Date" column; at least 80% of the named
 *    columns of the day's rows must be filled (except S.No / Remarks-style columns).
 *
 * Dates are read the way they are typed in India (day first: 01.09.2026,
 * 14/9/2026, 27.08.26, 17-08-2026 …). Excel often stores "01/09/2026" typed on
 * a US-locale machine as 9 January; such day ≤ 12 dates are un-swapped by
 * picking the reading that fits the neighbouring dates.
 */

export type MisStatus = "COMPLETE" | "INCOMPLETE" | "MISSING";

export interface MisSheetInput {
  name: string;
  values: unknown[][];
  /** Excel row number (1-based) of values[0] — usedRange may not start at row 1. */
  firstRow?: number;
  /** Excel column number (1-based) of values[r][0]. */
  firstCol?: number;
}

export interface MisCheckOptions {
  /** Business date to check, "YYYY-MM-DD". */
  date: string;
  /** Only look at this worksheet. Null/empty = every worksheet. */
  sheetName?: string | null;
  /** DAY ROWS layout only: header of the date column. Null/empty = auto-detect. */
  dateColumn?: string | null;
  /** Fields (particulars / column headers) that must be filled. Null = learned automatically. */
  requiredColumns?: string[] | null;
  /**
   * Days nobody fills an MIS (Sundays, weekly-off Saturdays, holidays). They
   * are left out when learning which rows a person usually fills, so a
   * holiday's empty column doesn't make every row look optional.
   */
  isOffDay?: (date: string) => boolean;
  /** Treat a day copied from an earlier day as not filled (default true). */
  detectCopies?: boolean;
}

export interface MisField {
  name: string;
  /** Required in this check. */
  required: boolean;
}

export interface MisBlank {
  sheet: string;
  cell: string; // e.g. "N12"
  field: string;
}

export interface MisCheckResult {
  status: MisStatus;
  layout: "DAY_COLUMNS" | "DAY_ROWS" | "DAY_BLOCKS" | null;
  /** Sheet the day was found on. */
  sheet: string | null;
  /** DAY_COLUMNS: required fields that are filled. DAY_ROWS: rows dated that day. */
  filledCount: number;
  /** Required fields that are blank. */
  missingFields: string[];
  /** Exactly which cells are blank (first 50). */
  blanks: MisBlank[];
  /** How many usual entries are blank in total (blanks is capped / empty when not filled). */
  blankCount?: number;
  /** The day's entries were copied from this earlier day ("YYYY-MM-DD") — counted as not filled. */
  copiedFrom?: string | null;
  /** Fields seen on the sheet, with whether each was required. */
  fields: MisField[];
  /** Human-readable reason when something looks off. */
  note: string | null;
}

// ---------------------------------------------------------------------------
// Cells and dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_MS = 86400000;

export const normHeader = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const key = (s: unknown) => normHeader(s).toLowerCase();
const looseKey = (s: unknown) => key(s).replace(/[^a-z0-9]+/g, "");

function cell(sheet: MisSheetInput, r: number, c: number): unknown {
  return sheet.values[r]?.[c];
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).replace(/[\u200b-\u200d\u2060]/g, "").trim() === "";
}

function colLetter(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function a1(sheet: MisSheetInput, r: number, c: number): string {
  return `${colLetter((sheet.firstCol ?? 1) + c)}${(sheet.firstRow ?? 1) + r}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. 31 Feb
  return `${y}-${pad(m)}-${pad(d)}`;
}

const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Excel serial day number -> "YYYY-MM-DD" (1900 date system). */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 36526 || serial > 73051) return null; // 2000-01-01 .. 2099-12-31
  return new Date(Math.round((Math.floor(serial) - 25569) * DAY_MS)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Typed dates — forgiving: staff type dates in many ways and make small slips.
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT: Record<string, number> = { ...MONTHS, sept: 9, june: 6, july: 7 };

function editDist(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
    }
  return d[a.length][b.length];
}

/** "Oct", "October", "Octobar", "Ocotber", "Sept", "Septmber", "Agust" … -> month number; null if not a month. */
export function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length < 3) return null;
  if (MONTH_SHORT[w]) return MONTH_SHORT[w];
  const exactPrefix = MONTH_NAMES.findIndex((n) => w.length >= 4 && n.startsWith(w));
  if (exactPrefix >= 0) return exactPrefix + 1;
  if (w.length === 3) {
    // "Okt", "Spe" -> one letter off a 3-letter month, same first letter, and only one such month.
    const near3 = Object.keys(MONTHS).filter((k) => k[0] === w[0] && editDist(w, k) === 1);
    return near3.length === 1 ? MONTHS[near3[0]] : null;
  }
  const hits = MONTH_NAMES.map((n, i) => ({ i, d: Math.min(editDist(w, n), w.length < n.length ? editDist(w, n.slice(0, w.length)) : 99) })).filter(
    (h) => h.d <= (w.length >= 6 ? 2 : 1) && MONTH_NAMES[h.i][0] === w[0],
  );
  const best = hits.sort((x, y) => x.d - y.d);
  return best.length && (best.length === 1 || best[0].d < best[1].d) ? best[0].i + 1 : null;
}

const WEEKDAYS = /\b(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/g;

interface DateParts {
  y: number | null;
  m: number;
  d: number;
  /** Numeric day/month that could also be read the other way round (both ≤ 12). */
  ambiguous?: boolean;
}

/**
 * Reads a typed date in any common form, day first (India): 21/10/2026,
 * 21.10.26, 21-10-2026, 21 10 2026, 21..10.2026, 21 / 10 / 2026, 21st October
 * 2026, 21 st Oct'26, 21-Oct, Tuesday, 21st of October 2026, October 21st,
 * 2026, Oct 21, 21October2026, 21102026, 2026-10-21, 10/21/2026 (US, when
 * the second number can only be a day), "Date: 21/10/2026 (Tue)", misspelt
 * months ("Octobar", "Septmber") … The year may be missing (filled in from
 * the other dates around it). Returns null for anything that isn't a date.
 */
export function parseDateParts(input: string): DateParts | null {
  let s = ` ${input.toLowerCase().replace(/[\u200b-\u200d\u2060\ufeff]/g, "")} `
    .replace(/[–—−]/g, "-")
    .replace(/(\d)\s*(st|nd|rd|th)\b/g, "$1")
    .replace(WEEKDAYS, " ")
    .replace(/\b(date|dated|dt|day|on|of|the|for)\b\.?/g, " ")
    .replace(/[(),:;_]/g, " ")
    .replace(/'\s?(\d{2})\b/g, " 20$1") // Oct'26 -> Oct 2026 (the apostrophe marks a year)
    .replace(/\s*([./-])[\s./-]*/g, "$1") // "21..10.2026", "21 / 10 / 2026" -> one separator
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[./-]+|[./-]+$/g, "");
  if (!s) return null;
  const yr = (t: string | undefined) => (t ? (t.length === 2 ? 2000 + Number(t) : Number(t)) : null);
  const ok = (p: DateParts | null) => (p && (p.y === null ? ymd(2024, p.m, p.d) : ymd(p.y, p.m, p.d)) ? p : null); // 2024: leap year, so 29 Feb passes without a year
  // The date must come first: only words like "Date", "dated", a weekday … may come before it (already removed),
  // so notes such as "MIS pending of 01.09.2026" or "Updated 20-06-2026" are not read as dates.
  const early = (idx: number) => idx === 0;
  // A date without a year must be the whole cell ("21 Oct"), so "Jun-26 Qtr" (a month and year) isn't a date.
  const whole = (m: RegExpExecArray) => m.index === 0 && m[0].length === s.length;

  let m = /^(\d{2})(\d{2})(\d{4})$/.exec(s); // 21102026 — only for a plausible year, so amounts aren't read as dates
  if (m) return +m[3] >= 2020 && +m[3] <= 2040 ? ok({ d: +m[1], m: +m[2], y: +m[3] }) : null;

  m = /(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/.exec(s);
  if (m && early(m.index)) return ok({ y: +m[1], m: +m[2], d: +m[3] });

  m = /(\d{1,2})[./ -](\d{1,2})[./ -](\d{4}|\d{2})(?!\d)(?![./-]\d)/.exec(s);
  if (m && early(m.index)) {
    const a = +m[1];
    const b = +m[2];
    if (a <= 12 && b > 12) return ok({ d: b, m: a, y: yr(m[3]) }); // 10/21/2026 — can only be US style
    return ok({ d: a, m: b, y: yr(m[3]), ambiguous: a <= 12 && b <= 12 && a !== b });
  }

  m = /(\d{1,2})[./ -]?([a-z]{3,})\.?(?:[./ -]?(\d{4}|\d{2}))?(?![\d])/.exec(s);
  if (m && early(m.index) && (m[3] || whole(m))) {
    const mo = monthOf(m[2]);
    if (mo) return ok({ d: +m[1], m: mo, y: yr(m[3]) });
  }

  m = /([a-z]{3,})\.?[./ -]?(\d{1,2})(?:[./ -](\d{4}|\d{2}))?(?![\d])/.exec(s);
  // "October 21, 2026", "Oct 21" — but not "Jun-26" / "Jun 26" alone, which is how a month and year is written.
  const looksLikeYear = (n: number) => n >= 20 && n <= 40 && !/\d\s*(st|nd|rd|th)\b/i.test(input); // "Jun 26" vs "Jun 26th"
  if (m && early(m.index) && (m[3] || (whole(m) && !looksLikeYear(+m[2])))) {
    const mo = monthOf(m[1]);
    if (mo) return ok({ d: +m[2], m: mo, y: yr(m[3]) });
  }

  m = /^(\d{1,2})[./-](\d{1,2})$/.exec(s); // "21/10" — no year
  if (m) return ok({ d: +m[1], m: +m[2], y: null, ambiguous: +m[1] <= 12 && +m[2] <= 12 && m[1] !== m[2] });
  return null;
}

/** Year for a date typed without one: the year that puts it closest to `near` (default: today). */
function withYear(p: DateParts, near: string): string | null {
  if (p.y !== null) return ymd(p.y, p.m, p.d);
  const y0 = Number(near.slice(0, 4));
  const options = [y0 - 1, y0, y0 + 1].map((y) => ymd(y, p.m, p.d)).filter((x): x is string => !!x);
  return options.sort((a, b) => Math.abs(toMs(a) - toMs(near)) - Math.abs(toMs(b) - toMs(near)))[0] ?? null;
}

/** Parses a typed date, day first (see parseDateParts). A missing year is taken from `near` (default today). */
export function parseTextDate(input: string, near?: string): string | null {
  const p = parseDateParts(input);
  return p ? withYear(p, near ?? new Date().toISOString().slice(0, 10)) : null;
}

/** Any single cell -> date. `near` = a date it should be close to (for a missing year). */
export function parseMisDate(raw: unknown, near?: string): string | null {
  if (typeof raw === "number") {
    const d = excelSerialToDate(raw);
    if (d) return d;
    return Number.isInteger(raw) && raw >= 1012000 && raw <= 31129999 ? parseTextDate(String(raw).padStart(8, "0"), near) : null; // 21102026 typed as a number
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = parseTextDate(raw, near);
  if (t) return t;
  if (/^\d{5}(\.\d+)?$/.test(raw.trim())) return excelSerialToDate(Number(raw));
  return null;
}

interface DateCell {
  col: number;
  date: string;
}

const addDay = (iso: string, n: number) => new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
const isSunday = (iso: string) => new Date(toMs(iso)).getUTCDay() === 0;

/**
 * Reads a header row of dates (left to right, in order) and repairs slips
 * using the dates around each one:
 *   - day/month that could be either way (Excel's US-locale swap, 05/10) →
 *     the reading closest to its neighbours;
 *   - a date typed without a year → the year of the row;
 *   - a wrong year or month (21/10/2025 or 21/11/2026 among October 2026) →
 *     corrected when the corrected date fits between its neighbours;
 *   - the same date typed twice in a row while the next day is missing →
 *     the second one is the next working day (only in rows where dates are
 *     otherwise unique, so sheets with two columns per day are left alone).
 */
export function readDateRow(row: unknown[], fromCol = 0): DateCell[] {
  type Raw = { col: number; options: string[] };
  const parsed: { col: number; parts: DateParts | null; serial: string | null }[] = [];
  for (let c = fromCol; c < row.length; c++) {
    const v = row[c];
    if (typeof v === "number") {
      const d = excelSerialToDate(v);
      if (d) parsed.push({ col: c, parts: null, serial: d });
      else {
        const t = Number.isInteger(v) ? parseDateParts(String(v).padStart(8, "0")) : null;
        if (t && /^\d{7,8}$/.test(String(v))) parsed.push({ col: c, parts: t, serial: null });
      }
    } else if (typeof v === "string") {
      const p = parseDateParts(v);
      if (p) parsed.push({ col: c, parts: p, serial: null });
      else if (/^\d{5}(\.\d+)?$/.test(v.trim())) {
        const d = excelSerialToDate(Number(v));
        if (d) parsed.push({ col: c, parts: null, serial: d });
      }
    }
  }
  if (parsed.length === 0) return [];

  // The row's year: from the dates that have one.
  const years = parsed.map((p) => (p.serial ? Number(p.serial.slice(0, 4)) : p.parts!.y)).filter((y): y is number => y !== null);
  const rowYear = years.length ? mode(years) : new Date().getUTCFullYear();
  const months = parsed.map((p) => (p.serial ? Number(p.serial.slice(5, 7)) : p.parts!.m));
  const near = `${rowYear}-${pad(mode(months))}-15`;

  const raws: Raw[] = parsed
    .map((p) => {
      if (p.serial) {
        const [y, m, day] = p.serial.split("-").map(Number);
        const swapped = day <= 12 && day !== m ? ymd(y, day, m) : null;
        return { col: p.col, options: swapped ? [p.serial, swapped] : [p.serial] };
      }
      // Typed text is read day first (as staff in India write it); only Excel's stored dates can be swapped.
      const a = withYear(p.parts!, near);
      return a ? { col: p.col, options: [a] } : null;
    })
    .filter((r): r is Raw => r !== null);
  if (!raws.length) return [];

  let out: DateCell[];
  const anchors = raws.filter((r) => r.options.length === 1);
  if (anchors.length === 0) {
    // Nothing unambiguous: take the reading (as typed vs swapped) that makes the dates most sequential.
    const spread = (pick: number) =>
      raws.reduce((sum, r, i) => (i === 0 ? 0 : sum + Math.abs(toMs(r.options[Math.min(pick, r.options.length - 1)]) - toMs(raws[i - 1].options[Math.min(pick, raws[i - 1].options.length - 1)]))), 0);
    const pick = spread(1) < spread(0) ? 1 : 0;
    out = raws.map((r) => ({ col: r.col, date: r.options[Math.min(pick, r.options.length - 1)] }));
  } else {
    out = [];
    let last: string | null = null;
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i];
      let date = r.options[0];
      if (r.options.length > 1) {
        const ref = last ?? raws.slice(i + 1).find((x) => x.options.length === 1)?.options[0] ?? null;
        if (ref) {
          const dist = (d: string) => Math.abs(toMs(d) - toMs(ref));
          date = r.options.reduce((best, d) => (dist(d) < dist(best) ? d : best));
        }
      }
      out.push({ col: r.col, date });
      last = date;
    }
  }
  return repairRow(out);
}

function mode(xs: number[]): number {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/**
 * A date out of order between two close neighbours (21/10, 22/11, 23/10 or
 * 21/10/26, 22/10/25, 23/10/26) -> the same day in the neighbours' month/year,
 * when that fits between them. Used for header rows and for dates down a column.
 */
export function fixOutOfOrder(cells: DateCell[]): DateCell[] {
  const out = cells.map((c) => ({ ...c }));
  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1].date;
    const next = out[i + 1].date;
    const x = out[i].date;
    if ((prev <= x && x <= next) || prev > next || toMs(next) - toMs(prev) > 10 * DAY_MS) continue;
    const d = Number(x.slice(8, 10));
    const m = Number(x.slice(5, 7));
    const tries = [prev, next].flatMap((n) => [ymd(Number(n.slice(0, 4)), Number(n.slice(5, 7)), d), ymd(Number(n.slice(0, 4)), Number(n.slice(5, 7)), m), ymd(Number(n.slice(0, 4)), m, d)]);
    const fit = tries.find((t): t is string => !!t && prev <= t && t <= next);
    if (fit) out[i].date = fit;
  }
  return out;
}

/** Fixes a wrong year/month and an isolated repeated date (see readDateRow). Rows with fewer than 3 dates are left alone. */
function repairRow(cells: DateCell[]): DateCell[] {
  if (cells.length < 3) return cells;
  // Only rows that look like a month of MIS days (nearly all dates within ~6 weeks) are repaired —
  // never lists of other dates (NAV dates, due dates …) that happen to be in a row.
  const FAR = 45 * DAY_MS;
  const ms0 = cells.map((c) => toMs(c.date)).sort((a, b) => a - b);
  const median0 = ms0[Math.floor(ms0.length / 2)];
  const close = ms0.filter((m) => Math.abs(m - median0) <= FAR).length;
  if (close < cells.length - Math.max(1, Math.floor(cells.length / 5))) return cells;
  const out = fixOutOfOrder(cells);
  const sortedMs = out.map((c) => toMs(c.date)).sort((a, b) => a - b);
  const median = sortedMs[Math.floor(sortedMs.length / 2)];
  for (let i = 0; i < out.length; i++) {
    const ms = toMs(out[i].date);
    if (Math.abs(ms - median) <= FAR) continue;
    const prev = out.slice(0, i).reverse().find((c) => Math.abs(toMs(c.date) - median) <= FAR)?.date ?? null;
    const next = out.slice(i + 1).find((c) => Math.abs(toMs(c.date) - median) <= FAR)?.date ?? null;
    const [y, m, d] = out[i].date.split("-").map(Number);
    const my = new Date(median).getUTCFullYear();
    const candidates = [
      ymd(my, m, d),
      ymd(my - 1, m, d),
      ymd(my + 1, m, d),
      ymd(y, d, m),
      ymd(my, d, m),
      ...(prev ? [ymd(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), d)] : []),
      ...(next ? [ymd(Number(next.slice(0, 4)), Number(next.slice(5, 7)), d)] : []),
    ].filter((x): x is string => !!x && Math.abs(toMs(x) - median) <= FAR && (!prev || x > prev) && (!next || x < next));
    if (candidates.length) out[i].date = candidates.sort((a, b) => Math.abs(toMs(a) - median) - Math.abs(toMs(b) - median))[0];
  }
  // The same date typed twice while the next day is missing. Only when repeats are rare
  // (sheets with two columns per day repeat every date and are left alone).
  const repeats = out.filter((c, i) => i > 0 && c.date === out[i - 1].date).length;
  if (repeats > 0 && repeats <= Math.max(1, Math.floor(out.length / 10))) {
    for (let i = 1; i < out.length; i++) {
      if (out[i].date !== out[i - 1].date) continue;
      const next = out[i + 1]?.date ?? null;
      let cand = addDay(out[i - 1].date, 1);
      if (isSunday(cand) && (!next || addDay(cand, 1) < next)) cand = addDay(cand, 1);
      if ((!next || cand < next) && !out.some((c) => c.date === cand)) out[i].date = cand;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout 1: dates across a header row, particulars down the side
// ---------------------------------------------------------------------------
interface ColumnLayout {
  sheet: MisSheetInput;
  headerIndex: number;
  dates: DateCell[];
  firstDateCol: number;
  rows: { index: number; label: string; key: string }[];
}

const HEADER_SCAN_ROWS = 40;

function findColumnLayout(sheet: MisSheetInput): ColumnLayout | null {
  // The header is the row with the most DIFFERENT dates (a data row that
  // repeats one date many times must not win).
  let best: { index: number; dates: DateCell[]; distinct: number } | null = null;
  const scan = Math.min(sheet.values.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < scan; r++) {
    const dates = readDateRow(sheet.values[r] ?? [], 1);
    const distinct = new Set(dates.map((d) => d.date)).size;
    if (distinct >= 2 && (!best || distinct > best.distinct)) best = { index: r, dates, distinct };
  }
  if (!best) return null;

  const firstDateCol = best.dates[0].col;
  const rows: ColumnLayout["rows"] = [];
  const seen = new Map<string, number>();
  for (let r = best.index + 1; r < sheet.values.length; r++) {
    const parts: string[] = [];
    for (let c = 0; c < firstDateCol; c++) {
      const v = cell(sheet, r, c);
      if (!isBlank(v)) parts.push(normHeader(v));
    }
    const label = parts.join(" ").slice(0, 200);
    if (!label) continue;
    const base = looseKey(label);
    if (!base) continue;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    rows.push({ index: r, label, key: n > 1 ? `${base}#${n}` : base });
  }
  return { sheet, headerIndex: best.index, dates: best.dates, firstDateCol, rows };
}

/**
 * Every box in the day's column must be filled — nothing is scaled down to
 * what a person usually fills. A day is SUBMITTED when at least
 * COMPLETE_PERCENT of its boxes are filled (40 of 50); below that it is
 * INCOMPLETE and a red circle, like an unfilled day.
 *
 * Not boxes: manager rows (checked/approved by, remarks, reply) and labels —
 * section headings ("A  DP Account") and group labels ("3 Weekly Checking",
 * an account holder's name above their bank accounts) that nobody has filled
 * on any of the last BOX_HISTORY_DAYS working days. Any row filled even once
 * in that time is a box every day. A section heading filled with "NIL"
 * answers for the rows under it.
 */
export const COMPLETE_PERCENT = 80;
const BOX_HISTORY_DAYS = 40;
/** Fewer earlier working days than this = too new to tell labels from boxes: every row except headings is a box. */
const BOX_MIN_HISTORY = 5;
/** @deprecated kept for older callers — the rule is now COMPLETE_PERCENT of all boxes. */
export const NOT_FILLED_BLANKS = 20;

/** true when `filled` of `boxes` reaches COMPLETE_PERCENT (integer maths: 40 of 50 = exactly 80% passes). */
export const meetsCompletePercent = (filled: number, boxes: number) => boxes > 0 && filled * 100 >= boxes * COMPLETE_PERCENT;
/** Boxes needed for a day to count as submitted. */
export const boxesNeeded = (boxes: number) => Math.ceil((boxes * COMPLETE_PERCENT) / 100);
export const percentOf = (filled: number, boxes: number) => (boxes > 0 ? Math.floor((filled * 100) / boxes) : 0);

function medianMs(l: ColumnLayout): number {
  const ms = l.dates.map((d) => toMs(d.date)).sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)];
}

/**
 * The sheet that owns a date. People sometimes keep typing into last month's
 * sheet for a few days before starting the new one, so the same date can sit
 * on two sheets: the one with more filled in for that date wins, then the one
 * whose dates cluster around it.
 */
function sheetForDate(layouts: ColumnLayout[], date: string): { layout: ColumnLayout; cols: number[] } | null {
  let best: { layout: ColumnLayout; cols: number[]; filled: number; dist: number } | null = null;
  for (const l of layouts) {
    const cols = l.dates.filter((d) => d.date === date).map((d) => d.col);
    if (!cols.length) continue;
    const filled = l.rows.filter((r) => cols.some((c) => !isBlank(cell(l.sheet, r.index, c)))).length;
    const dist = Math.abs(medianMs(l) - toMs(date));
    if (!best || filled > best.filled || (filled === best.filled && dist < best.dist)) best = { layout: l, cols, filled, dist };
  }
  return best && { layout: best.layout, cols: best.cols };
}

/**
 * Rows filled at least once on the last BOX_HISTORY_DAYS working days before
 * `date` (any sheet), and how many such days there were.
 */
function filledHistory(layouts: ColumnLayout[], date: string, isOffDay?: (date: string) => boolean): { days: number; filled: Set<string> } {
  const allDates = new Set<string>();
  for (const l of layouts) for (const d of l.dates) if (d.date < date && !isOffDay?.(d.date)) allDates.add(d.date);
  const recent = [...allDates].sort().reverse().slice(0, BOX_HISTORY_DAYS);
  const filled = new Set<string>();
  let days = 0;
  for (const d of recent) {
    const owner = sheetForDate(layouts, d);
    if (!owner) continue;
    days++;
    for (const row of owner.layout.rows) if (owner.cols.some((c) => !isBlank(cell(owner.layout.sheet, row.index, c)))) filled.add(row.key);
  }
  return { days, filled };
}

/** "NIL", "N/A", "-", "no case" … written on a section heading = nothing to report for the whole section. */
const SECTION_NIL = /^(nil+|na|n\/a|n\.a\.?|none|no|-+|not applicable|no (work|case|cases|request|requests|query|queries|application|applications|pendency|pending))$/i;

/** Rows the staff member doesn't fill themselves (manager approval / remarks / replies) — never required automatically. */
const NOT_STAFF_ROWS = /approved\s*by|approval|\bremarks?\b|\breply\b|\bcomments?\b/i;

/** Section headings ("A  DP Account", "B  KRA / AOF …") — used only when there is no history to learn from. */
const looksLikeHeading = (label: string) => /^[A-Z]\s/.test(label);

function matchesConfigured(label: string, configured: string[]): boolean {
  const k = looseKey(label);
  return configured.some((c) => {
    const ck = looseKey(c);
    return ck.length > 0 && (k === ck || k.startsWith(ck) || k.endsWith(ck));
  });
}

// ---------------------------------------------------------------------------
// Copied days
// ---------------------------------------------------------------------------

/**
 * A copied day: the whole day's column is an exact duplicate of an earlier
 * working day's — the last column pasted into today's. Rows in an MIS often
 * repeat for good reasons ("not due", "Reconciled", "NA", a balance that didn't
 * move), so to never accuse anyone wrongly ALL of these must hold:
 *   1. every filled entry of the day (at least COPY_MIN_FILLED of them) is
 *      exactly the same as on that earlier day, and the same rows are filled;
 *   2. at least COPY_MIN_VOLATILE of those entries are ones that, for this
 *      person, change almost every day (over the last COPY_HISTORY_DAYS
 *      working days the value changed on ≥ COPY_VOLATILE_RATIO of days) —
 *      counts, amounts, "updated till <date>" and the like — and every one
 *      of them is unchanged too.
 * Manager rows (approved by / remarks / reply) and headings are ignored.
 */
export const COPY_MIN_FILLED = 8;
export const COPY_MIN_VOLATILE = 3;
export const COPY_VOLATILE_RATIO = 0.75;
const COPY_HISTORY_DAYS = 10;
const COPY_LOOKBACK_DAYS = 3;
const TRIVIAL = /^(nil+|na|n\/a|n\.a\.?|none|no|yes|y|n|ok|okay|done|completed?|pending|same|as above|not applicable|null|-+|\.+|x+|\*+|✓|✔)$/i;
/** Values that naturally repeat day after day: "no query", "not due", "on leave", "holiday"… */
const REPEATING = /^(no|not|nothing|nil|none|on leave|leave|half day|holiday|absent|off|wfh|week ?off)\b/i;

/** Any filled value, normalised for comparing ("12,000" = "12000", case and spaces ignored). */
function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && /\d/.test(s) ? String(n) : s;
}

/** Normalised value when it is distinctive enough to say "this changes daily", else null. */
export function distinctive(v: unknown): string | null {
  const s = norm(v);
  if (s === null || TRIVIAL.test(s) || REPEATING.test(s)) return null;
  const n = Number(s);
  if (Number.isFinite(n) && /^-?[\d.]+(e[-+]?\d+)?$/.test(s)) return Math.abs(n) < 10 ? null : s;
  return s.length < 3 ? null : s;
}

/** Row key -> normalised value for one day (staff rows only). */
function dayValues(layouts: ColumnLayout[], date: string): Map<string, string> | null {
  const owner = sheetForDate(layouts, date);
  if (!owner) return null;
  const out = new Map<string, string>();
  for (const row of owner.layout.rows) {
    if (NOT_STAFF_ROWS.test(row.label) || looksLikeHeading(row.label)) continue;
    for (const c of owner.cols) {
      const v = norm(cell(owner.layout.sheet, row.index, c));
      if (v !== null) {
        out.set(row.key, v);
        break;
      }
    }
  }
  return out;
}

/** The earlier day this day's column was copied from, or null. */
export function findCopiedDay(
  layouts: ColumnLayout[],
  date: string,
  isOffDay?: (d: string) => boolean,
): { date: string; filled: number; volatile: number; rows: { field: string; value: string }[] } | null {
  const today = dayValues(layouts, date);
  if (!today || today.size < COPY_MIN_FILLED) return null;
  const earlier = new Set<string>();
  for (const l of layouts) for (const d of l.dates) if (d.date < date && !isOffDay?.(d.date)) earlier.add(d.date);
  // Newest first: the last COPY_HISTORY_DAYS working days that have something filled.
  const history: { date: string; values: Map<string, string> }[] = [];
  for (const d of [...earlier].sort().reverse()) {
    const values = dayValues(layouts, d);
    if (values && values.size > 0) history.push({ date: d, values });
    if (history.length >= COPY_HISTORY_DAYS) break;
  }
  if (history.length < 4) return null; // too little history to know which rows change daily
  const labelOf = new Map(layouts.flatMap((l) => l.rows.map((r) => [r.key, r.label] as const)));
  for (let i = 0; i < Math.min(COPY_LOOKBACK_DAYS, history.length); i++) {
    const p = history[i];
    // 1. An exact duplicate: same rows filled, every value identical.
    if (p.values.size !== today.size) continue;
    let identical = true;
    for (const [k, v] of today) if (p.values.get(k) !== v) identical = false;
    if (!identical) continue;
    // 2. …including entries that normally change every day (judged on the days before the source day).
    const before = history.slice(i);
    const volatileRows: { field: string; value: string }[] = [];
    for (const [k, v] of today) {
      if (distinctive(v) === null) continue;
      let pairs = 0;
      let changes = 0;
      for (let j = 0; j + 1 < before.length; j++) {
        const a = before[j].values.get(k);
        const b = before[j + 1].values.get(k);
        if (a === undefined || b === undefined) continue;
        pairs++;
        if (a !== b) changes++;
      }
      if (pairs >= 3 && changes / pairs >= COPY_VOLATILE_RATIO) volatileRows.push({ field: labelOf.get(k) ?? k, value: v });
    }
    if (volatileRows.length >= COPY_MIN_VOLATILE) return { date: p.date, filled: today.size, volatile: volatileRows.length, rows: volatileRows };
  }
  return null;
}

function checkColumns(layouts: ColumnLayout[], opts: MisCheckOptions): MisCheckResult | null {
  const owner = sheetForDate(layouts, opts.date);
  if (!owner) return null;
  const l = owner.layout;
  const cols = owner.cols;
  const filledToday = (r: number) => cols.some((c) => !isBlank(cell(l.sheet, r, c)));

  const configured = opts.requiredColumns?.length ? opts.requiredColumns : null;
  const history = configured ? null : filledHistory(layouts, opts.date, opts.isOffDay);
  const knowsLabels = !!history && history.days >= BOX_MIN_HISTORY;

  const blanks: MisBlank[] = [];
  const missing = new Set<string>();
  const fields: MisField[] = [];
  let filled = 0;
  let sectionNil = false; // the current section's heading says NIL for today
  for (const row of l.rows) {
    const heading = looksLikeHeading(row.label);
    const value = cols.map((c) => cell(l.sheet, row.index, c)).find((v) => !isBlank(v));
    if (heading) sectionNil = value !== undefined && SECTION_NIL.test(String(value).trim());
    const isBox = configured
      ? matchesConfigured(row.label, configured)
      : NOT_STAFF_ROWS.test(row.label)
      ? false
      : value !== undefined
      ? true // anything filled today is a box
      : heading
      ? !!history && history.filled.has(row.key) // a heading only when it is normally filled
      : knowsLabels
      ? history!.filled.has(row.key) // never filled in 40 working days = a label, not a box
      : true;
    fields.push({ name: row.label, required: isBox });
    if (!isBox) continue;
    if (filledToday(row.index) || (!heading && sectionNil)) {
      filled++;
    } else {
      missing.add(row.label);
      blanks.push({ sheet: l.sheet.name, cell: a1(l.sheet, row.index, cols[cols.length - 1]), field: row.label });
    }
  }
  const boxes = filled + blanks.length;
  const complete = meetsCompletePercent(filled, boxes);
  const share = `${filled} of ${boxes} boxes filled (${percentOf(filled, boxes)}%)`;

  // Entries copied from an earlier day don't count as filling in the MIS.
  if (complete && opts.detectCopies !== false) {
    const copy = findCopiedDay(layouts, opts.date, opts.isOffDay);
    if (copy) {
      return {
        status: "MISSING",
        layout: "DAY_COLUMNS",
        sheet: l.sheet.name,
        filledCount: filled,
        missingFields: [],
        blanks: [],
        blankCount: blanks.length,
        copiedFrom: copy.date,
        fields,
        note: `Copied from ${fmt(copy.date)} — all ${copy.filled} entries are exactly the same as on ${fmt(copy.date)}, including ${copy.volatile} that change every day (e.g. ${copy.rows
          .slice(0, 3)
          .map((r) => `${r.field.slice(0, 40)}: "${r.value.slice(0, 30)}"`)
          .join("; ")}). A copied day counts as not filled; please enter ${fmt(opts.date)}'s actual figures.`,
      };
    }
  }

  if (filled === 0) {
    return {
      status: "MISSING",
      layout: "DAY_COLUMNS",
      sheet: l.sheet.name,
      filledCount: 0,
      missingFields: [],
      blanks: [],
      blankCount: blanks.length,
      fields,
      note: boxes === 0 ? "The day's column exists but no boxes to fill were found." : `Not filled for ${fmt(opts.date)} — all ${boxes} boxes are blank.`,
    };
  }
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    layout: "DAY_COLUMNS",
    sheet: l.sheet.name,
    filledCount: filled,
    missingFields: [...missing],
    blanks: blanks.slice(0, 50),
    blankCount: blanks.length,
    fields,
    note: complete
      ? `${share}.`
      : `Incomplete — ${share}; at least ${COMPLETE_PERCENT}% (${boxesNeeded(boxes)} of ${boxes}) is needed.`,
  };
}

// ---------------------------------------------------------------------------
// Layout 2: a table with a "Date" column, one row per entry
// ---------------------------------------------------------------------------

const OPTIONAL_BY_DEFAULT = [
  /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|serial\s*(no\.?|number)?|#|no\.?)$/i,
  /remark|comment|note|narration|observation|reply/i,
];

interface RowLayout {
  sheet: MisSheetInput;
  headerIndex: number;
  dateIndex: number;
  columns: { name: string; idx: number }[];
}

function findRowLayout(sheet: MisSheetInput, dateColumn: string | null): RowLayout | null {
  const want = dateColumn ? key(dateColumn) : null;
  const scan = Math.min(sheet.values.length, 25);
  for (let r = 0; r < scan; r++) {
    const row = sheet.values[r] ?? [];
    const headers: { name: string; idx: number }[] = [];
    const seen = new Set<string>();
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (typeof v !== "string" || !v.trim() || parseMisDate(v)) continue;
      const name = normHeader(v);
      if (seen.has(key(name))) continue;
      seen.add(key(name));
      headers.push({ name, idx: c });
    }
    if (headers.length < 2) continue;
    const dateHeader = want ? headers.find((h) => key(h.name) === want) : headers.find((h) => /\bdate\b|\bdt\b|^dated?$/i.test(h.name));
    if (dateHeader) return { sheet, headerIndex: r, dateIndex: dateHeader.idx, columns: headers };
  }
  return null;
}

export function defaultRequiredColumns(columns: string[], dateColumn: string): string[] {
  return columns.filter((c) => key(c) !== key(dateColumn) && !OPTIONAL_BY_DEFAULT.some((re) => re.test(c)));
}

function checkRows(layouts: RowLayout[], opts: MisCheckOptions): MisCheckResult | null {
  const configured = opts.requiredColumns?.length ? opts.requiredColumns : null;
  const blanks: MisBlank[] = [];
  const missing = new Set<string>();
  const fields = new Map<string, boolean>();
  let rowsToday = 0;
  let boxes = 0;
  let sheet: string | null = null;

  for (const l of layouts) {
    const dateName = l.columns.find((c) => c.idx === l.dateIndex)!.name;
    const requiredNames = new Set(
      configured
        ? l.columns.filter((c) => matchesConfigured(c.name, configured)).map((c) => c.name)
        : defaultRequiredColumns(l.columns.map((c) => c.name), dateName),
    );
    for (const c of l.columns) if (c.idx !== l.dateIndex) fields.set(c.name, requiredNames.has(c.name) || fields.get(c.name) === true);
    const required = l.columns.filter((c) => requiredNames.has(c.name));

    // Typed dates down the column, with slips fixed from the rows around them (fixOutOfOrder).
    const typed: DateCell[] = [];
    for (let r = l.headerIndex + 1; r < l.sheet.values.length; r++) {
      const raw = cell(l.sheet, r, l.dateIndex);
      const d = isBlank(raw) ? null : parseMisDate(raw, opts.date);
      if (d) typed.push({ col: r, date: d });
    }
    const fixedDate = new Map(fixOutOfOrder(typed).map((c) => [c.col, c.date]));

    let carried: string | null = null;
    for (let r = l.headerIndex + 1; r < l.sheet.values.length; r++) {
      const raw = cell(l.sheet, r, l.dateIndex);
      let rowDate: string | null;
      if (!isBlank(raw)) {
        rowDate = fixedDate.get(r) ?? null;
        // Wrong year typed (21/10/2025 in the October 2026 rows): same day and month, year off by one,
        // and the row before is close to the day being checked -> it is that day.
        if (rowDate && rowDate !== opts.date && rowDate.slice(5) === opts.date.slice(5) && Math.abs(Number(rowDate.slice(0, 4)) - Number(opts.date.slice(0, 4))) === 1 && carried && Math.abs(toMs(carried) - toMs(opts.date)) <= 45 * DAY_MS) rowDate = opts.date;
        carried = rowDate;
      } else {
        // Blank date: belongs to the day above it, but only if the row has data.
        rowDate = l.columns.some((c) => c.idx !== l.dateIndex && !isBlank(cell(l.sheet, r, c.idx))) ? carried : null;
      }
      if (rowDate !== opts.date) continue;
      rowsToday++;
      sheet ??= l.sheet.name;
      for (const c of required) {
        boxes++;
        if (isBlank(cell(l.sheet, r, c.idx))) {
          missing.add(c.name);
          blanks.push({ sheet: l.sheet.name, cell: a1(l.sheet, r, c.idx), field: c.name });
        }
      }
    }
  }
  if (rowsToday === 0) return null;
  // Same rule as the day-column layout: at least COMPLETE_PERCENT of the day's boxes filled.
  const filledBoxes = boxes - blanks.length;
  const complete = boxes === 0 || meetsCompletePercent(filledBoxes, boxes);
  const share = `${filledBoxes} of ${boxes} boxes filled (${percentOf(filledBoxes, boxes)}%)`;
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    layout: "DAY_ROWS",
    sheet,
    filledCount: rowsToday,
    missingFields: [...missing],
    blanks: blanks.slice(0, 50),
    blankCount: blanks.length,
    fields: [...fields].map(([name, required]) => ({ name, required })),
    note: boxes === 0 ? null : complete ? `${share}.` : `Incomplete — ${share}; at least ${COMPLETE_PERCENT}% (${boxesNeeded(boxes)} of ${boxes}) is needed.`,
  };
}

// ---------------------------------------------------------------------------
// Layout 3: one block of rows per day, stacked down a sheet
// ---------------------------------------------------------------------------
//
//            DATE:  28/10/2026            <- the day's block starts here
//   CLIENT CODE  C5     N11    R21 …
//   SHARES VALUE NIL    NIL    NIL
//   MTM          -3180  2810   -42
//   A) MARGIN FILE SENT, DATE   27 Oct 2026
//   …
//            DATE:  29/10/2026            <- the next day's block
//
// The day's boxes are learned from the day's own block compared with the
// blocks before it: a cell is a box when it is usually filled; text that is
// the same in every block (row labels, client codes) is a label, not a box.

interface DayBlock {
  date: string;
  /** First and last row (inclusive) of the block. */
  from: number;
  to: number;
}

interface BlockLayout {
  sheet: MisSheetInput;
  blocks: DayBlock[];
}

/** "DATE", "Date :", "Dated -" — a cell that labels the date next to it. */
const DATE_LABEL = /^\s*(date|dated|dt)\s*[:.\-]?\s*$/i;
/** Answers that may be the same every day and still count as filled boxes. */
const ANSWER_WORD = /^(nil+|n\.?\s?a\.?|ok|okay|yes|no|done|-+|0|na)$/i;

/** The date a row starts a day's block with ("DATE:" + a date to its right, or "Date: 29/10/2026"), or null. */
function blockStartDate(row: unknown[], near: string): string | null {
  for (let c = 0; c < Math.min(row.length, 60); c++) {
    const v = row[c];
    if (typeof v !== "string") continue;
    if (DATE_LABEL.test(v)) {
      for (let k = c + 1; k <= c + 4 && k < row.length; k++) {
        if (isBlank(row[k])) continue;
        return parseMisDate(row[k], near);
      }
      return null;
    }
    if (/^\s*(date|dated|dt)\s*[:.\-]/i.test(v)) {
      const d = parseMisDate(v, near);
      if (d) return d;
    }
  }
  return null;
}

/** A sheet made of day blocks: at least 2 rows that start a block, on different dates. */
function findBlockLayout(sheet: MisSheetInput, near: string): BlockLayout | null {
  const starts: { row: number; date: string }[] = [];
  for (let r = 0; r < sheet.values.length; r++) {
    const row = sheet.values[r] ?? [];
    const d = blockStartDate(row, near);
    if (!d) continue;
    // A header row with many dates (dates across the top) is not a block start.
    if (row.filter((v) => !isBlank(v) && parseMisDate(v, near)).length > 2) continue;
    if (starts.length && r - starts[starts.length - 1].row < 3) continue;
    starts.push({ row: r, date: d });
  }
  if (starts.length < 2 || new Set(starts.map((s) => s.date)).size < 2) return null;
  // Dates typed with a slip (wrong year/month) are fixed from the blocks around them.
  const fixed = fixOutOfOrder(starts.map((s) => ({ col: s.row, date: s.date })));
  const lengths = starts.slice(1).map((s, i) => s.row - starts[i].row).sort((a, b) => a - b);
  const usual = lengths[Math.floor(lengths.length / 2)];
  const blocks = starts.map((s, i) => ({
    date: fixed[i].date,
    from: s.row,
    to: i + 1 < starts.length ? starts[i + 1].row - 1 : Math.min(sheet.values.length - 1, s.row + Math.ceil(usual * 1.5)),
  }));
  return { sheet, blocks };
}

/** The text that names a row of a block: its first text cell that isn't a number or a date. */
function rowLabel(row: unknown[]): string | null {
  for (const v of row) {
    if (typeof v !== "string" || !v.trim()) continue;
    const t = normHeader(v);
    if (/^[\d\s.,%₹+-]+$/.test(t) || parseMisDate(t)) return null;
    return t;
  }
  return null;
}

/** Every cell of a block, keyed by its row (label, or position when unlabelled) and column. */
function blockCells(l: BlockLayout, b: DayBlock): Map<string, { r: number; c: number; v: unknown }> {
  const out = new Map<string, { r: number; c: number; v: unknown }>();
  const seen = new Map<string, number>();
  for (let r = b.from + 1; r <= b.to; r++) {
    const row = l.sheet.values[r] ?? [];
    const label = rowLabel(row);
    let rk = label ? `L:${looseKey(label)}` : `@${r - b.from}`;
    const n = (seen.get(rk) ?? 0) + 1; // the same label twice in a block
    seen.set(rk, n);
    if (n > 1) rk += `#${n}`;
    for (let c = 0; c < row.length; c++) out.set(`${rk}|${c}`, { r, c, v: row[c] });
    if (!row.length) out.set(`${rk}|0`, { r, c: 0, v: null });
  }
  return out;
}

const textOf = (v: unknown) => (isBlank(v) ? "" : normHeader(v));

function checkBlocks(layouts: BlockLayout[], opts: MisCheckOptions): MisCheckResult | null {
  let owner: { l: BlockLayout; b: DayBlock } | null = null;
  for (const l of layouts) for (const b of l.blocks) if (b.date === opts.date) owner = { l, b };
  if (!owner) return null;
  const { l, b } = owner;
  const today = blockCells(l, b);
  const earlier = layouts
    .flatMap((x) => x.blocks.map((blk) => ({ l: x, b: blk })))
    .filter((x) => x.b.date < opts.date && !opts.isOffDay?.(x.b.date))
    .sort((x, y) => (x.b.date < y.b.date ? 1 : -1))
    .slice(0, 5)
    .map((x) => blockCells(x.l, x.b));

  const boxes: string[] = [];
  if (earlier.length >= 2) {
    const keys = new Set(earlier.flatMap((m) => [...m.keys()]));
    for (const k of keys) {
      const values = earlier.map((m) => textOf(m.get(k)?.v));
      const filledIn = values.filter(Boolean).length;
      if (filledIn * 2 < earlier.length) continue; // usually empty: not a box
      // The same text in every block (and today) = a label (row names, client codes), not a box.
      const t = textOf(today.get(k)?.v);
      const same = values.every((x) => x === values[0]) && (!t || t === values[0]);
      if (same && /[a-z]/i.test(values[0]) && !ANSWER_WORD.test(values[0])) continue;
      if (k.includes("|") && rowIsLabelColumn(k, earlier)) continue;
      boxes.push(k);
    }
  } else {
    // No earlier blocks to learn from: every filled cell today that isn't a row name counts.
    for (const [k, x] of today) if (!isBlank(x.v) && rowLabel([x.v]) === null) boxes.push(k);
  }

  const blanks: MisBlank[] = [];
  let filled = 0;
  for (const k of boxes) {
    const x = today.get(k);
    if (x && !isBlank(x.v)) filled++;
    else {
      const rk = k.split("|")[0];
      const ref = x ?? findCellOf(l, b, k, earlier);
      blanks.push({ sheet: l.sheet.name, cell: ref ? a1(l.sheet, ref.r, ref.c) : "", field: rk.startsWith("L:") ? labelText(l, b, rk) : "row " + rk.slice(1) });
    }
  }
  const total = boxes.length;
  if (filled === 0) {
    return {
      status: "MISSING",
      layout: "DAY_BLOCKS",
      sheet: l.sheet.name,
      filledCount: 0,
      missingFields: [],
      blanks: [],
      blankCount: total,
      fields: [],
      note: `Not filled for ${fmt(opts.date)} — the day's block has a date but its boxes are blank.`,
    };
  }
  // Copied: every box exactly as in the day before (with enough boxes to be sure).
  if (opts.detectCopies !== false && earlier.length && total >= 10) {
    const prev = earlier[0];
    const changing = boxes.filter((k) => new Set(earlier.map((m) => textOf(m.get(k)?.v))).size > 1);
    if (changing.length >= 5 && boxes.every((k) => textOf(today.get(k)?.v) === textOf(prev.get(k)?.v))) {
      return {
        status: "MISSING",
        layout: "DAY_BLOCKS",
        sheet: l.sheet.name,
        filledCount: filled,
        missingFields: [],
        blanks: [],
        blankCount: 0,
        copiedFrom: null,
        fields: [],
        note: `Copied — every entry for ${fmt(opts.date)} is exactly the same as the day before, including figures that change every day. A copied day counts as not filled.`,
      };
    }
  }
  const complete = total === 0 || meetsCompletePercent(filled, total);
  const share = `${filled} of ${total} boxes filled (${percentOf(filled, total)}%)`;
  const missingFields = [...new Set(blanks.map((x) => x.field))];
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    layout: "DAY_BLOCKS",
    sheet: l.sheet.name,
    filledCount: filled,
    missingFields,
    blanks: blanks.slice(0, 50),
    blankCount: blanks.length,
    fields: missingFields.map((name) => ({ name, required: true })),
    note: complete ? `${share}.` : `Incomplete — ${share}; at least ${COMPLETE_PERCENT}% (${boxesNeeded(total)} of ${total}) is needed.`,
  };
}

/** The column holding the row names (the label column) is never a box. */
function rowIsLabelColumn(k: string, earlier: Map<string, { r: number; c: number; v: unknown }>[]): boolean {
  const [rk, c] = k.split("|");
  if (!rk.startsWith("L:")) return false;
  const v = earlier.map((m) => m.get(k)?.v).find((x) => !isBlank(x));
  return v !== undefined && looseKey(v) === rk.slice(2) && Number(c) >= 0;
}

function findCellOf(l: BlockLayout, b: DayBlock, k: string, earlier: Map<string, { r: number; c: number; v: unknown }>[]) {
  const [rk, c] = k.split("|");
  for (let r = b.from + 1; r <= b.to; r++) {
    const label = rowLabel(l.sheet.values[r] ?? []);
    if ((label ? `L:${looseKey(label)}` : `@${r - b.from}`) === rk.split("#")[0]) return { r, c: Number(c) };
  }
  void earlier;
  return null;
}

function labelText(l: BlockLayout, b: DayBlock, rk: string): string {
  for (let r = b.from + 1; r <= b.to; r++) {
    const label = rowLabel(l.sheet.values[r] ?? []);
    if (label && `L:${looseKey(label)}` === rk.split("#")[0]) return label;
  }
  for (const blk of l.blocks) for (let r = blk.from + 1; r <= blk.to; r++) {
    const label = rowLabel(l.sheet.values[r] ?? []);
    if (label && `L:${looseKey(label)}` === rk.split("#")[0]) return label;
  }
  return rk.slice(2);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function fmt(date: string) {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
}

export function checkMisWorkbook(sheets: MisSheetInput[], opts: MisCheckOptions): MisCheckResult {
  const only = opts.sheetName?.trim() ? key(opts.sheetName) : null;
  const candidates = only ? sheets.filter((s) => key(s.name) === only) : sheets;
  const empty = (note: string, fields: MisField[] = []): MisCheckResult => ({
    status: "MISSING",
    layout: null,
    sheet: null,
    filledCount: 0,
    missingFields: [],
    blanks: [],
    fields,
    note,
  });
  if (only && candidates.length === 0) return empty(`Sheet "${opts.sheetName}" not found in the workbook.`);

  // A sheet with one block of rows per day ("DATE: 29/10/2026" above each day) — checked first when it has the day.
  const blockLayouts = candidates.map((s) => findBlockLayout(s, opts.date)).filter((l): l is BlockLayout => l !== null);
  const byBlocks = checkBlocks(blockLayouts, opts);
  if (byBlocks) return byBlocks;

  const colLayouts = candidates.map(findColumnLayout).filter((l): l is ColumnLayout => l !== null);
  const byColumns = checkColumns(colLayouts, opts);
  if (byColumns) return byColumns;

  const rowLayouts = candidates
    .map((s) => findRowLayout(s, opts.dateColumn?.trim() || null))
    .filter((l): l is RowLayout => l !== null);
  const byRows = checkRows(rowLayouts, opts);
  if (byRows) return byRows;

  if (colLayouts.length === 0 && rowLayouts.length === 0 && blockLayouts.length === 0) {
    return empty("Couldn't find the dates in this workbook (no row of dates across the top, and no \"Date\" column).");
  }
  // Show the fields of the newest sheet so admins can still pick required ones.
  const newest = colLayouts.slice().sort((a, b) => (a.dates.at(-1)!.date < b.dates.at(-1)!.date ? 1 : -1))[0];
  const hist = newest ? filledHistory(colLayouts, opts.date, opts.isOffDay) : null;
  const fields = newest
    ? newest.rows.map((r) => ({
        name: r.label,
        required: !NOT_STAFF_ROWS.test(r.label) && (hist!.days >= BOX_MIN_HISTORY ? hist!.filled.has(r.key) : !looksLikeHeading(r.label)),
      }))
    : [];
  return empty(`No entry dated ${fmt(opts.date)} yet.`, fields);
}

/**
 * Which worksheets are worth downloading in full, judged from their first rows
 * only: sheets whose dates reach within ~2 months of the day being checked
 * (the day itself plus its learning history), and table-style sheets with a
 * "Date" column. Keeps Graph traffic small for workbooks with a sheet per month.
 */
export function sheetsWorthReading(probes: MisSheetInput[], dates: string[], sheetName?: string | null): string[] {
  if (sheetName?.trim()) return probes.filter((p) => key(p.name) === key(sheetName)).map((p) => p.name);
  const newest = dates.slice().sort().at(-1)!;
  const oldest = new Date(toMs(dates.slice().sort()[0]) - 62 * DAY_MS).toISOString().slice(0, 10);
  const picked = new Set<string>();
  for (const p of probes) {
    const l = findColumnLayout(p);
    if (l) {
      if (l.dates.some((d) => d.date >= oldest && d.date <= newest)) picked.add(p.name);
    } else if (findRowLayout(p, null)) picked.add(p.name);
    else if (p.values.some((row) => blockStartDate(row ?? [], newest))) picked.add(p.name); // day blocks ("DATE: …" above each day)
  }
  if (picked.size === 0) return probes.slice(0, 5).map((p) => p.name);
  return [...picked];
}
