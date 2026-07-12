'use client';

import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import { StatCard } from '@/components/dashboard/StatCard';
import { PageHeader } from '@/components/layout/PageHeader';
import { useDepartmentPerformance } from '@/hooks/useDepartmentPerformance';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp, Mail, Clock, Target } from 'lucide-react';

interface CompanyOverview {
  totalEmployees: number;
  employeesOnline: number;
  emailsToday: number;
  unreadEmails: number;
  pendingReplies: number;
  avgResponseTimeSec: number | null;
  aiActionsToday: number;
}

function formatSeconds(sec: number | null) {
  if (sec === null) return '—';
  const minutes = Math.round(sec / 60);
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

const chartTooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--surface-border)',
  borderRadius: '10px',
  fontSize: '13px',
  boxShadow: '0 8px 24px -8px rgba(11,13,20,0.25)',
};

export default function AnalyticsPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: async () => {
      const { data } = await api.get<CompanyOverview>('/analytics/company/overview');
      return data;
    },
  });

  const { chartData: departmentChartData, isLoading: departmentsLoading } = useDepartmentPerformance();

  if (isLoading) return <div className="p-8 text-gray-500">Loading analytics...</div>;

  // Response rate isn't a stored field — derived from today's counts, same
  // window the overview endpoint already computes.
  const responseRate =
    stats && stats.emailsToday > 0
      ? Math.round(((stats.emailsToday - stats.pendingReplies) / stats.emailsToday) * 100)
      : null;

  // Productivity score also isn't a company-level field yet — averaging the
  // per-department scores we already have is an honest stand-in until a
  // dedicated company-wide metric exists.
  const productivityScore = departmentChartData.length
    ? Math.round(departmentChartData.reduce((sum, d) => sum + d.score, 0) / departmentChartData.length)
    : null;

  const activityData = [
    { name: 'Received', value: stats?.emailsToday ?? 0 },
    { name: 'Unread', value: stats?.unreadEmails ?? 0 },
    { name: 'Pending reply', value: stats?.pendingReplies ?? 0 },
    { name: 'AI actions', value: stats?.aiActionsToday ?? 0 },
  ];

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="Instrumentation"
        title="Analytics"
        subtitle="Comprehensive email and performance analytics."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Emails Today" value={stats?.emailsToday ?? 0} icon={Mail} />
        <StatCard title="Avg Response Time" value={formatSeconds(stats?.avgResponseTimeSec ?? null)} icon={Clock} />
        <StatCard title="Response Rate" value={responseRate !== null ? `${responseRate}%` : '—'} icon={Target} />
        <StatCard
          title="Productivity Score"
          value={productivityScore !== null ? `${productivityScore}/100` : '—'}
          icon={TrendingUp}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6">
          <h2 className="text-[15px] font-semibold mb-6">Today's Email Activity</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={activityData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--surface-border)" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: '#9AA1B5' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={chartTooltipStyle} cursor={{ fill: 'rgba(59,91,255,0.06)' }} />
              <Bar dataKey="value" fill="#3B5BFF" radius={[6, 6, 0, 0]} maxBarSize={56} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-6">
          <h2 className="text-[15px] font-semibold mb-6">Department Performance</h2>
          {departmentsLoading ? (
            <div className="h-[300px] flex items-center justify-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
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

      <p className="text-xs text-gray-400">
        Response time distribution and performance-tier breakdowns from the previous version of this page were
        placeholder data with no backing query — removed rather than reintroduced. They're good Phase 8 candidates
        once there's a bucketed histogram endpoint to query.
      </p>
    </div>
  );
}
