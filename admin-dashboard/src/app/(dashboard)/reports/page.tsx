'use client';

import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { Download, Calendar, Filter, FileText, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department: { name: string } | null;
}

interface DailyRow {
  date: string;
  emailsReceived: number;
  emailsReplied: number;
  avgReplyTimeSec: number | null;
  productivityScore: number | null;
}

const RANGE_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90, year: 365 };
const RANGE_TO_PERIOD: Record<string, 'DAILY' | 'WEEKLY' | 'MONTHLY'> = {
  week: 'WEEKLY',
  month: 'MONTHLY',
  quarter: 'MONTHLY',
  year: 'MONTHLY',
};

interface GeneratedReport {
  id: string;
  scope: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  fileUrl: string | null;
  createdAt: string;
}

function summarize(rows: DailyRow[]) {
  const emailsReceived = rows.reduce((s, r) => s + r.emailsReceived, 0);
  const emailsReplied = rows.reduce((s, r) => s + r.emailsReplied, 0);
  const replyTimes = rows.map((r) => r.avgReplyTimeSec).filter((v): v is number => v !== null);
  const scores = rows.map((r) => r.productivityScore).filter((v): v is number => v !== null);
  return {
    emailsReceived,
    emailsReplied,
    avgResponseTimeMin: replyTimes.length
      ? Math.round(replyTimes.reduce((s, v) => s + v, 0) / replyTimes.length / 60)
      : 0,
    responseRate: emailsReceived > 0 ? Math.round((emailsReplied / emailsReceived) * 100) : 0,
    productivityScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0,
  };
}

export default function ReportsPage() {
  const [dateRange, setDateRange] = useState('week');

  const { data: employees, isLoading: employeesLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const { data } = await api.get<Employee[]>('/employees');
      return data;
    },
  });

  const days = RANGE_DAYS[dateRange] ?? 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const queryClient = useQueryClient();

  const { data: generatedReports } = useQuery({
    queryKey: ['reports'],
    queryFn: async () => {
      const { data } = await api.get<GeneratedReport[]>('/reports');
      return data;
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<GeneratedReport>('/reports', {
        scope: 'COMPANY',
        period: RANGE_TO_PERIOD[dateRange] ?? 'WEEKLY',
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports'] }),
  });

  const downloadReport = async (id: string) => {
    const response = await api.get(`/reports/${id}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mailpilot-report-${id}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const analyticsQueries = useQueries({
    queries: (employees ?? []).map((emp) => ({
      queryKey: ['employee-analytics', emp.id, dateRange],
      queryFn: async () => {
        const { data } = await api.get<{ days: DailyRow[] }>(`/analytics/employees/${emp.id}`, {
          params: { start: start.toISOString(), end: end.toISOString() },
        });
        return data.days;
      },
      enabled: Boolean(emp.id),
    })),
  });

  const isLoading = employeesLoading || analyticsQueries.some((q) => q.isLoading);
  if (isLoading) return <div className="p-8 text-gray-500">Loading reports...</div>;

  const reportData = (employees ?? []).map((emp, i) => {
    const summary = summarize(analyticsQueries[i]?.data ?? []);
    return {
      id: emp.id,
      name: `${emp.firstName} ${emp.lastName}`,
      email: emp.email,
      department: emp.department?.name ?? '—',
      ...summary,
    };
  });

  const avg = (key: 'responseRate' | 'avgResponseTimeMin' | 'productivityScore') =>
    reportData.length ? Math.round(reportData.reduce((s, r) => s + r[key], 0) / reportData.length) : 0;

  return (
    <div className="p-8 space-y-8 max-w-[1400px]">
      <PageHeader eyebrow="Flight Logs" title="Reports" subtitle="Generate and view detailed performance reports." />

      <div className="glass-card p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-400" />
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                className="px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 outline-none"
              >
                <option value="week">Last 7 Days</option>
                <option value="month">Last 30 Days</option>
                <option value="quarter">Last Quarter</option>
                <option value="year">Last Year</option>
              </select>
            </div>

            <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
              <Filter className="w-4 h-4" />
              More Filters
            </button>
          </div>

          <button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="btn-primary flex items-center gap-2"
          >
            {generateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Generate CSV Report
          </button>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40">
                <th className="px-6 py-3.5">Employee</th>
                <th className="px-6 py-3.5">Department</th>
                <th className="px-6 py-3.5">Received</th>
                <th className="px-6 py-3.5">Replied</th>
                <th className="px-6 py-3.5">Avg Response</th>
                <th className="px-6 py-3.5">Response Rate</th>
                <th className="px-6 py-3.5">Productivity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {reportData.map((report) => (
                <tr key={report.id} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                        {report.name[0]}
                      </div>
                      <div>
                        <div className="font-medium text-[13.5px]">{report.name}</div>
                        <div className="text-xs text-gray-500">{report.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm">{report.department}</td>
                  <td className="px-6 py-4 text-sm font-tabular font-medium">{report.emailsReceived}</td>
                  <td className="px-6 py-4 text-sm font-tabular">{report.emailsReplied}</td>
                  <td className="px-6 py-4 text-sm font-tabular">{report.avgResponseTimeMin}m</td>
                  <td className="px-6 py-4">
                    <span className="badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-tabular">
                      {report.responseRate}%
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${report.productivityScore}%` }} />
                      </div>
                      <span className="text-sm font-tabular font-medium">{report.productivityScore}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="glass-card panel-ticks p-6">
          <div className="text-[13px] text-gray-500 mb-2">Average Response Rate</div>
          <div className="font-tabular text-3xl font-semibold">{avg('responseRate')}%</div>
        </div>
        <div className="glass-card panel-ticks p-6">
          <div className="text-[13px] text-gray-500 mb-2">Average Response Time</div>
          <div className="font-tabular text-3xl font-semibold">{avg('avgResponseTimeMin')}m</div>
        </div>
        <div className="glass-card panel-ticks p-6">
          <div className="text-[13px] text-gray-500 mb-2">Average Productivity</div>
          <div className="font-tabular text-3xl font-semibold">{avg('productivityScore')}%</div>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <div className="p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-[15px] font-semibold">Recent Reports</h2>
          <p className="text-sm text-gray-500 mt-1">
            Generated on demand above, plus one automatic company-wide weekly report the scheduler creates every
            Monday.
          </p>
        </div>
        {!generatedReports || generatedReports.length === 0 ? (
          <p className="text-sm text-gray-400 px-6 py-8 text-center">No reports generated yet.</p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {generatedReports.map((report) => (
              <div key={report.id} className="flex items-center justify-between px-6 py-3.5 hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-lg shrink-0">
                    <FileText className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">
                      {report.scope} · {report.period}
                    </div>
                    <div className="text-xs font-tabular text-gray-500">
                      {new Date(report.periodStart).toLocaleDateString()} –{' '}
                      {new Date(report.periodEnd).toLocaleDateString()} · generated{' '}
                      {new Date(report.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => downloadReport(report.id)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
