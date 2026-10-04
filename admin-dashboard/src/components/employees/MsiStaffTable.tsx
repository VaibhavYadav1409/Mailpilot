'use client';

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ClipboardPaste, FileSpreadsheet, KeyRound, Loader2, Plus, Search, UserCheck, UserX } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { MisLegend, StatusBadge, shortDay, type MisStatus } from '@/components/mis/misUi';
import { isMsiStaffLogin } from './staffKind';
import { MisConnectionCard } from './MisConnectionCard';
import { MisSourcesPanel } from './MisSourcesPanel';
import { MisImportPanel } from './MisImportPanel';
import { personStatus, useMisSources, type MisSource } from './misApi';
import Link from 'next/link';
import { CIRCLES_PER_DEDUCTION, useCircleMonth } from '@/components/mis/circleApi';

interface StaffRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string; // for MIS staff this is the username, e.g. "ashok kumar"
  status: 'ONLINE' | 'OFFLINE' | 'IDLE' | 'SUSPENDED';
  lastActiveAt: string | null;
}

interface UpsertResult {
  created: boolean;
  username: string;
  password: string;
}

type DayFilter = 'all' | 'red' | 'amber' | 'green' | 'unlinked';

const colourOf = (s: MisStatus | undefined): DayFilter =>
  s === 'COMPLETE' ? 'green' : s === 'INCOMPLETE' ? 'amber' : s === 'MISSING' ? 'red' : 'all';

/**
 * People who fill an MIS spreadsheet (no mailbox, no email). They sign in on
 * the Employee Portal with their name as username and their name in CAPITALS
 * as password; MailPilot reads their MIS and shows the last working day's and the day
 * before's result.
 */
export function MsiStaffTable() {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const canManage = !!currentUser && ['ADMIN', 'COO', 'CEO'].includes(currentUser.role);

  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [openMis, setOpenMis] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const { data: misSources } = useMisSources();
  const sourcesOf = (id: string): MisSource[] => (misSources ?? []).filter((m) => m.employeeId === id);
  const days = misSources?.[0]?.days.map((d) => d.date) ?? [];
  const dayLabels = misSources?.[0]?.days.map((d) => d.label) ?? ['Last working day', 'Previous working day'];
  const { data: circle } = useCircleMonth(null);
  const circleOf = new Map((circle?.rows ?? []).map((r) => [r.employeeId, r.summary]));

  // Same query key as the mail table, so both sections share one request.
  const { data: employees, isLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => (await api.get<StaffRow[]>('/employees')).data,
  });

  const allStaff = (employees ?? []).filter((e) => isMsiStaffLogin(e.email));
  const withStatus = allStaff.map((s) => {
    const mine = sourcesOf(s.id);
    return { s, mine, y: personStatus(mine, 0), d: personStatus(mine, 1) };
  });
  const counts = {
    green: withStatus.filter((x) => x.y?.status === 'COMPLETE').length,
    amber: withStatus.filter((x) => x.y?.status === 'INCOMPLETE').length,
    red: withStatus.filter((x) => x.y?.status === 'MISSING').length,
    unlinked: withStatus.filter((x) => !x.y).length,
  };
  const rows = withStatus
    .filter(({ s }) => `${s.firstName} ${s.lastName} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((x) => (dayFilter === 'all' ? true : dayFilter === 'unlinked' ? !x.y : colourOf(x.y?.status) === dayFilter))
    .sort((a, b) => `${a.s.firstName} ${a.s.lastName}`.localeCompare(`${b.s.firstName} ${b.s.lastName}`));

  const upsert = useMutation({
    mutationFn: async (staffName: string) => (await api.post<UpsertResult>('/employees/msi-staff', { name: staffName })).data,
    onSuccess: (r) => {
      setNotice({
        kind: 'ok',
        text: `${r.created ? 'Added' : 'Password reset'} — username: ${r.username} · password: ${r.password}`,
      });
      setName('');
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: (err: any) => setNotice({ kind: 'error', text: err?.response?.data?.error ?? 'Could not save. Try again.' }),
  });

  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: 'SUSPENDED' | 'OFFLINE' }) => api.patch(`/employees/${args.id}`, { status: args.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });

  const chip = (key: DayFilter, label: string, n: number, cls: string) => (
    <button
      key={key}
      onClick={() => setDayFilter(dayFilter === key ? 'all' : key)}
      className={cn(
        'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
        dayFilter === key ? 'bg-primary text-white border-primary' : cn('border-gray-200 dark:border-gray-800', cls),
      )}
    >
      {label} <span className="opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="space-y-3">
      <MisConnectionCard canManage={canManage} />
      <MisLegend />
      {canManage && showImport && <MisImportPanel />}

      <div className="glass-card overflow-hidden">
        <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search MIS staff..."
              className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-gray-900 border-none rounded-lg focus:ring-2 focus:ring-primary/20 outline-none text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canManage && (
            <>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) upsert.mutate(name);
                }}
              >
                <input
                  type="text"
                  placeholder="Full name, e.g. Ashok Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={upsert.isPending}
                  className="w-56 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg outline-none text-sm focus:ring-2 focus:ring-primary/20"
                />
                <button type="submit" disabled={upsert.isPending || !name.trim()} className="btn-primary flex items-center gap-2">
                  {upsert.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add person
                </button>
              </form>
              <button onClick={() => setShowImport(!showImport)} className="btn-secondary flex items-center gap-2">
                <ClipboardPaste className="w-4 h-4" /> {showImport ? 'Close import' : 'Import list'}
              </button>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500 mr-1">
            {dayLabels[0]}
            {days[0] ? ` (${shortDay(days[0])})` : ''}:
          </span>
          {chip('green', 'Submitted', counts.green, 'text-emerald-700 dark:text-emerald-400')}
          {chip('amber', 'Incomplete', counts.amber, 'text-amber-700 dark:text-amber-400')}
          {chip('red', 'Not submitted', counts.red, 'text-red-600 dark:text-red-400')}
          {chip('unlinked', 'No MIS linked', counts.unlinked, 'text-gray-500')}
        </div>

        {notice && (
          <div
            className={cn(
              'mx-4 mt-4 px-3 py-2 rounded-lg text-sm',
              notice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400',
            )}
          >
            {notice.text}
          </div>
        )}

        {isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 bg-gray-50 dark:bg-gray-900 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">
            {allStaff.length === 0 ? 'No MIS staff yet. Add someone by name, or use “Import list”.' : 'Nobody matches this filter.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800">
                  <th className="px-5 py-3.5">Name / login</th>
                  <th className="px-5 py-3.5">
                    MIS · {dayLabels[0]}
                    {days[0] && <span className="block normal-case font-normal tracking-normal">{shortDay(days[0])}</span>}
                  </th>
                  <th className="px-5 py-3.5">
                    MIS · {dayLabels[1] ?? 'Previous working day'}
                    {days[1] && <span className="block normal-case font-normal tracking-normal">{shortDay(days[1])}</span>}
                  </th>
                  <th className="px-5 py-3.5" title={`Every ${CIRCLES_PER_DEDUCTION} red circles in a month = 1 day's salary deducted`}>
                    Red circles
                    <span className="block normal-case font-normal tracking-normal">this month</span>
                  </th>
                  <th className="px-5 py-3.5">MIS files</th>
                  <th className="px-5 py-3.5">Last sign-in</th>
                  {canManage && <th className="px-5 py-3.5 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {rows.map(({ s, mine, y, d }) => {
                  const fullName = `${s.firstName} ${s.lastName}`.trim();
                  const open = openMis === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr className={cn('hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors', open && 'bg-gray-50/60 dark:bg-gray-900/40')}>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                              {s.firstName[0]}
                              {s.lastName[0] ?? ''}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium text-[13.5px] flex items-center gap-2">
                                {fullName}
                                {s.status === 'SUSPENDED' && <span className="text-[10px] font-semibold uppercase text-red-500">suspended</span>}
                              </div>
                              <div className="text-[11px] text-gray-500 font-mono" title="Password = name in CAPITALS">
                                {s.email.toUpperCase()}
                              </div>
                            </div>
                          </div>
                        </td>
                        {[y, d].map((x, i) => (
                          <td key={i} className="px-5 py-3.5">
                            {x ? (
                              <button onClick={() => setOpenMis(open ? null : s.id)} title="See why">
                                <StatusBadge status={x.status} blanks={x.blanks} />
                              </button>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                        ))}
                        <td className="px-5 py-3.5">
                          {(() => {
                            const c = circleOf.get(s.id);
                            if (!c) return <span className="text-xs text-gray-400">—</span>;
                            return (
                              <Link href="/mis-circle" title={c.message} className="text-xs hover:underline">
                                <span className={cn('font-bold', c.circles ? 'text-red-600' : 'text-emerald-600')}>{c.circles}</span>
                                {c.pendingCircles > 0 && <span className="text-red-400"> +{c.pendingCircles}?</span>}
                                <span className={cn('block text-[11px]', c.deductionDays ? 'text-red-600 font-medium' : 'text-gray-500')}>
                                  {c.deductionDays ? `${c.deductionDays} day${c.deductionDays === 1 ? '' : 's'} salary cut` : `${c.untilNextDeduction} more = 1 day cut`}
                                </span>
                              </Link>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-3.5">
                          <button
                            onClick={() => setOpenMis(open ? null : s.id)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                          >
                            <FileSpreadsheet className="w-4 h-4" />
                            {mine.length === 0 ? 'Link MIS' : `${mine.length} file${mine.length === 1 ? '' : 's'}`}
                            <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
                          </button>
                        </td>
                        <td className="px-5 py-3.5 text-xs font-tabular text-gray-500">
                          {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'Never'}
                        </td>
                        {canManage && (
                          <td className="px-5 py-3.5">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => upsert.mutate(fullName)}
                                disabled={upsert.isPending}
                                title="Set the password back to their name in CAPITALS"
                                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                              >
                                <KeyRound className="w-3.5 h-3.5" /> Reset password
                              </button>
                              {s.status === 'SUSPENDED' ? (
                                <button
                                  onClick={() => setStatus.mutate({ id: s.id, status: 'OFFLINE' })}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                                >
                                  <UserCheck className="w-3.5 h-3.5" /> Reactivate
                                </button>
                              ) : (
                                <button
                                  onClick={() => window.confirm(`Suspend ${fullName}? They can't sign in and won't appear in MIS Reports.`) && setStatus.mutate({ id: s.id, status: 'SUSPENDED' })}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-red-500"
                                >
                                  <UserX className="w-3.5 h-3.5" /> Suspend
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={canManage ? 7 : 6} className="px-5 pb-4 bg-gray-50/40 dark:bg-gray-900/20">
                            <MisSourcesPanel employeeId={s.id} sources={mine} canManage={canManage} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
