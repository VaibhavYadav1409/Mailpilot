/** Types + hooks for the MIS auto-check (backend/src/routes/mis.ts). */
import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import type { MisBlank, MisStatus } from '@/components/mis/misUi';

export type { MisStatus };

export interface MisConnection {
  connected: boolean;
  accountEmail?: string;
  status?: 'CONNECTED' | 'NEEDS_RECONNECT';
  lastError?: string | null;
}

export interface MisCheck {
  status: MisStatus;
  rowCount: number;
  missingColumns: string[];
  blanks: MisBlank[];
  note: string | null;
  completedAt: string | null;
  checkedAt: string;
}

export interface MisSource {
  id: string;
  employeeId: string;
  label: string;
  shareUrl: string;
  fileName: string | null;
  webUrl: string;
  sheetName: string | null;
  requiredColumns: string[] | null; // null = learned automatically
  checkedBy: string | null;
  approvedBy: string | null;
  fields: { name: string; required: boolean }[];
  lastCheckedAt: string | null;
  lastError: string | null;
  /** When the Excel file was last saved, and by whom (from OneDrive / SharePoint). */
  fileSavedAt?: string | null;
  fileSavedBy?: string | null;
  /** [last working day, the working day before] — Sundays, 2nd/4th Saturdays and holidays are skipped. */
  days: { date: string; label: string; check: MisCheck | null }[];
}

export function useMisConnection() {
  return useQuery({
    queryKey: ['mis-connection'],
    queryFn: async () => (await api.get<MisConnection>('/mis/connection')).data,
  });
}

export function useMisSources() {
  return useQuery({
    queryKey: ['mis-sources'],
    queryFn: async () => (await api.get<{ sources: MisSource[] }>('/mis/sources')).data.sources,
  });
}

/** One file's status for day i (0 = last working day, 1 = the one before). */
export function sourceStatus(s: MisSource, i: number): MisStatus {
  return s.days[i]?.check?.status ?? (s.lastError ? 'ERROR' : 'NOT_CHECKED');
}

/** A person's status for day i across all their files (same rule as the backend). */
export function personStatus(sources: MisSource[], i: number): { status: MisStatus; blanks: number } | null {
  if (sources.length === 0) return null;
  const all = sources.map((s) => sourceStatus(s, i));
  const st = all.filter((x) => x !== 'OFF');
  const blanks = sources.reduce((n, s) => n + (s.days[i]?.check?.missingColumns.length ?? 0), 0);
  const status: MisStatus =
    st.length === 0
      ? 'OFF'
      : st.every((x) => x === 'COMPLETE')
      ? 'COMPLETE'
      : st.includes('INCOMPLETE')
      ? 'INCOMPLETE'
      : st.includes('MISSING')
      ? 'MISSING'
      : st.includes('ERROR')
      ? 'ERROR'
      : 'NOT_CHECKED';
  return { status, blanks };
}
