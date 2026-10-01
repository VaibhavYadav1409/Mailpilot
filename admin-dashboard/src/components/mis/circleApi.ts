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

/** Saves the month as an Excel file in the browser. */
export async function downloadCircleExcel(month: string) {
  const res = await api.get('/mis/circle/export', { params: { month }, responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `MIS CIRCLE REPORT ${month}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
