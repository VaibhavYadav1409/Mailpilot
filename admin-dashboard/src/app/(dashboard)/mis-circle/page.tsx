'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CircleAlert, Download, IndianRupee, Loader2, Search, Users, X } from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/dashboard/StatCard';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import {
  CIRCLES_PER_DEDUCTION,
  TONE_CELL,
  downloadCircleExcel,
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
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const { data, isLoading, isError, refetch } = useCircleMonth(month);
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = !!role && ['ADMIN', 'COO', 'CEO'].includes(role);
  const current = data?.month ?? month ?? '';
  const codeOf = useMemo(() => new Map((data?.codes ?? []).map((c) => [c.code, c])), [data]);

  const rows = (data?.rows ?? [])
    .filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((r) => !onlyRed || r.summary.circles + r.summary.pendingCircles > 0);

  const download = async () => {
    if (!current) return;
    setDownloading(true);
    setError('');
    try {
      await downloadCircleExcel(current);
    } catch {
      setError('Could not download the Excel file. Please try again.');
    } finally {
      setDownloading(false);
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
            <button onClick={download} disabled={!data || downloading} className="btn-primary flex items-center gap-2">
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download Excel
            </button>
          </div>
        }
      />

      {error && <div className="glass-card px-5 py-3 text-sm text-red-600">{error}</div>}

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
                      <div className="font-medium text-[12.5px] whitespace-nowrap">{r.name}</div>
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
    </div>
  );
}

function cellTitle(r: CircleRow, date: string, data: CircleMonth, def?: CircleCode) {
  const c = r.cells[date];
  if (!c?.code) return date === data.today ? 'Today — checked tomorrow' : date > data.today ? '' : 'No result (MIS not linked or not read that day)';
  const parts = [`${date.split('-').reverse().join('-')}: ${c.code} — ${def?.label ?? ''}`, def?.meaning ?? ''];
  if (c.pending) parts.push('Pending: yesterday — still changes if the MIS is filled today.');
  if (c.source === 'MANUAL') parts.push(`Set by an admin${c.autoCode ? ` (the check said ${c.autoCode})` : ''}.`);
  if (c.source === 'CALENDAR') parts.push('From the calendar.');
  if (c.note) parts.push(`Note: ${c.note}`);
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
              Example: CM on 3rd, 9th and 21st = 3 red circles = 1 day's salary deducted. 5 circles = still 1 day; the 6th makes it 2 days.
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
