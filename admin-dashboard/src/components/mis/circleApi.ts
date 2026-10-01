/** Types + helpers for the MIS Circle Report (backend/src/services/misCircle.ts). */
import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';

export type CircleTone = 'red' | 'green' | 'amber' | 'grey' | 'blue' | 'purple';

export interface CircleCode {
  code: string;
  label: string;
  meaning: string;
  isCircle: boolean;
  tone: CircleTone;
  manual: boolean;
}

export interface CircleCell {
  code: string | null;
  source: 'AUTO' | 'MANUAL' | 'CALENDAR' | null;
  note: string | null;
  pending: boolean;
  autoCode: string | null;
  /** Why the cell has this code, in plain words. */
  reason: string | null;
  /** "MIS check (automatic)", the admin's name, or "Calendar". */
  markedBy: string | null;
}

export interface CircleSummary {
  circles: number;
  pendingCircles: number;
  deductionDays: number;
  untilNextDeduction: number;
  message: string;
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
  status: { final: boolean; text: string };
}

export const CIRCLES_PER_DEDUCTION = 3;

export const TONE_CELL: Record<CircleTone, string> = {
  red: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300 font-bold',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  grey: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  purple: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
};

export function useCircleMonth(month: string | null) {
  return useQuery({
    queryKey: ['mis-circle', month ?? 'current'],
    queryFn: async () => (await api.get<CircleMonth>('/mis/circle', { params: month ? { month } : {} })).data,
  });
}

/** "2026-10" -> "October 2026" */
export function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "2026-10-05" -> "05-10-2026" */
export const dmy = (date: string) => date.split('-').reverse().join('-');

export function ordinal(n: number) {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suf}`;
}

export interface RedCircleEntry {
  date: string;
  number: number | null;
  pending: boolean;
  triggersDeduction: boolean;
  effect: string;
  reason: string;
  markedBy: string;
  note: string | null;
}

/** Same as the backend's redCircleEntries: every red circle in date order and what it did. */
export function redCircleEntries(row: CircleRow, data: CircleMonth): RedCircleEntry[] {
  const isCircle = new Set(data.codes.filter((c) => c.isCircle).map((c) => c.code));
  const out: RedCircleEntry[] = [];
  let n = 0;
  for (const d of data.days) {
    const c = row.cells[d.date];
    if (!c?.code || !isCircle.has(c.code)) continue;
    const base = { date: d.date, reason: c.reason ?? 'The MIS check found the MIS not submitted.', markedBy: c.markedBy ?? '', note: c.note };
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
    out.push({
      ...base,
      number: n,
      pending: false,
      triggersDeduction: triggers,
      effect: triggers
        ? `${ordinal(n)} red circle → ${ordinal(n / CIRCLES_PER_DEDUCTION)} day's salary deducted.`
        : `${ordinal(n)} red circle — ${CIRCLES_PER_DEDUCTION - (n % CIRCLES_PER_DEDUCTION)} more = ${ordinal(Math.ceil(n / CIRCLES_PER_DEDUCTION))} day's salary deducted.`,
    });
  }
  return out;
}

/** "7 red circles ÷ 3 = 2 days (1 left over …)" */
export function deductionCalculation(circles: number) {
  const days = Math.floor(circles / CIRCLES_PER_DEDUCTION);
  const rest = circles % CIRCLES_PER_DEDUCTION;
  if (circles === 0) return '0 red circles → 0 days.';
  const head = `${circles} red circle${circles === 1 ? '' : 's'} ÷ ${CIRCLES_PER_DEDUCTION} = ${days} day${days === 1 ? '' : 's'}`;
  if (days === 0) return `${head} — a deduction starts only at the ${ordinal(CIRCLES_PER_DEDUCTION)} red circle.`;
  return `${head}${rest ? ` (${rest} circle${rest === 1 ? '' : 's'} left over, counting towards the next day)` : ''}.`;
}

/**
 * Saves the month as an Excel file in the browser — everyone, or one person
 * when `employee` is given.
 */
export async function downloadCircleExcel(month: string, employee?: { id: string; name: string }) {
  const res = await api.get('/mis/circle/export', { params: { month, ...(employee ? { employeeId: employee.id } : {}) }, responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `MIS CIRCLE REPORT ${month}${employee ? ` - ${employee.name.toUpperCase().replace(/[^\w .-]+/g, ' ').trim()}` : ''}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
