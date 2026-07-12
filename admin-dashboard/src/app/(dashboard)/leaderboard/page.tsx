'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { Trophy, Medal, Star } from 'lucide-react';
import { cn } from '@/utils/cn';

interface LeaderboardEntry {
  employeeId: string;
  employee: { firstName: string; lastName: string; department: { name: string } | null } | undefined;
  avgProductivityScore: number | null;
  avgReplyTimeSec: number | null;
  responseRate: number | null;
  emailsReplied: number;
}

function formatSeconds(sec: number | null) {
  if (sec === null) return '—';
  const minutes = Math.round(sec / 60);
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

const RANK_STYLE = [
  { icon: Trophy, ring: 'ring-beacon/30', chip: 'bg-beacon/15 text-beacon', glow: 'shadow-[0_0_0_1px_rgba(255,176,32,0.2),0_16px_32px_-16px_rgba(255,176,32,0.35)]' },
  { icon: Medal, ring: 'ring-gray-300/40', chip: 'bg-gray-200/60 dark:bg-gray-700/50 text-gray-500 dark:text-gray-300', glow: '' },
  { icon: Star, ring: 'ring-orange-300/40', chip: 'bg-orange-400/15 text-orange-500', glow: '' },
];

export default function LeaderboardPage() {
  const [range, setRange] = useState<'daily' | 'weekly' | 'monthly'>('weekly');

  const { data: leaderboard, isLoading } = useQuery({
    queryKey: ['leaderboard', range],
    queryFn: async () => {
      const { data } = await api.get<LeaderboardEntry[]>('/analytics/leaderboard', { params: { range } });
      return data;
    },
  });

  const top3 = leaderboard?.slice(0, 3) ?? [];

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="Flight Rankings"
        title="Leaderboard"
        subtitle="Top performers across the company."
        actions={
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
            className="px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 outline-none font-medium"
          >
            <option value="daily">Today</option>
            <option value="weekly">Last 7 Days</option>
            <option value="monthly">Last 30 Days</option>
          </select>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-card h-[220px] animate-pulse" />
          ))}
        </div>
      ) : !leaderboard || leaderboard.length === 0 ? (
        <div className="glass-card p-10 text-center text-gray-500">No analytics data for this range yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {top3.map((item, index) => {
              const style = RANK_STYLE[index];
              return (
                <div
                  key={item.employeeId}
                  className={cn('glass-card panel-ticks p-6 text-center relative overflow-hidden', style.glow)}
                >
                  <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
                  <div className="flex justify-center mb-4">
                    <div className={cn('w-16 h-16 rounded-full flex items-center justify-center ring-1', style.chip, style.ring)}>
                      <style.icon className="w-7 h-7" strokeWidth={1.75} />
                    </div>
                  </div>
                  <p className="eyebrow mb-1 opacity-70">Rank {index + 1}</p>
                  <h3 className="font-semibold text-lg">
                    {item.employee?.firstName} {item.employee?.lastName}
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">{item.employee?.department?.name ?? 'No department'}</p>
                  <div className="font-tabular text-3xl font-bold text-primary">
                    {item.avgProductivityScore !== null ? item.avgProductivityScore.toFixed(1) : '—'}
                  </div>
                  <p className="text-[11px] text-gray-400 uppercase tracking-wider font-semibold font-mono mt-1">
                    Productivity Score
                  </p>
                </div>
              );
            })}
          </div>

          <div className="glass-card overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800">
                  <th className="px-6 py-3.5">Rank</th>
                  <th className="px-6 py-3.5">Employee</th>
                  <th className="px-6 py-3.5">Score</th>
                  <th className="px-6 py-3.5">Response Rate</th>
                  <th className="px-6 py-3.5">Avg Reply Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {leaderboard.map((item, index) => (
                  <tr key={item.employeeId} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors">
                    <td className="px-6 py-4 font-tabular font-bold text-gray-400">#{index + 1}</td>
                    <td className="px-6 py-4 font-medium text-[13.5px]">
                      {item.employee?.firstName} {item.employee?.lastName}
                    </td>
                    <td className="px-6 py-4 font-tabular font-bold text-primary">
                      {item.avgProductivityScore !== null ? item.avgProductivityScore.toFixed(1) : '—'}
                    </td>
                    <td className="px-6 py-4 font-tabular text-sm">
                      {item.responseRate !== null ? `${Math.round(item.responseRate * 100)}%` : '—'}
                    </td>
                    <td className="px-6 py-4 font-tabular text-sm">{formatSeconds(item.avgReplyTimeSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
