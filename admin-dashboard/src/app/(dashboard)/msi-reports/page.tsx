'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarOff,
  CheckCircle2,
  ClipboardList,
  Download,
  Loader2,
  MessageSquareWarning,
  Percent,
  RefreshCw,
  Search,
  TriangleAlert,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/dashboard/StatCard';
import { cn } from '@/utils/cn';
import Link from 'next/link';
import { CIRCLES_PER_DEDUCTION, useCircleMonth, type CircleSummary } from '@/components/mis/circleApi';
import {
  BlankList,
  FileSaved,
  MisLegend,
  OpenLinks,
  Reviewers,
  StatusBadge,
  TONE,
  dmy,
  explainDay,
  shortDay,
  toneOf,
  type MisDay,
} from '@/components/mis/misUi';

// ---------------------------------------------------------------------------
// Types — mirror backend/src/services/msiService.ts (getAdminOverview)
// ---------------------------------------------------------------------------

interface UploadedReport {
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

interface PersonDay {
  employeeId: string;
  name: string;
  email: string;
  department: string | null;
  role: string;
  submitted: boolean;
  submittedAt: string | null;
  report: UploadedReport | null;
  mis: MisDay | null;
}

interface Overview {
  date: string;
  today: string;
  timezone: string;
  availableDates: string[]; // [last working day, the one before]
  /** e.g. { label: "Last working day", short: "Sat 3 Oct" } — Sundays, 2nd Saturdays and holidays are skipped. */
  dateLabels?: { date: string; label: string; short: string }[];
  /** Today is a Sunday / weekly-off Saturday / holiday. */
  todayOff?: { name: string } | null;
  retentionDays: number;
  expired: boolean;
  dayOffDate: boolean;
  summary: {
    totalEmployees: number;
    submitted: number;
    notSubmitted: number;
    incomplete: number;
    notFilled: number;
    important: number;
    submissionRate: number;
  };
  submitted: PersonDay[];
  notSubmitted: PersonDay[];
  dayOff: PersonDay[];
}

type Filter = 'all' | 'not_filled' | 'incomplete' | 'submitted' | 'important';

function formatLongDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTime(iso: string, tz: string) {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

const isIncomplete = (r: PersonDay) => r.mis?.status === 'INCOMPLETE';

export default function MisReportsPage() {
  const [date, setDate] = useState<string | null>(null); // null = server default (yesterday)
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [viewing, setViewing] = useState<PersonDay | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Live refresh comes from the 'msi:updated' socket event (useLiveUpdates).
  const { data, isLoading, isError, error, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['msi-admin', date ?? 'default'],
    queryFn: async () => (await api.get<Overview>('/msi/admin/reports', { params: date ? { date } : {} })).data,
  });

  // Red circles so far this month (MIS Circle Report) for each person.
  const { data: circle } = useCircleMonth(data ? data.date.slice(0, 7) : null);
  const circleOf = useMemo(() => new Map((circle?.rows ?? []).map((r) => [r.employeeId, r.summary])), [circle]);

  const recheck = useMutation({
    mutationFn: () => api.post('/mis/check', {}),
    onSettled: () => refetch(),
  });

  const forbidden = (error as { response?: { status?: number } } | null)?.response?.status === 403;

  const q = search.trim().toLowerCase();
  const match = (r: PersonDay) => !q || r.name.toLowerCase().includes(q) || (r.department ?? '').toLowerCase().includes(q);
  const notFilled = useMemo(() => (data?.notSubmitted ?? []).filter((r) => !isIncomplete(r) && match(r)), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const incomplete = useMemo(() => (data?.notSubmitted ?? []).filter((r) => isIncomplete(r) && match(r)), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const submitted = useMemo(() => (data?.submitted ?? []).filter(match), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const important = useMemo(() => (data?.submitted ?? []).filter((s) => s.report?.hasImportantMessage), [data]);

  const lastChecked = useMemo(() => {
    const all = [...(data?.submitted ?? []), ...(data?.notSubmitted ?? [])]
      .flatMap((r) => r.mis?.sources ?? [])
      .map((s) => s.checkedAt)
      .filter((x): x is string => Boolean(x))
      .sort();
    return all.at(-1) ?? null;
  }, [data]);

  const download = async (row: PersonDay) => {
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
      setDownloadError(`Couldn't download ${row.name}'s file — uploaded files are deleted automatically after 2 days.`);
    } finally {
      setDownloadingId(null);
    }
  };

  if (forbidden) {
    return (
      <div className="p-8">
        <div className="glass-card p-8 max-w-lg">
          <h1 className="text-xl font-semibold mb-2">Admin access required</h1>
          <p className="text-gray-500 text-sm">MIS Reports are visible to CEO, COO and Admin accounts only.</p>
        </div>
      </div>
    );
  }

  const selected = data?.date ?? date ?? '';
  const show = (f: Filter) => filter === 'all' || filter === f;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1400px]">
      <PageHeader
        eyebrow="MIS"
        title="MIS Reports"
        subtitle={
          data
            ? `${formatLongDate(data.date)} · staff get until the end of the next working day to fill their MIS, so this shows the last two working days (Sundays, 2nd Saturdays and holidays are skipped)`
            : 'Who filled their MIS, and what is missing'
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {data?.availableDates.map((d, i) => (
              <button
                key={d}
                onClick={() => setDate(i === 0 ? null : d)}
                className={cn(
                  'px-3 py-2 rounded-lg text-sm font-medium border transition-colors text-left leading-tight',
                  selected === d
                    ? 'bg-primary text-white border-primary'
                    : 'border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900',
                )}
              >
                {data.dateLabels?.[i]?.label ?? (i === 0 ? 'Last working day' : 'Previous working day')}
                <span className={cn('block text-[11px] font-normal', selected === d ? 'text-white/80' : 'text-gray-500')}>{shortDay(d)}</span>
              </button>
            ))}
            <Link href="/mis-circle" className="btn-secondary flex items-center gap-2" title="Monthly red circles and salary deduction">
              <XCircle className="w-4 h-4 text-red-500" /> Circle Report
            </Link>
            <button
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending}
              className="btn-secondary flex items-center gap-2"
              title="Read every linked MIS file again now (it also happens automatically every 10 minutes)"
            >
              <RefreshCw className={cn('w-4 h-4', recheck.isPending && 'animate-spin')} />
              {recheck.isPending ? 'Checking…' : 'Re-check now'}
            </button>
          </div>
        }
      />

      {data?.todayOff && (
        <div className="glass-card px-5 py-3 text-sm text-gray-600 dark:text-gray-300 flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-gray-400" />
          Today is a day off (<b>{data.todayOff.name}</b>) — no MIS is needed for it.
          <Link href="/mis-circle#holidays" className="ml-auto text-primary text-xs hover:underline">
            Holidays
          </Link>
        </div>
      )}

      <MisLegend />

      {isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-[120px] animate-pulse" />
          ))}
        </div>
      )}

      {isError && !forbidden && (
        <div className="glass-card p-6 flex items-center justify-between gap-4">
          <p className="text-sm text-gray-500">Couldn't load MIS reports. Please try again.</p>
          <button onClick={() => refetch()} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {data && data.expired && (
        <div className="glass-card p-10 text-center">
          <ClipboardList className="w-10 h-10 mx-auto text-gray-300 dark:text-gray-700 mb-3" />
          <h2 className="text-lg font-semibold">Only the last two working days can be viewed</h2>
          <button onClick={() => setDate(null)} className="btn-primary mt-5">
            Go to the last working day
          </button>
        </div>
      )}

      {data && !data.expired && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <StatCard title="Staff expected" value={data.summary.totalEmployees} icon={Users} />
            <StatCard title="Submitted" value={data.summary.submitted} icon={CheckCircle2} />
            <StatCard title="Incomplete (some blanks)" value={data.summary.incomplete} icon={TriangleAlert} />
            <StatCard title="Not submitted" value={data.summary.notFilled} icon={XCircle} />
            <StatCard title="Submission rate" value={`${data.summary.submissionRate}%`} icon={Percent} />
          </div>

          {data.dayOffDate && (
            <div className="glass-card px-5 py-3 text-sm text-gray-600 dark:text-gray-400">
              {formatLongDate(data.date)} is a day off (Sunday, 2nd Saturday or holiday) — no MIS is needed and nobody is counted.
            </div>
          )}

          {data.summary.important > 0 && (
            <button
              onClick={() => setFilter('important')}
              className="w-full rounded-2xl border px-5 py-4 flex items-center gap-3 text-left border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 hover:bg-amber-100/70 dark:hover:bg-amber-500/10 transition-colors"
            >
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
              <span className="font-semibold text-amber-800 dark:text-amber-300">
                {data.summary.important} important message{data.summary.important === 1 ? '' : 's'} from staff
              </span>
              <span className="ml-auto text-sm text-amber-700 dark:text-amber-400">View →</span>
            </button>
          )}

          {/* Filters + search */}
          <div className="flex items-center gap-2 flex-wrap">
            {(
              [
                ['all', 'All', null],
                ['not_filled', 'Not submitted', notFilled.length],
                ['incomplete', 'Incomplete', incomplete.length],
                ['submitted', 'Submitted', submitted.length],
                ['important', 'Important messages', important.length],
              ] as [Filter, string, number | null][]
            ).map(([key, label, n]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  'px-3.5 py-1.5 rounded-full text-sm font-medium border transition-colors',
                  filter === key
                    ? 'bg-primary text-white border-primary'
                    : 'border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900',
                )}
              >
                {label}
                {n !== null && <span className="ml-1.5 opacity-70">{n}</span>}
              </button>
            ))}
            <div className="relative ml-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or department"
                className="pl-9 pr-3 py-2 w-60 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {isFetching && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          </div>
          <p className="text-xs text-gray-400 -mt-3">
            {lastChecked ? `Files last read ${formatTime(lastChecked, data.timezone)}` : 'Files not read yet'}
            {dataUpdatedAt ? ` · page updated ${formatTime(new Date(dataUpdatedAt).toISOString(), data.timezone)}` : ''}
          </p>

          {downloadError && (
            <div className="glass-card px-5 py-3 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
              <XCircle className="w-4 h-4" /> {downloadError}
              <button onClick={() => setDownloadError(null)} className="ml-auto text-gray-400 hover:text-gray-600" aria-label="Dismiss">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {show('not_filled') && (
            <PeopleSection
              tone="red"
              title="Not submitted"
              hint="No column for this date, or 20+ of their usual entries are blank."
              rows={notFilled}
              date={data.date}
              empty="Nobody is in red for this day."
              tz={data.timezone}
              circleOf={circleOf}
            />
          )}

          {show('incomplete') && (
            <PeopleSection
              tone="amber"
              title="Incomplete"
              hint="Filled, but some usual entries are blank — the exact cells are listed."
              rows={incomplete}
              date={data.date}
              empty="Nobody has partly-filled MIS for this day."
              tz={data.timezone}
              circleOf={circleOf}
            />
          )}

          {show('submitted') && (
            <PeopleSection
              tone="green"
              title="Submitted"
              hint="Every usual entry filled."
              rows={submitted}
              date={data.date}
              empty="Nobody has fully submitted for this day yet."
              tz={data.timezone}
              circleOf={circleOf}
              onDownload={download}
              downloadingId={downloadingId}
              onViewMessage={setViewing}
            />
          )}

          {filter === 'all' && data.dayOff.length > 0 && (
            <PeopleSection tone="gray" title="Day off" hint="Day off, nothing filled — not counted." rows={data.dayOff} date={data.date} empty="" tz={data.timezone} circleOf={circleOf} />
          )}

          {show('important') && important.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold flex items-center gap-2">
                <MessageSquareWarning className="w-4 h-4 text-amber-500" /> Important messages
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {important.map((row) => (
                  <article key={row.employeeId} className="glass-card p-5 border-l-4 border-l-red-500">
                    <p className="text-sm">
                      <span className="font-semibold">{row.name}</span>
                      <span className="text-gray-500"> · {row.department ?? 'No department'}</span>
                    </p>
                    <blockquote className="mt-2 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words">
                      “{row.report!.importantMessage}”
                    </blockquote>
                    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-500">
                      <span className="font-tabular">{formatTime(row.report!.updatedAt, data.timezone)}</span>
                      <button onClick={() => download(row)} className="inline-flex items-center gap-1.5 text-primary font-medium hover:underline">
                        <Download className="w-3.5 h-3.5" /> Attached file
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Important message dialog */}
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
                <p className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Important message</p>
                <h3 className="text-lg font-semibold mt-1">{viewing.name}</h3>
                <p className="text-sm text-gray-500">{viewing.department ?? 'No department'}</p>
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
                <Download className="w-4 h-4" /> Download file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One coloured group of people
// ---------------------------------------------------------------------------

function PeopleSection({
  tone,
  title,
  hint,
  rows,
  date,
  empty,
  tz,
  onDownload,
  downloadingId,
  onViewMessage,
  circleOf,
}: {
  circleOf?: Map<string, CircleSummary>;
  tone: 'green' | 'amber' | 'red' | 'gray';
  title: string;
  hint: string;
  rows: PersonDay[];
  date: string;
  empty: string;
  tz: string;
  onDownload?: (r: PersonDay) => void;
  downloadingId?: string | null;
  onViewMessage?: (r: PersonDay) => void;
}) {
  return (
    <section className={cn('glass-card overflow-hidden border-l-4', TONE[tone].border)}>
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
        <h2 className={cn('text-[15px] font-semibold', TONE[tone].text)}>
          {title} — {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 px-6 py-6 text-center">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((row) => (
            <PersonRow
              key={row.employeeId}
              row={row}
              date={date}
              tz={tz}
              onDownload={onDownload}
              downloading={!!row.report && downloadingId === row.report.id}
              onViewMessage={onViewMessage}
              circle={circleOf?.get(row.employeeId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonRow({
  row,
  date,
  tz,
  onDownload,
  downloading,
  onViewMessage,
  circle,
}: {
  circle?: CircleSummary;
  row: PersonDay;
  date: string;
  tz: string;
  onDownload?: (r: PersonDay) => void;
  downloading: boolean;
  onViewMessage?: (r: PersonDay) => void;
}) {
  const [open, setOpen] = useState(false);
  const mis = row.mis;
  const status = mis?.status ?? (row.submitted ? 'COMPLETE' : 'MISSING');
  const blanks = mis?.sources.flatMap((s) => s.blanks) ?? [];
  const tone = toneOf(status);

  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex items-center gap-3 min-w-[200px] flex-1">
          <div
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ring-1',
              tone === 'green'
                ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20'
                : tone === 'amber'
                ? 'bg-amber-500/10 text-amber-700 ring-amber-500/20'
                : tone === 'red'
                ? 'bg-red-500/10 text-red-700 ring-red-500/20'
                : 'bg-gray-100 text-gray-500 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700',
            )}
          >
            {initials(row.name)}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-[14px] truncate">{row.name}</div>
            <div className="text-xs text-gray-500 truncate">
              {row.department ?? row.email.toUpperCase()}
              {mis && mis.sources.length > 1 && ` · ${mis.sources.length} MIS files`}
            </div>
          </div>
        </div>

        <div className="flex-[2] min-w-[260px] text-[13px] text-gray-700 dark:text-gray-300">
          {explainDay(mis, date, !!row.report)}
          {mis && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <OpenLinks sources={mis.sources} />
              <Reviewers sources={mis.sources} />
              <FileSaved sources={mis.sources} />
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5 ml-auto">
          <StatusBadge status={status} blanks={blanks.length} />
          {row.submitted && row.submittedAt && <span className="text-[11px] text-gray-500">filled by {formatTime(row.submittedAt, tz)}</span>}
          {circle && (circle.circles > 0 || circle.pendingCircles > 0) && (
            <Link
              href="/mis-circle"
              title={circle.message}
              className={cn('text-[11px] font-medium hover:underline', circle.deductionDays ? 'text-red-600' : 'text-gray-500')}
            >
              {circle.circles} red circle{circle.circles === 1 ? '' : 's'} this month
              {circle.deductionDays ? ` · ${circle.deductionDays} day salary cut` : ` · ${CIRCLES_PER_DEDUCTION - (circle.circles % CIRCLES_PER_DEDUCTION)} more = 1 day cut`}
            </Link>
          )}
          {row.report && (
            <div className="flex items-center gap-2">
              {row.report.hasImportantMessage && onViewMessage && (
                <button onClick={() => onViewMessage(row)} className="text-[11px] font-medium text-amber-700 hover:underline">
                  ⚠ Important message
                </button>
              )}
              {onDownload && (
                <button
                  onClick={() => onDownload(row)}
                  disabled={downloading}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
                  title={`${row.report.fileName} (${formatSize(row.report.fileSize)})`}
                >
                  {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Uploaded file
                </button>
              )}
            </div>
          )}
          {blanks.length > 0 && (
            <button onClick={() => setOpen(!open)} className="text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:underline">
              {open ? 'Hide blank cells' : `Show ${blanks.length} blank cell${blanks.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
      {open && blanks.length > 0 && mis && (
        <div className="mt-3 ml-12 grid gap-3 md:grid-cols-2">
          {mis.sources
            .filter((s) => s.blanks.length > 0)
            .map((s) => (
              <div key={s.id} className="rounded-lg bg-amber-50/60 dark:bg-amber-500/5 border border-amber-200/60 dark:border-amber-500/20 p-3">
                <p className="text-xs font-semibold mb-1.5">
                  {s.label} <span className="font-normal text-gray-500">· sheet “{s.blanks[0].sheet}” · {dmy(date)}</span>
                </p>
                <BlankList blanks={s.blanks} />
              </div>
            ))}
        </div>
      )}
    </li>
  );
}
