'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Clock, Download, FileSpreadsheet, IndianRupee, Loader2, Search, Users, X } from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/dashboard/StatCard';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import {
  CIRCLES_PER_DEDUCTION,
  TONE_CELL,
  deductionCalculation,
  dmy,
  downloadCircleExcel,
  ordinal,
  redCircleEntries,
  monthLabel,
  shiftMonth,
  useCircleMonth,
  type CircleCode,
  type CircleMonth,
  type CircleRow,
} from '@/components/mis/circleApi';

export default function MisCirclePage() {
  const [month, setMonth] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyRed, setOnlyRed] = useState(false);
  const [editing, setEditing] = useState<{ row: CircleRow; date: string } | null>(null);
  const [person, setPerson] = useState<CircleRow | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { data, isLoading, isError, refetch } = useCircleMonth(month);
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = !!role && ['ADMIN', 'COO', 'CEO'].includes(role);
  const current = data?.month ?? month ?? '';
  const codeOf = useMemo(() => new Map((data?.codes ?? []).map((c) => [c.code, c])), [data]);

  const rows = (data?.rows ?? [])
    .filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((r) => !onlyRed || r.summary.circles + r.summary.pendingCircles > 0);

  /** Whole sheet, or one person's when `row` is given. */
  const download = async (row?: CircleRow) => {
    if (!current) return;
    setDownloading(row?.employeeId ?? 'all');
    setError('');
    try {
      await downloadCircleExcel(current, row ? { id: row.employeeId, name: row.name } : undefined);
    } catch {
      setError('Could not download the Excel file. Please try again.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1600px]">
      <PageHeader
        eyebrow="MIS"
        title="MIS Circle Report"
        subtitle={`Red circle = MIS not submitted. Every ${CIRCLES_PER_DEDUCTION} red circles in a month = 1 day's salary deducted.`}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-800">
              <button onClick={() => current && setMonth(shiftMonth(current, -1))} className="p-2 hover:bg-gray-50 dark:hover:bg-gray-900" aria-label="Previous month">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-3 text-sm font-medium min-w-[130px] text-center">{current ? monthLabel(current) : '…'}</span>
              <button onClick={() => current && setMonth(shiftMonth(current, 1))} className="p-2 hover:bg-gray-50 dark:hover:bg-gray-900" aria-label="Next month">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button onClick={() => download()} disabled={!data || !!downloading} className="btn-primary flex items-center gap-2" title="Excel with 5 tabs: Salary Deduction, Circle Sheet, Red Circles (why each is red), Day by Day, Rules & Codes">
              {downloading === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download Excel (all staff)
            </button>
          </div>
        }
      />

      {error && <div className="glass-card px-5 py-3 text-sm text-red-600">{error}</div>}

      {data && (
        <div
          className={cn(
            'glass-card px-5 py-3 flex items-center gap-3 text-sm',
            data.status.final ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {data.status.final ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <Clock className="w-4 h-4 shrink-0" />}
          <span className="font-medium">{data.status.text}</span>
          <span className="ml-auto text-xs text-gray-500 hidden md:inline">
            Excel tabs: Salary Deduction · Circle Sheet · Red Circles (why each is red) · Day by Day · Rules &amp; Codes
          </span>
        </div>
      )}

      {data && <RulesCard data={data} />}

      {isLoading && <div className="glass-card h-64 animate-pulse" />}
      {isError && (
        <div className="glass-card p-6 flex items-center justify-between">
          <p className="text-sm text-gray-500">Couldn't load the Circle Report.</p>
          <button onClick={() => refetch()} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="People on the sheet" value={data.totals.people} icon={Users} />
            <StatCard title="Red circles this month" value={data.totals.circles} icon={CircleAlert} />
            <StatCard title="Salary days to deduct" value={data.totals.deductionDays} icon={IndianRupee} />
            <StatCard title="People with a deduction" value={data.totals.peopleWithDeduction} icon={Users} />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name"
                className="pl-9 pr-3 py-2 w-56 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <input type="checkbox" checked={onlyRed} onChange={(e) => setOnlyRed(e.target.checked)} /> Only people with red circles
            </label>
            {canEdit && <span className="text-xs text-gray-500 ml-auto">Click any past cell to mark leave, absent, on duty, holiday… or to correct it.</span>}
          </div>

          <div className="glass-card overflow-auto max-h-[70vh]">
            <table className="text-xs border-separate border-spacing-0">
              <thead className="sticky top-0 z-20">
                <tr>
                  <th className="sticky left-0 z-30 bg-white dark:bg-gray-950 px-2 py-1 border-b border-gray-200 dark:border-gray-800" />
                  <th className="sticky left-8 z-30 bg-white dark:bg-gray-950 px-2 py-1 border-b border-gray-200 dark:border-gray-800" />
                  {data.days.map((d) => (
                    <th
                      key={d.date}
                      className={cn(
                        'px-0.5 py-1 font-semibold text-[10px] border-b border-gray-200 dark:border-gray-800 w-9',
                        d.isOff ? 'bg-gray-100 text-gray-400 dark:bg-gray-900' : 'bg-white dark:bg-gray-950 text-gray-500',
                        d.date === data.yesterday && 'text-primary',
                      )}
                    >
                      {d.dow}
                    </th>
                  ))}
                  <th colSpan={3} className="bg-white dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800" />
                </tr>
                <tr>
                  <th className="sticky left-0 z-30 bg-white dark:bg-gray-950 px-2 py-2 text-left border-b border-gray-200 dark:border-gray-800 w-8">#</th>
                  <th className="sticky left-8 z-30 bg-white dark:bg-gray-950 px-2 py-2 text-left border-b border-gray-200 dark:border-gray-800 min-w-[180px]">Staff name</th>
                  {data.days.map((d) => (
                    <th
                      key={d.date}
                      className={cn(
                        'px-0.5 py-2 border-b border-gray-200 dark:border-gray-800',
                        d.isOff ? 'bg-gray-100 dark:bg-gray-900 text-gray-400' : 'bg-white dark:bg-gray-950',
                        d.date === data.yesterday && 'text-primary underline',
                        d.date === data.today && 'text-gray-400',
                      )}
                      title={d.date === data.yesterday ? 'Yesterday — can still change today' : d.date === data.today ? 'Today — checked tomorrow' : undefined}
                    >
                      {d.day}
                    </th>
                  ))}
                  <th className="px-2 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 whitespace-nowrap">Red circles</th>
                  <th className="px-2 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 whitespace-nowrap">Salary cut</th>
                  <th className="px-2 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-left min-w-[300px]">What it means</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.employeeId} className="group">
                    <td className="sticky left-0 z-10 bg-white dark:bg-gray-950 px-2 py-1.5 border-b border-gray-100 dark:border-gray-900 text-gray-400">{i + 1}</td>
                    <td className="sticky left-8 z-10 bg-white dark:bg-gray-950 px-2 py-1.5 border-b border-gray-100 dark:border-gray-900">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setPerson(r)}
                          className="font-medium text-[12.5px] whitespace-nowrap hover:text-primary hover:underline text-left"
                          title="See every red circle, the reason and how the salary deduction is worked out"
                        >
                          {r.name}
                        </button>
                        <button
                          onClick={() => download(r)}
                          disabled={!!downloading}
                          className="text-gray-400 hover:text-primary opacity-60 group-hover:opacity-100"
                          title={`Download ${r.name}'s Excel for ${current ? monthLabel(current) : 'this month'}`}
                          aria-label={`Download ${r.name}'s Excel`}
                        >
                          {downloading === r.employeeId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      {!r.hasMis && <div className="text-[10px] text-amber-600">No MIS file linked</div>}
                    </td>
                    {data.days.map((d) => {
                      const c = r.cells[d.date];
                      const def = c?.code ? codeOf.get(c.code) : undefined;
                      const editable = canEdit && d.date <= data.today;
                      return (
                        <td key={d.date} className="p-0.5 border-b border-gray-100 dark:border-gray-900 text-center">
                          <button
                            disabled={!editable}
                            onClick={() => setEditing({ row: r, date: d.date })}
                            title={cellTitle(r, d.date, data, def)}
                            className={cn(
                              'w-8 h-7 rounded text-[10px] leading-none relative',
                              def ? TONE_CELL[def.tone] : 'text-gray-300',
                              c?.pending && def?.isCircle && 'outline-dashed outline-2 outline-red-400 opacity-80',
                              c?.source === 'MANUAL' && 'ring-1 ring-primary/60',
                              editable && 'hover:ring-2 hover:ring-primary cursor-pointer',
                            )}
                          >
                            {c?.code ?? (d.date < data.today && !d.isOff ? '·' : '')}
                            {c?.pending && def?.isCircle && <span className="absolute -top-1 -right-1 text-[9px]">?</span>}
                          </button>
                        </td>
                      );
                    })}
                    <td className={cn('px-2 text-center border-b border-gray-100 dark:border-gray-900 font-bold text-sm', r.summary.circles ? 'text-red-600' : 'text-emerald-600')}>
                      {r.summary.circles}
                      {r.summary.pendingCircles > 0 && <span className="text-[10px] text-red-400 font-normal"> +{r.summary.pendingCircles}?</span>}
                    </td>
                    <td className={cn('px-2 text-center border-b border-gray-100 dark:border-gray-900 font-bold text-sm whitespace-nowrap', r.summary.deductionDays ? 'text-red-600' : 'text-gray-400')}>
                      {r.summary.deductionDays ? `${r.summary.deductionDays} day${r.summary.deductionDays === 1 ? '' : 's'}` : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-gray-100 dark:border-gray-900 text-[11.5px] text-gray-600 dark:text-gray-400">
                      <CircleDots n={r.summary.circles} pending={r.summary.pendingCircles} />
                      {r.hasMis ? r.summary.message : 'No MIS file linked — mark this row by hand (click the cells).'}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={data.days.length + 5} className="p-8 text-center text-sm text-gray-500">
                      Nobody matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && data && <CellEditor data={data} row={editing.row} date={editing.date} onClose={() => setEditing(null)} />}
      {person && data && (
        <PersonPanel
          data={data}
          row={data.rows.find((r) => r.employeeId === person.employeeId) ?? person}
          downloading={downloading === person.employeeId}
          onDownload={() => download(person)}
          onClose={() => setPerson(null)}
        />
      )}
    </div>
  );
}

function cellTitle(r: CircleRow, date: string, data: CircleMonth, def?: CircleCode) {
  const c = r.cells[date];
  if (!c?.code) return date === data.today ? 'Today — checked tomorrow' : date > data.today ? '' : 'No result (MIS not linked or not read that day)';
  const parts = [`${date.split('-').reverse().join('-')}: ${c.code} — ${def?.label ?? ''}`, def?.meaning ?? ''];
  if (c.pending) parts.push('Pending: yesterday — still changes if the MIS is filled today.');
  if (c.reason && c.source !== 'CALENDAR') parts.push(`Why: ${c.reason}`);
  if (c.markedBy) parts.push(`Marked by: ${c.markedBy}`);
  if (c.note && c.source !== 'MANUAL') parts.push(`Note: ${c.note}`);
  return parts.filter(Boolean).join('\n');
}

/** ●●○ — red circles so far in the current block of 3. */
function CircleDots({ n, pending }: { n: number; pending: number }) {
  const inBlock = n % CIRCLES_PER_DEDUCTION;
  return (
    <span className="inline-flex items-center gap-0.5 mr-2 align-middle" title={`${inBlock} of ${CIRCLES_PER_DEDUCTION} towards the next deduction`}>
      {Array.from({ length: CIRCLES_PER_DEDUCTION }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'w-2.5 h-2.5 rounded-full border',
            i < inBlock ? 'bg-red-500 border-red-500' : i < inBlock + pending ? 'border-red-400 border-dashed' : 'border-gray-300 dark:border-gray-700',
          )}
        />
      ))}
    </span>
  );
}

function RulesCard({ data }: { data: CircleMonth }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="glass-card overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-3 flex items-center gap-2 text-left">
        <CircleAlert className="w-4 h-4 text-red-500" />
        <span className="text-sm font-semibold">How red circles and salary deduction work</span>
        <span className="ml-auto text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 grid gap-5 lg:grid-cols-2">
          <ol className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300 list-decimal pl-5">
            {data.rules.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Codes</p>
            <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {data.codes.map((c) => (
                <li key={c.code} className="flex items-start gap-2">
                  <span className={cn('inline-flex w-9 h-6 shrink-0 items-center justify-center rounded text-[10px]', TONE_CELL[c.tone])}>{c.code}</span>
                  <span className="text-gray-600 dark:text-gray-400">
                    <b className="text-gray-800 dark:text-gray-200">{c.label}</b> — {c.meaning}
                  </span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <span className="inline-flex w-9 h-6 shrink-0 items-center justify-center rounded text-[10px] bg-red-100 text-red-800 outline-dashed outline-2 outline-red-400">CM?</span>
                <span className="text-gray-600 dark:text-gray-400">
                  <b className="text-gray-800 dark:text-gray-200">Pending</b> — yesterday's MIS is missing; it turns green if filled today.
                </span>
              </li>
            </ul>
            <p className="text-xs text-gray-500 mt-3">
              Example: CM on 3rd, 9th and 21st = 3 red circles = 1 day's salary deducted. 1 or 2 circles = no deduction yet. 5 circles = still 1 day; the 6th makes it
              2 days.
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Click a name to see each of their red circles with the reason. The Excel download (all staff, or one person via the
              <FileSpreadsheet className="inline w-3 h-3 mx-1" />
              icon) has the same details on 5 tabs.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CellEditor({ data, row, date, onClose }: { data: CircleMonth; row: CircleRow; date: string; onClose: () => void }) {
  const qc = useQueryClient();
  const cell = row.cells[date];
  const [note, setNote] = useState(cell?.note ?? '');
  const save = useMutation({
    mutationFn: (code: string | null) => api.put('/mis/circle/mark', { employeeId: row.employeeId, date, code, note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mis-circle'] });
      onClose();
    },
  });
  const manualCodes = data.codes.filter((c) => c.manual);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-gray-400">Change cell</p>
            <h3 className="text-lg font-semibold">
              {row.name} · {new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Now: <b>{cell?.code ?? 'empty'}</b>
              {cell?.source === 'MANUAL' && ` (set by an admin${cell.autoCode ? `; the MIS check said ${cell.autoCode}` : ''})`}
              {cell?.source === 'AUTO' && ' (from the MIS check)'}
              {cell?.source === 'CALENDAR' && ' (from the calendar)'}
            </p>
            {cell?.reason && cell.source !== 'CALENDAR' && (
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2 rounded-lg bg-gray-50 dark:bg-gray-900 px-3 py-2">
                <b>Why:</b> {cell.reason}
                {cell.markedBy && <span className="block text-gray-400 mt-0.5">Marked by: {cell.markedBy}</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {manualCodes.map((c) => (
            <button
              key={c.code}
              onClick={() => save.mutate(c.code)}
              disabled={save.isPending}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs hover:border-primary', cell?.code === c.code && 'border-primary')}
            >
              <span className={cn('inline-flex w-9 h-6 shrink-0 items-center justify-center rounded text-[10px]', TONE_CELL[c.tone])}>{c.code}</span>
              <span>
                <b>{c.label}</b>
                {c.isCircle && <span className="text-red-600"> · counts</span>}
              </span>
            </button>
          ))}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional), e.g. sick leave approved by NCM Sir"
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg text-sm bg-transparent outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          {cell?.source === 'MANUAL' ? (
            <button onClick={() => save.mutate(null)} disabled={save.isPending} className="btn-secondary text-sm">
              Undo — use the automatic value
            </button>
          ) : (
            <span className="text-xs text-gray-500">A manual mark is never overwritten by the automatic check.</span>
          )}
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
        </div>
        {save.isError && <p className="text-xs text-red-600">{(save.error as any)?.response?.data?.error ?? 'Could not save.'}</p>}
      </div>
    </div>
  );
}

/** One person's month: every red circle, why it is red, and the salary maths. */
function PersonPanel({
  data,
  row,
  downloading,
  onDownload,
  onClose,
}: {
  data: CircleMonth;
  row: CircleRow;
  downloading: boolean;
  onDownload: () => void;
  onClose: () => void;
}) {
  const entries = redCircleEntries(row, data);
  const triggers = entries.filter((e) => e.triggersDeduction);
  const s = row.summary;
  const counts: Record<string, number> = {};
  for (const d of data.days) {
    const c = row.cells[d.date]?.code;
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  const label = (code: string) => data.codes.find((c) => c.code === code)?.label ?? code;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-2xl max-h-[88vh] overflow-auto p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-gray-400">{monthLabel(data.month)} · {data.status.final ? 'final' : 'in progress'}</p>
            <h3 className="text-lg font-semibold">{row.name}</h3>
            <p className="text-xs text-gray-500">Login: {row.username}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onDownload} disabled={downloading} className="btn-secondary text-sm flex items-center gap-2">
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />} Download Excel
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className={cn('rounded-xl p-3 text-center', s.circles ? 'bg-red-50 dark:bg-red-500/10' : 'bg-emerald-50 dark:bg-emerald-500/10')}>
            <div className={cn('text-2xl font-bold', s.circles ? 'text-red-600' : 'text-emerald-600')}>{s.circles}</div>
            <div className="text-xs text-gray-500">red circles{s.pendingCircles ? ` (+${s.pendingCircles} pending)` : ''}</div>
          </div>
          <div className={cn('rounded-xl p-3 text-center', s.deductionDays ? 'bg-red-600 text-white' : 'bg-gray-50 dark:bg-gray-900')}>
            <div className="text-2xl font-bold">{s.deductionDays}</div>
            <div className={cn('text-xs', s.deductionDays ? 'text-red-100' : 'text-gray-500')}>salary day{s.deductionDays === 1 ? '' : 's'} deducted</div>
          </div>
          <div className="rounded-xl p-3 text-center bg-gray-50 dark:bg-gray-900">
            <div className="text-2xl font-bold text-gray-700 dark:text-gray-200">{s.untilNextDeduction}</div>
            <div className="text-xs text-gray-500">more circle{s.untilNextDeduction === 1 ? '' : 's'} = {s.deductionDays + 1} day{s.deductionDays + 1 === 1 ? '' : 's'}</div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 text-sm space-y-1.5">
          <p>
            <b>Calculation:</b> {deductionCalculation(s.circles)}
          </p>
          {triggers.length > 0 && (
            <p>
              <b>Which circle cost which day:</b>{' '}
              {triggers.map((e, i) => `Day ${i + 1} — ${ordinal(e.number!)} circle on ${dmy(e.date)}`).join(' · ')}
            </p>
          )}
          <p className="text-gray-600 dark:text-gray-400">{s.message}</p>
          <p className="text-xs text-gray-500">
            Month so far: {counts.NC ?? 0} submitted · {counts.IN ?? 0} incomplete (no circle)
            {['OL', 'A', 'ON', 'SO', 'H'].filter((c) => counts[c]).map((c) => ` · ${counts[c]} ${label(c).toLowerCase()}`).join('')}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Every red circle and why</p>
          {entries.length === 0 ? (
            <p className="text-sm text-emerald-600">No red circles this month.</p>
          ) : (
            <ol className="space-y-2">
              {entries.map((e) => (
                <li
                  key={e.date}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    e.triggersDeduction ? 'border-red-400 bg-red-50 dark:bg-red-500/10' : e.pending ? 'border-dashed border-red-300' : 'border-gray-200 dark:border-gray-800',
                  )}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn('inline-flex min-w-7 h-6 px-1.5 items-center justify-center rounded-full text-xs font-bold', e.pending ? 'border border-dashed border-red-400 text-red-500' : 'bg-red-600 text-white')}>
                      {e.pending ? '?' : e.number}
                    </span>
                    <b>{new Date(`${e.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</b>
                    <span className={cn('text-xs', e.triggersDeduction ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-gray-500')}>{e.effect}</span>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    <b>Why:</b> {e.reason}
                  </p>
                  <p className="text-[11px] text-gray-400">Marked by: {e.markedBy}{e.note ? ` · Note: ${e.note}` : ''}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
