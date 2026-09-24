'use client';

import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Download,
  FileText,
  Loader2,
  MessageSquareWarning,
  Percent,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/dashboard/StatCard';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types — mirror backend/src/services/msiService.ts (getAdminOverview)
// ---------------------------------------------------------------------------

interface MsiReport {
  id: string;
  reportDate: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  importantMessage: string | null;
  hasImportantMessage: boolean;
  submittedAt: string;
  updatedAt: string;
}

interface MsiEmployeeStatus {
  employeeId: string;
  name: string;
  email: string;
  department: string | null;
  role: string;
  submitted: boolean;
  report: MsiReport | null;
}

interface MsiOverview {
  date: string;
  today: string;
  timezone: string;
  availableDates: string[];
  retentionDays: number;
  expired: boolean;
  summary: { totalEmployees: number; submitted: number; notSubmitted: number; important: number; submissionRate: number };
  submitted: MsiEmployeeStatus[];
  notSubmitted: MsiEmployeeStatus[];
}

type Filter = 'all' | 'submitted' | 'not_submitted' | 'important';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'not_submitted', label: 'Not Submitted' },
  { key: 'important', label: 'Important Updates' },
];

// ---------------------------------------------------------------------------
// Formatting — dates are business-day strings from the server; times are
// shown in the server's business timezone so every viewer sees the same thing.
// ---------------------------------------------------------------------------

function formatLongDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShortDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTime(iso: string, tz: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ---------------------------------------------------------------------------

export default function MsiReportsPage() {
  const [date, setDate] = useState<string | null>(null); // null = server's "today"
  const [filter, setFilter] = useState<Filter>('all');
  const [viewing, setViewing] = useState<MsiEmployeeStatus | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const importantRef = useRef<HTMLDivElement>(null);

  // One request per date; filters are applied client-side on that response.
  // Live refresh comes from the 'msi:updated' socket event (useLiveUpdates),
  // not polling.
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['msi-admin', date ?? 'today'],
    queryFn: async () => {
      const { data } = await api.get<MsiOverview>('/msi/admin/reports', { params: date ? { date } : {} });
      return data;
    },
  });

  const forbidden = (error as { response?: { status?: number } } | null)?.response?.status === 403;

  const importantList = useMemo(() => (data?.submitted ?? []).filter((s) => s.report?.hasImportantMessage), [data]);
  const showSubmitted = filter === 'all' || filter === 'submitted' || filter === 'important';
  const showNotSubmitted = filter === 'all' || filter === 'not_submitted';
  const submittedRows = filter === 'important' ? importantList : data?.submitted ?? [];

  const download = async (row: MsiEmployeeStatus) => {
    if (!row.report) return;
    setDownloadError(null);
    setDownloadingId(row.report.id);
    try {
      const response = await api.get(`/msi/admin/reports/${row.report.id}/download`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: row.report.fileType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = row.report.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setDownloadError(`Couldn't download ${row.name}'s report — it may have been removed by the 2-day retention policy.`);
    } finally {
      setDownloadingId(null);
    }
  };

  const showImportant = () => {
    setFilter('important');
    requestAnimationFrame(() => importantRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const today = data?.today;
  const selected = data?.date ?? date ?? '';

  if (forbidden) {
    return (
      <div className="p-8">
        <div className="glass-card p-8 max-w-lg">
          <h1 className="text-xl font-semibold mb-2">Admin access required</h1>
          <p className="text-gray-500 text-sm">MSI Daily Reports are visible to CEO, COO and Admin accounts only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 lg:space-y-8 max-w-[1400px]">
      <PageHeader
        eyebrow="MSI"
        title="MSI Daily Work Report"
        subtitle={data ? `Date: ${formatLongDate(data.date)} · reports are deleted automatically after ${data.retentionDays} days` : 'Daily employee work reports'}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {data?.availableDates.map((d, i) => (
              <button
                key={d}
                onClick={() => setDate(i === 0 ? null : d)}
                className={cn(
                  'px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
                  selected === d
                    ? 'bg-primary text-white border-primary'
                    : 'border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900'
                )}
              >
                {i === 0 ? 'Today' : 'Yesterday'}
              </button>
            ))}
            <label className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm">
              <CalendarDays className="w-4 h-4 text-gray-400" />
              <input
                type="date"
                value={selected}
                max={today}
                onChange={(e) => e.target.value && setDate(e.target.value === today ? null : e.target.value)}
                className="bg-transparent outline-none font-tabular"
                aria-label="Report date"
              />
            </label>
          </div>
        }
      />

      {isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-[120px] animate-pulse" />
          ))}
        </div>
      )}

      {isError && !forbidden && (
        <div className="glass-card p-6 flex items-center justify-between gap-4">
          <p className="text-sm text-gray-500">Couldn't load MSI reports. Please try again.</p>
          <button onClick={() => refetch()} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {data && data.expired && (
        <div className="glass-card p-10 text-center">
          <ClipboardList className="w-10 h-10 mx-auto text-gray-300 dark:text-gray-700 mb-3" />
          <h2 className="text-lg font-semibold">No reports available for {formatLongDate(data.date)}</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
            MSI reports are temporary. Reports, files and important messages are deleted automatically{' '}
            {data.retentionDays} days after their date, so only today and yesterday can be viewed.
          </p>
          <button onClick={() => setDate(null)} className="btn-primary mt-5">
            Go to today
          </button>
        </div>
      )}

      {data && !data.expired && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <StatCard title="Employees" value={data.summary.totalEmployees} icon={Users} />
            <StatCard title="Submitted" value={data.summary.submitted} icon={CheckCircle2} />
            <StatCard title="Not Submitted" value={data.summary.notSubmitted} icon={XCircle} />
            <StatCard title="Important Updates" value={data.summary.important} icon={MessageSquareWarning} />
            <StatCard title="Submission Rate" value={`${data.summary.submissionRate}%`} icon={Percent} live={data.date === data.today} />
          </div>

          {data.summary.important > 0 && (
            <button
              onClick={showImportant}
              className="w-full rounded-2xl border px-5 py-4 flex items-center gap-3 text-left border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 hover:bg-amber-100/70 dark:hover:bg-amber-500/10 transition-colors"
            >
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
              <span className="font-semibold text-amber-800 dark:text-amber-300">
                ⚠ {data.summary.important} Important Employee Update{data.summary.important === 1 ? '' : 's'}
              </span>
              <span className="ml-auto text-sm text-amber-700 dark:text-amber-400">View messages →</span>
            </button>
          )}

          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors',
                  filter === f.key
                    ? 'bg-primary text-white border-primary'
                    : 'border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900'
                )}
              >
                {f.label}
                {f.key === 'important' && data.summary.important > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-amber-500 text-white text-[11px]">
                    {data.summary.important}
                  </span>
                )}
              </button>
            ))}
            {isFetching && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          </div>

          {downloadError && (
            <div className="glass-card px-5 py-3 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
              <XCircle className="w-4 h-4" /> {downloadError}
              <button onClick={() => setDownloadError(null)} className="ml-auto text-gray-400 hover:text-gray-600" aria-label="Dismiss">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Submitted */}
          {showSubmitted && (
            <section className="glass-card overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <h2 className="text-[15px] font-semibold">
                  {filter === 'important' ? 'Submitted with Important Updates' : 'Submitted'} — {submittedRows.length}{' '}
                  {submittedRows.length === 1 ? 'employee' : 'employees'}
                </h2>
              </div>
              {submittedRows.length === 0 ? (
                <p className="text-sm text-gray-400 px-6 py-8 text-center">
                  {filter === 'important' ? 'No important updates for this date.' : 'Nobody has submitted a report for this date yet.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left min-w-[860px]">
                    <thead>
                      <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40">
                        <th className="px-5 py-3">Employee</th>
                        <th className="px-5 py-3">Department</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Submitted</th>
                        <th className="px-5 py-3">File</th>
                        <th className="px-5 py-3">Important</th>
                        <th className="px-5 py-3 text-right">Report</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {submittedRows.map((row) => (
                        <tr key={row.employeeId} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                                {initials(row.name)}
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-[13.5px] truncate">{row.name}</div>
                                <div className="text-xs text-gray-500 truncate">{row.email}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-sm">{row.department ?? '—'}</td>
                          <td className="px-5 py-3.5">
                            <span className="badge whitespace-nowrap bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">✓ Submitted</span>
                          </td>
                          <td className="px-5 py-3.5 text-sm font-tabular whitespace-nowrap">{formatTime(row.report!.submittedAt, data.timezone)}</td>
                          <td className="px-5 py-3.5 text-sm">
                            <div className="flex items-center gap-2 max-w-[220px]">
                              <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                              <span className="truncate" title={row.report!.fileName}>
                                {row.report!.fileName}
                              </span>
                              <span className="text-xs text-gray-400 shrink-0">{formatSize(row.report!.fileSize)}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            {row.report!.hasImportantMessage ? (
                              <button
                                onClick={() => setViewing(row)}
                                className="badge whitespace-nowrap bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                              >
                                ⚠ Yes · View Message
                              </button>
                            ) : (
                              <span className="text-sm text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <button
                              onClick={() => download(row)}
                              disabled={downloadingId === row.report!.id}
                              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-primary hover:bg-primary/10 rounded-lg transition-colors disabled:opacity-50"
                            >
                              {downloadingId === row.report!.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4" />
                              )}
                              Download Report
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* Not submitted */}
          {showNotSubmitted && (
            <section className="glass-card overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-500" />
                <h2 className="text-[15px] font-semibold">
                  Not Submitted — {data.notSubmitted.length} {data.notSubmitted.length === 1 ? 'employee' : 'employees'}
                </h2>
              </div>
              {data.notSubmitted.length === 0 ? (
                <p className="text-sm text-emerald-600 dark:text-emerald-400 px-6 py-8 text-center font-medium">
                  ✓ Everyone has submitted their report for this date.
                </p>
              ) : (
                <ol className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.notSubmitted.map((row, i) => (
                    <li key={row.employeeId} className="px-5 py-3 flex items-center gap-4">
                      <span className="w-6 text-right text-sm font-tabular text-gray-400">{i + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-[13.5px] truncate">{row.name}</div>
                        <div className="text-xs text-gray-500 truncate">{row.email}</div>
                      </div>
                      <span className="text-sm text-gray-600 dark:text-gray-400 w-40 truncate hidden sm:block">
                        {row.department ?? '—'}
                      </span>
                      <span className="badge whitespace-nowrap bg-red-500/10 text-red-600 dark:text-red-400">✗ Not Submitted</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          {/* Important messages */}
          {(filter === 'all' || filter === 'important') && (
            <section ref={importantRef} className="space-y-3 scroll-mt-6">
              <h2 className="text-[15px] font-semibold flex items-center gap-2">
                <MessageSquareWarning className="w-4 h-4 text-amber-500" /> Important Messages
              </h2>
              {importantList.length === 0 ? (
                <div className="glass-card px-6 py-8 text-center text-sm text-gray-400">No important messages for this date.</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {importantList.map((row) => (
                    <article key={row.employeeId} className="glass-card p-5 border-l-4 border-l-red-500">
                      <p className="text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400 mb-2">
                        🔴 Important Update
                      </p>
                      <p className="text-sm">
                        <span className="font-semibold">{row.name}</span>
                        <span className="text-gray-500"> · {row.department ?? 'No department'}</span>
                      </p>
                      <blockquote className="mt-2 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words">
                        “{row.report!.importantMessage}”
                      </blockquote>
                      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-500">
                        <span className="font-tabular">
                          {formatShortDate(row.report!.reportDate)} · {formatTime(row.report!.updatedAt, data.timezone)}
                        </span>
                        <button onClick={() => download(row)} className="inline-flex items-center gap-1.5 text-primary font-medium hover:underline">
                          <Download className="w-3.5 h-3.5" /> Report
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* View message dialog */}
      {viewing?.report && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => setViewing(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="glass-card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">⚠ Important Update</p>
                <h3 className="text-lg font-semibold mt-1">{viewing.name}</h3>
                <p className="text-sm text-gray-500">
                  {viewing.department ?? 'No department'} · {formatShortDate(viewing.report.reportDate)} ·{' '}
                  {formatTime(viewing.report.updatedAt, data?.timezone ?? 'Asia/Kolkata')}
                </p>
              </div>
              <button onClick={() => setViewing(null)} className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <blockquote className="mt-4 p-4 rounded-lg bg-gray-50 dark:bg-gray-900 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words">
              {viewing.report.importantMessage}
            </blockquote>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setViewing(null)} className="btn-secondary">
                Close
              </button>
              <button onClick={() => download(viewing)} className="btn-primary flex items-center gap-2">
                <Download className="w-4 h-4" /> Download Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
