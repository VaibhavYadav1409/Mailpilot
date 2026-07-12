'use client';

import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import { StatCard } from '@/components/dashboard/StatCard';
import { PageHeader } from '@/components/layout/PageHeader';
import { useDepartmentPerformance } from '@/hooks/useDepartmentPerformance';
import { Users, Mail, Clock, CheckCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface CompanyOverview {
  totalEmployees: number;
  employeesOnline: number;
  employeesOffline: number;
  connectedGmailAccounts: number;
  emailsToday: number;
  unreadEmails: number;
  pendingReplies: number;
  avgResponseTimeSec: number | null;
  aiActionsToday: number;
}

function formatSeconds(sec: number | null) {
  if (sec === null) return '—';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

const chartTooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--surface-border)',
  borderRadius: '10px',
  fontSize: '13px',
  boxShadow: '0 8px 24px -8px rgba(11,13,20,0.25)',
};

export default function DashboardPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: async () => {
      const { data } = await api.get<CompanyOverview>('/analytics/company/overview');
      return data;
    },
    refetchInterval: 30_000,
  });

  const { chartData: departmentChartData, isLoading: departmentsLoading } = useDepartmentPerformance();

  if (isLoading) {
    return (
      <div className="p-8 space-y-8">
        <div className="h-8 w-48 bg-gray-100 dark:bg-gray-900 rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass-card h-[120px] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const activityData = [
    { name: 'Received', value: stats?.emailsToday ?? 0 },
    { name: 'Unread', value: stats?.unreadEmails ?? 0 },
    { name: 'Pending reply', value: stats?.pendingReplies ?? 0 },
    { name: 'AI actions', value: stats?.aiActionsToday ?? 0 },
  ];

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="Mission Control"
        title="Dashboard"
        subtitle="Welcome back — here's what's happening across the fleet today."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Total Employees" value={stats?.totalEmployees ?? 0} icon={Users} />
        <StatCard title="Online Now" value={stats?.employeesOnline ?? 0} icon={CheckCircle} live />
        <StatCard title="Emails Today" value={stats?.emailsToday ?? 0} icon={Mail} />
        <StatCard title="Avg Response Time" value={formatSeconds(stats?.avgResponseTimeSec ?? null)} icon={Clock} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6 h-[400px]">
          <h3 className="text-[15px] font-semibold mb-6">Today's Email Activity</h3>
          {/*
            The old chart here was "Email Trends" over time, backed by an
            empty array (data={[]}) — there was never a real endpoint behind
            it. There's still no company-wide day-by-day trend endpoint, so
            rather than reintroduce a fake time series, this shows today's
            real counts. A proper trend line is a good Phase 8 candidate once
            there's a bucketed-by-day company rollup to query.
          */}
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activityData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--surface-border)" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: 'rgba(59,91,255,0.06)' }} />
              <Bar dataKey="value" fill="#3B5BFF" radius={[6, 6, 0, 0]} maxBarSize={56} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-6 h-[400px]">
          <h3 className="text-[15px] font-semibold mb-6">Department Performance</h3>
          {departmentsLoading ? (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">Loading…</div>
          ) : departmentChartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">
              No department analytics yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={departmentChartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--surface-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: 'rgba(255,176,32,0.08)' }} />
                <Bar dataKey="score" fill="#FFB020" radius={[6, 6, 0, 0]} maxBarSize={56} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
