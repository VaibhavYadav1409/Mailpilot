'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileSpreadsheet } from 'lucide-react';
import api from '@/services/api';
import { shortDay } from './misUi';

interface Summary {
  date: string;
  expired: boolean;
  summary: { totalEmployees: number; submitted: number; incomplete: number; notFilled: number; submissionRate: number };
}

/** Yesterday's MIS at a glance on the dashboard (Admin+ only; hidden for others). */
export function MisSnapshot() {
  const { data, isError } = useQuery({
    queryKey: ['msi-admin-summary'],
    queryFn: async () => (await api.get<Summary>('/msi/admin/summary')).data,
    retry: false,
    refetchInterval: 5 * 60_000,
  });
  if (isError || !data || data.expired || data.summary.totalEmployees === 0) return null;
  const s = data.summary;
  return (
    <Link href="/msi-reports" className="glass-card p-5 flex flex-wrap items-center gap-x-6 gap-y-3 hover:ring-1 hover:ring-primary/30 transition">
      <div className="flex items-center gap-3">
        <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
        <div>
          <p className="text-sm font-semibold">Yesterday’s MIS</p>
          <p className="text-xs text-gray-500">{shortDay(data.date)} · {s.submissionRate}% submitted</p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="text-emerald-700 dark:text-emerald-400"><b>{s.submitted}</b> submitted</span>
        <span className="text-amber-700 dark:text-amber-400"><b>{s.incomplete}</b> incomplete</span>
        <span className="text-red-600 dark:text-red-400"><b>{s.notFilled}</b> not submitted</span>
      </div>
      <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
        Open MIS Reports <ArrowRight className="w-4 h-4" />
      </span>
    </Link>
  );
}
