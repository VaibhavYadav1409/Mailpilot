/** Types + hooks for the MIS auto-check (backend/src/routes/mis.ts). */
import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';

export type MisStatus = 'COMPLETE' | 'INCOMPLETE' | 'MISSING' | 'ERROR' | 'NOT_CHECKED';

export interface MisConnection {
  connected: boolean;
  accountEmail?: string;
  status?: 'CONNECTED' | 'NEEDS_RECONNECT';
  lastError?: string | null;
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
  fields: { name: string; required: boolean }[];
  lastCheckedAt: string | null;
  lastError: string | null;
  today: {
    status: MisStatus;
    rowCount: number;
    missingColumns: string[];
    blanks: { sheet: string; cell: string; field: string }[];
    note: string | null;
    completedAt: string | null;
    checkedAt: string;
  } | null;
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

export function misStatusLabel(status: MisStatus | undefined, blanks = 0): { text: string; cls: string } {
  switch (status) {
    case 'COMPLETE':
      return { text: '✓ Filled today', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' };
    case 'INCOMPLETE':
      return { text: `⚠ ${blanks} blank`, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' };
    case 'MISSING':
      return { text: '✗ Not started', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' };
    case 'ERROR':
      return { text: "Can't read file", cls: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300' };
    default:
      return { text: 'Not checked yet', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-500' };
  }
}
