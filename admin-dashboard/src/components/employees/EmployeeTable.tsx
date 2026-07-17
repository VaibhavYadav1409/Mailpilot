'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { Search, Filter, MoreVertical, KeyRound, UserX, UserCheck } from 'lucide-react';
import { useState, useEffect, Fragment } from 'react';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: 'ONLINE' | 'OFFLINE' | 'IDLE' | 'SUSPENDED';
  department: { id: string; name: string } | null;
  gmailAccount: { emailAddress: string; status: string; lastSyncedAt: string | null } | null;
  inboxCounts: { pending: number; replied: number };
}

export const EmployeeTable = () => {
  const [search, setSearch] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<{ id: string; tab: 'overview' | 'pending' | 'replied' }>({
    id: '',
    tab: 'overview',
  });
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const { data: employees, isLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const { data } = await api.get<Employee[]>('/employees');
      return data;
    },
  });

  const statusMutation = useMutation({
    mutationFn: (args: { id: string; status: 'SUSPENDED' | 'OFFLINE' }) =>
      api.patch(`/employees/${args.id}`, { status: args.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (id: string) => api.post<{ tempPassword: string }>(`/employees/${id}/reset-password`),
  });

  const filteredEmployees = employees?.filter(
    (emp) =>
      `${emp.firstName} ${emp.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
      emp.email.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="glass-card overflow-hidden">
        <div className="p-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-50 dark:bg-gray-900 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const canManage = currentUser && ['ADMIN', 'COO', 'CEO'].includes(currentUser.role);

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search employees..."
            className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-gray-900 border-none rounded-lg focus:ring-2 focus:ring-primary/20 outline-none text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900 rounded-lg transition-colors">
            <Filter className="w-4 h-4" />
            Filter
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800">
              <th className="px-6 py-3.5">Employee</th>
              <th className="px-6 py-3.5">Department</th>
              <th className="px-6 py-3.5">Status</th>
              <th className="px-6 py-3.5">Gmail</th>
              <th className="px-6 py-3.5">Pending</th>
              <th className="px-6 py-3.5">Replied</th>
              <th className="px-6 py-3.5">Last Sync</th>
              <th className="px-6 py-3.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {filteredEmployees?.map((employee) => (
              <Fragment key={employee.id}>
              <tr className="hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors group">
                <td className="px-6 py-4 cursor-pointer" onClick={() => {
                  const willExpand = expandedId !== employee.id;
                  setExpandedId(willExpand ? employee.id : null);
                  if (willExpand) setExpandedTab({ id: employee.id, tab: 'overview' });
                }}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                      {employee.firstName[0]}
                      {employee.lastName[0]}
                    </div>
                    <div>
                      <div className="font-medium text-[13.5px]">
                        {employee.firstName} {employee.lastName}
                      </div>
                      <div className="text-xs text-gray-500">{employee.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="text-sm">{employee.department?.name ?? '—'}</span>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        'w-2 h-2 rounded-full',
                        employee.status === 'ONLINE'
                          ? 'bg-emerald-500 beacon-dot'
                          : employee.status === 'SUSPENDED'
                          ? 'bg-red-500'
                          : 'bg-gray-300 dark:bg-gray-600'
                      )}
                    />
                    <span className="text-sm capitalize">{employee.status.toLowerCase()}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={cn(
                      'badge',
                      employee.gmailAccount?.status === 'CONNECTED'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : employee.gmailAccount?.status === 'REVOKED'
                        ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                    )}
                  >
                    {employee.gmailAccount?.status ?? 'NOT CONNECTED'}
                  </span>
                  {employee.gmailAccount?.emailAddress && (
                    <div className="text-xs text-gray-500 mt-1">{employee.gmailAccount.emailAddress}</div>
                  )}
                </td>
                <td className="px-6 py-4">
                  {employee.gmailAccount ? (
                    <button
                      onClick={() => {
                        setExpandedId(employee.id);
                        setExpandedTab({ id: employee.id, tab: 'pending' });
                      }}
                      className={cn(
                        'text-sm font-tabular font-medium hover:underline underline-offset-2',
                        employee.inboxCounts.pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'
                      )}
                    >
                      {employee.inboxCounts.pending}
                    </button>
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                </td>
                <td className="px-6 py-4">
                  {employee.gmailAccount ? (
                    <button
                      onClick={() => {
                        setExpandedId(employee.id);
                        setExpandedTab({ id: employee.id, tab: 'replied' });
                      }}
                      className="text-sm font-tabular text-gray-500 hover:underline underline-offset-2"
                    >
                      {employee.inboxCounts.replied}
                    </button>
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm font-tabular text-gray-500">
                  {employee.gmailAccount?.lastSyncedAt
                    ? new Date(employee.gmailAccount.lastSyncedAt).toLocaleTimeString()
                    : 'Never'}
                </td>
                <td className="px-6 py-4 text-right relative">
                  {canManage && (
                    <>
                      <button
                        onClick={() => setOpenMenuId(openMenuId === employee.id ? null : employee.id)}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <MoreVertical className="w-4 h-4 text-gray-400" />
                      </button>
                      {openMenuId === employee.id && (
                        <div className="absolute right-6 top-12 z-10 w-48 glass-card p-1 text-left">
                          {employee.status === 'SUSPENDED' ? (
                            <button
                              onClick={() => {
                                statusMutation.mutate({ id: employee.id, status: 'OFFLINE' });
                                setOpenMenuId(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                              <UserCheck className="w-4 h-4" /> Reactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                statusMutation.mutate({ id: employee.id, status: 'SUSPENDED' });
                                setOpenMenuId(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-red-500"
                            >
                              <UserX className="w-4 h-4" /> Suspend
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              const result = await resetPasswordMutation.mutateAsync(employee.id);
                              alert(`Temporary password for ${employee.email}: ${result.data.tempPassword}`);
                              setOpenMenuId(null);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                          >
                            <KeyRound className="w-4 h-4" /> Reset password
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </td>
              </tr>
              {expandedId === employee.id && (
                <tr>
                  <td colSpan={8} className="px-6 pb-4 bg-gray-50/40 dark:bg-gray-900/20">
                    <EmployeeOverviewPanel
                      employeeId={employee.id}
                      initialTab={expandedTab.id === employee.id ? expandedTab.tab : 'overview'}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface EmployeeOverview {
  lastSync: string | null;
  provider: string;
  emailsReceivedToday: number;
  emailsRepliedToday: number;
  emailsReceivedThisWeek: number;
  emailsRepliedThisWeek: number;
  pendingEmails: number;
  unansweredEmails: number;
  unreadEmails: number;
  readEmails: number;
  activeConversations: number;
  closedConversations: number;
  avgReplyTimeSec: number | null;
  firstResponseTimeSec: number | null;
  lastReplyAt: string | null;
}

function formatSeconds(sec: number | null) {
  if (sec === null) return '—';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatTimestamp(iso: string | null) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

/**
 * Live per-employee snapshot shown when a row is expanded in EmployeeTable.
 * Backed by GET /analytics/employees/:id/overview (analyticsQuery.ts —
 * getEmployeeOverview), which reads Email/GmailAccount directly rather than
 * the DailyAnalytics rollup, so this is always current as of the last sync
 * — not just as of the last daily rollup job run.
 *
 * The Pending/Replied tabs go one level deeper via a separate endpoint
 * (getEmployeeEmailList) — deliberately thin (subject/sender/date only, no
 * body/snippet), since raw email content stays employee-only elsewhere in
 * this app; this is a narrow, explicit exception just to identify which
 * email a count refers to.
 */
function EmployeeOverviewPanel({
  employeeId,
  initialTab = 'overview',
}: {
  employeeId: string;
  initialTab?: 'overview' | 'pending' | 'replied';
}) {
  const [tab, setTab] = useState<'overview' | 'pending' | 'replied'>(initialTab);

  // Re-sync if the user clicks a different count cell while this row is already expanded.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['employee-overview', employeeId],
    queryFn: async () => {
      const { data } = await api.get<EmployeeOverview>(`/analytics/employees/${employeeId}/overview`);
      return data;
    },
  });

  if (isLoading) {
    return <div className="text-sm text-gray-400 py-2">Loading employee analytics…</div>;
  }
  if (error) {
    return <div className="text-sm text-gray-400 py-2">No mail account connected for this employee yet.</div>;
  }
  if (!data) return null;

  const stats: { label: string; value: string }[] = [
    { label: 'Last sync', value: formatTimestamp(data.lastSync) },
    { label: 'Emails received today', value: String(data.emailsReceivedToday) },
    { label: 'Emails replied today', value: String(data.emailsRepliedToday) },
    { label: 'Emails received this week', value: String(data.emailsReceivedThisWeek) },
    { label: 'Emails replied this week', value: String(data.emailsRepliedThisWeek) },
    { label: 'Pending / unanswered', value: String(data.pendingEmails) },
    { label: 'Unread', value: String(data.unreadEmails) },
    { label: 'Read', value: String(data.readEmails) },
    { label: 'Active conversations', value: String(data.activeConversations) },
    { label: 'Closed conversations', value: String(data.closedConversations) },
    { label: 'Avg reply time', value: formatSeconds(data.avgReplyTimeSec) },
    { label: 'First response time', value: formatSeconds(data.firstResponseTimeSec) },
    { label: 'Last reply', value: formatTimestamp(data.lastReplyAt) },
  ];

  return (
    <div className="py-3">
      <div className="flex items-center gap-1 mb-3 border-b border-gray-100 dark:border-gray-800">
        {(['overview', 'pending', 'replied'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2 text-xs font-medium capitalize border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            )}
          >
            {t === 'overview' ? 'Overview' : t === 'pending' ? `Pending (${data.pendingEmails})` : 'Replied'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-[11px] uppercase tracking-wide text-gray-400 font-mono">{s.label}</div>
              <div className="text-sm font-medium mt-0.5">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {(tab === 'pending' || tab === 'replied') && (
        <EmployeeEmailList employeeId={employeeId} status={tab} />
      )}
    </div>
  );
}

interface EmployeeEmailListItem {
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  repliedAt: string | null;
  pendingDurationSec: number | null;
}

function EmployeeEmailList({ employeeId, status }: { employeeId: string; status: 'pending' | 'replied' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['employee-emails', employeeId, status],
    queryFn: async () => {
      const { data } = await api.get<{ emails: EmployeeEmailListItem[]; nextCursor: string | null }>(
        `/analytics/employees/${employeeId}/emails`,
        { params: { status, limit: 20 } }
      );
      return data;
    },
  });

  if (isLoading) return <div className="text-sm text-gray-400 py-2">Loading emails…</div>;
  if (error) return <div className="text-sm text-gray-400 py-2">Couldn't load emails.</div>;
  if (!data || data.emails.length === 0) {
    return <div className="text-sm text-gray-400 py-2">No {status} emails.</div>;
  }

  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-800">
      {data.emails.map((e) => (
        <div key={e.id} className="py-2.5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{e.subject || '(no subject)'}</div>
            <div className="text-xs text-gray-500 truncate">{e.fromName ? `${e.fromName} · ${e.fromAddress}` : e.fromAddress}</div>
          </div>
          <div className="text-xs text-gray-400 font-tabular shrink-0 text-right">
            {status === 'pending' ? (
              <>
                <div>{new Date(e.receivedAt).toLocaleString()}</div>
                {e.pendingDurationSec != null && <div>waiting {formatSeconds(e.pendingDurationSec)}</div>}
              </>
            ) : (
              <div>replied {formatTimestamp(e.repliedAt)}</div>
            )}
          </div>
        </div>
      ))}
      {data.nextCursor && (
        <div className="text-xs text-gray-400 pt-2">Showing most recent 20 — more exist.</div>
      )}
    </div>
  );
}
