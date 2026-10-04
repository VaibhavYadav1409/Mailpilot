/**
 * MIS auto-check — pure spreadsheet logic (no I/O, unit-tested).
 *
 * Decides, for one MIS workbook and one business date, whether the person has
 * filled in that day's MIS:
 *   COMPLETE   — the day exists in the sheet and every required field has something in it
 *   INCOMPLETE — the day exists but some required fields are blank
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
 *    must have every required particular filled.
 *    Required particulars are learned from history: a row is required when it
 *    was filled on at least half of the last 10 working days (so section
 *    headings like "A  DP Account" and occasional rows like "Weekly Checking"
 *    are not demanded every day). An admin can pin an explicit list instead.
 *
 * 2. DAY ROWS: a normal table with a "Date" column; the day's rows must have
 *    every named column filled (except S.No / Remarks-style columns).
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
  layout: "DAY_COLUMNS" | "DAY_ROWS" | null;
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
  return v === null || v === undefined || String(v).trim() === "";
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

/** Parses a typed date, day first. Leading date only ("13/08/2026 - leave" works). */
export function parseTextDate(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-/. ]+([a-z]{3,9})\.?[-/. ]+(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3)]) return ymd(+m[3], MONTHS[m[2].slice(0, 3)], +m[1]);
  m = /^([a-z]{3,9})\.?[-/. ]+(\d{1,2})[-/. ]+(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3)]) return ymd(+m[3], MONTHS[m[1].slice(0, 3)], +m[2]);
  return null;
}

/** Any single cell -> date, no context. */
export function parseMisDate(raw: unknown): string | null {
  if (typeof raw === "number") return excelSerialToDate(raw);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = parseTextDate(raw);
  if (t) return t;
  if (/^\d{5}(\.\d+)?$/.test(raw.trim())) return excelSerialToDate(Number(raw));
  return null;
}

interface DateCell {
  col: number;
  date: string;
}

/**
 * Reads a header row of dates. Excel serials whose day is ≤ 12 may be
 * month/day-swapped; each is resolved to whichever reading sits closest to
 * its neighbours, since the dates run left to right in order.
 */
export function readDateRow(row: unknown[], fromCol = 0): DateCell[] {
  type Raw = { col: number; options: string[] };
  const raws: Raw[] = [];
  for (let c = fromCol; c < row.length; c++) {
    const v = row[c];
    if (typeof v === "number") {
      const d = excelSerialToDate(v);
      if (!d) continue;
      const [y, m, day] = d.split("-").map(Number);
      const swapped = day <= 12 && day !== m ? ymd(y, day, m) : null;
      raws.push({ col: c, options: swapped ? [d, swapped] : [d] });
    } else if (typeof v === "string") {
      const d = parseMisDate(v);
      if (d) raws.push({ col: c, options: [d] });
    }
  }
  if (raws.length === 0) return [];

  const anchors = raws.filter((r) => r.options.length === 1);
  if (anchors.length === 0) {
    // Nothing unambiguous: take the reading (as typed vs swapped) that makes the dates most sequential.
    const spread = (pick: number) =>
      raws.reduce((sum, r, i) => (i === 0 ? 0 : sum + Math.abs(toMs(r.options[Math.min(pick, r.options.length - 1)]) - toMs(raws[i - 1].options[Math.min(pick, raws[i - 1].options.length - 1)]))), 0);
    const pick = spread(1) < spread(0) ? 1 : 0;
    return raws.map((r) => ({ col: r.col, date: r.options[Math.min(pick, r.options.length - 1)] }));
  }

  const out: DateCell[] = [];
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

const HISTORY_DAYS = 10;
/**
 * This many blank entries among the particulars the person usually fills
 * (learned from past days, or the admin's list) = the MIS wasn't filled at
 * all for that day, rather than "almost done".
 */
export const NOT_FILLED_BLANKS = 20;
const REQUIRED_FILL_RATIO = 0.5;

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

/** How often each particular was filled on the most recent working days before `date`, across all sheets. */
function learnRequired(layouts: ColumnLayout[], date: string, isOffDay?: (date: string) => boolean): Map<string, boolean> {
  const allDates = new Set<string>();
  for (const l of layouts) for (const d of l.dates) if (d.date < date && !isOffDay?.(d.date)) allDates.add(d.date);
  const recent = [...allDates].sort().reverse().slice(0, HISTORY_DAYS);
  const cols = recent.map((d) => sheetForDate(layouts, d)).filter((x): x is { layout: ColumnLayout; cols: number[] } => x !== null);

  const stats = new Map<string, { seen: number; filled: number }>();
  for (const { layout, cols: cs } of cols) {
    for (const row of layout.rows) {
      const s = stats.get(row.key) ?? { seen: 0, filled: 0 };
      s.seen++;
      if (cs.some((c) => !isBlank(cell(layout.sheet, row.index, c)))) s.filled++;
      stats.set(row.key, s);
    }
  }
  const required = new Map<string, boolean>();
  for (const [k, s] of stats) required.set(k, s.seen > 0 && s.filled / s.seen >= REQUIRED_FILL_RATIO);
  return required;
}

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

function checkColumns(layouts: ColumnLayout[], opts: MisCheckOptions): MisCheckResult | null {
  const owner = sheetForDate(layouts, opts.date);
  if (!owner) return null;
  const todays = [owner.layout];

  const configured = opts.requiredColumns?.length ? opts.requiredColumns : null;
  const learned = configured ? null : learnRequired(layouts, opts.date, opts.isOffDay);
  const hasHistory = !!learned && learned.size > 0;

  const blanks: MisBlank[] = [];
  const missing = new Set<string>();
  const fields: MisField[] = [];
  let filled = 0;
  for (const l of todays) {
    const cols = owner.cols;
    for (const row of l.rows) {
      const required = configured
        ? matchesConfigured(row.label, configured)
        : NOT_STAFF_ROWS.test(row.label)
        ? false
        : hasHistory
        ? learned!.get(row.key) === true
        : !looksLikeHeading(row.label);
      fields.push({ name: row.label, required });
      if (!required) continue;
      if (cols.some((c) => !isBlank(cell(l.sheet, row.index, c)))) {
        filled++;
      } else {
        missing.add(row.label);
        blanks.push({ sheet: l.sheet.name, cell: a1(l.sheet, row.index, cols[cols.length - 1]), field: row.label });
      }
    }
  }

  // Nothing filled, or NOT_FILLED_BLANKS+ of the usual particulars left
  // empty: that's an unfilled MIS, not a nearly-done one — report it as not
  // submitted instead of listing dozens of blanks.
  if (filled === 0 || blanks.length >= NOT_FILLED_BLANKS) {
    return {
      status: "MISSING",
      layout: "DAY_COLUMNS",
      sheet: todays[0].sheet.name,
      filledCount: filled,
      missingFields: [],
      blanks: [],
      blankCount: blanks.length,
      fields,
      note:
        filled === 0 && missing.size === 0
          ? "The day's column exists but no required fields were found."
          : `Not filled for ${fmt(opts.date)} — ${blanks.length} of ${filled + blanks.length} usual entries are blank.`,
    };
  }
  return {
    status: missing.size > 0 ? "INCOMPLETE" : "COMPLETE",
    layout: "DAY_COLUMNS",
    sheet: todays[0].sheet.name,
    filledCount: filled,
    missingFields: [...missing],
    blanks: blanks.slice(0, 50),
    blankCount: blanks.length,
    fields,
    note: !configured && !hasHistory ? "No earlier days to learn from — every particular is required." : null,
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

    let carried: string | null = null;
    for (let r = l.headerIndex + 1; r < l.sheet.values.length; r++) {
      const raw = cell(l.sheet, r, l.dateIndex);
      let rowDate: string | null;
      if (!isBlank(raw)) {
        rowDate = parseMisDate(raw);
        carried = rowDate;
      } else {
        // Blank date: belongs to the day above it, but only if the row has data.
        rowDate = l.columns.some((c) => c.idx !== l.dateIndex && !isBlank(cell(l.sheet, r, c.idx))) ? carried : null;
      }
      if (rowDate !== opts.date) continue;
      rowsToday++;
      sheet ??= l.sheet.name;
      for (const c of required) {
        if (isBlank(cell(l.sheet, r, c.idx))) {
          missing.add(c.name);
          blanks.push({ sheet: l.sheet.name, cell: a1(l.sheet, r, c.idx), field: c.name });
        }
      }
    }
  }
  if (rowsToday === 0) return null;
  return {
    status: missing.size ? "INCOMPLETE" : "COMPLETE",
    layout: "DAY_ROWS",
    sheet,
    filledCount: rowsToday,
    missingFields: [...missing],
    blanks: blanks.slice(0, 50),
    fields: [...fields].map(([name, required]) => ({ name, required })),
    note: null,
  };
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

  const colLayouts = candidates.map(findColumnLayout).filter((l): l is ColumnLayout => l !== null);
  const byColumns = checkColumns(colLayouts, opts);
  if (byColumns) return byColumns;

  const rowLayouts = candidates
    .map((s) => findRowLayout(s, opts.dateColumn?.trim() || null))
    .filter((l): l is RowLayout => l !== null);
  const byRows = checkRows(rowLayouts, opts);
  if (byRows) return byRows;

  if (colLayouts.length === 0 && rowLayouts.length === 0) {
    return empty("Couldn't find the dates in this workbook (no row of dates across the top, and no \"Date\" column).");
  }
  // Show the fields of the newest sheet so admins can still pick required ones.
  const newest = colLayouts.slice().sort((a, b) => (a.dates.at(-1)!.date < b.dates.at(-1)!.date ? 1 : -1))[0];
  const learned = newest ? learnRequired(colLayouts, opts.date, opts.isOffDay) : null;
  const fields = newest ? newest.rows.map((r) => ({ name: r.label, required: learned?.get(r.key) === true })) : [];
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
  }
  if (picked.size === 0) return probes.slice(0, 5).map((p) => p.name);
  return [...picked];
}
