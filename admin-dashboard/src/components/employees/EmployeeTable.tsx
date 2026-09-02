'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { Search, Filter, MoreVertical, KeyRound, UserX, UserCheck, X, Paperclip, Star } from 'lucide-react';
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
  // `pending` counts only mail that actually warrants a reply; mail the AI
  // classified as an acknowledgment / FYI / automated notification is counted
  // under `noReplyNeeded` instead. Optional so an older backend that predates
  // the field doesn't render `undefined` in the cell.
  inboxCounts: { pending: number; replied: number; noReplyNeeded?: number };
}

/**
 * Display name derived from the connected mailbox's local part (the text
 * before the @), title-cased: demat@farsightshares.com -> "Demat",
 * manager.support@acme.com -> "Manager Support". Falls back to the
 * employee's actual name when no mailbox is connected.
 */
function mailboxName(emp: Employee): string {
  const local = emp.gmailAccount?.emailAddress?.split('@')[0] ?? '';
  if (!local) return `${emp.firstName} ${emp.lastName}`.trim();
  return local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Two-letter avatar initials matching the derived mailbox name. */
function mailboxInitials(emp: Employee): string {
  const name = mailboxName(emp);
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export const EmployeeTable = () => {
  const [search, setSearch] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<{ id: string; tab: 'overview' | 'pending' | 'replied' | 'no_reply_needed' }>({
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
              <th className="px-6 py-3.5" title="Unreplied mail that the AI judged actually warrants a response">
                Pending
              </th>
              <th className="px-6 py-3.5">Replied</th>
              <th
                className="px-6 py-3.5"
                title="Unreplied mail that needs no response — acknowledgments, FYIs and automated notifications. Excluded from Pending."
              >
                No Reply
              </th>
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
                      {mailboxInitials(employee)}
                    </div>
                    <div>
                      <div className="font-medium text-[13.5px]">
                        {mailboxName(employee)}
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
                <td className="px-6 py-4">
                  {employee.gmailAccount ? (
                    <button
                      onClick={() => {
                        setExpandedId(employee.id);
                        setExpandedTab({ id: employee.id, tab: 'no_reply_needed' });
                      }}
                      className="text-sm font-tabular text-gray-400 hover:underline underline-offset-2"
                      title="Mail filtered out of Pending because it needs no reply — click to audit what the classifier caught"
                    >
                      {employee.inboxCounts.noReplyNeeded ?? 0}
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
                  <td colSpan={9} className="px-6 pb-4 bg-gray-50/40 dark:bg-gray-900/20">
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
  /** Unreplied mail the AI judged as needing no response. Optional for backend compatibility. */
  noReplyNeededEmails?: number;
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
  initialTab?: 'overview' | 'pending' | 'replied' | 'no_reply_needed';
}) {
  const [tab, setTab] = useState<'overview' | 'pending' | 'replied' | 'no_reply_needed'>(initialTab);
  // The mail currently opened in the full-detail modal (null = none open).
  const [openMailId, setOpenMailId] = useState<string | null>(null);

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
    { label: 'No reply needed', value: String(data.noReplyNeededEmails ?? 0) },
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
        {(['overview', 'pending', 'replied', 'no_reply_needed'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            title={
              t === 'no_reply_needed'
                ? 'Mail excluded from Pending because the AI judged it needs no reply — acknowledgments, FYIs, automated notifications'
                : undefined
            }
            className={cn(
              'px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            )}
          >
            {t === 'overview'
              ? 'Overview'
              : t === 'pending'
              ? `Pending (${data.pendingEmails})`
              : t === 'replied'
              ? 'Replied'
              : `No reply needed (${data.noReplyNeededEmails ?? 0})`}
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

      {tab !== 'overview' && <EmployeeEmailList employeeId={employeeId} status={tab} onOpen={setOpenMailId} />}

      {openMailId && (
        <MailDetailModal employeeId={employeeId} emailId={openMailId} onClose={() => setOpenMailId(null)} />
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
  isCc?: boolean;
  /** "NEEDS_REPLY" | "ACKNOWLEDGMENT" | "INFORMATIONAL" | "AUTOMATED" | null */
  replyClassification?: string | null;
}

const REPLY_CLASS_LABELS: Record<string, string> = {
  ACKNOWLEDGMENT: 'Acknowledgment',
  INFORMATIONAL: 'FYI',
  AUTOMATED: 'Automated',
};

const STATUS_EMPTY_LABEL: Record<string, string> = {
  pending: 'pending',
  replied: 'replied',
  no_reply_needed: 'no-reply-needed',
};

function EmployeeEmailList({
  employeeId,
  status,
  onOpen,
}: {
  employeeId: string;
  status: 'pending' | 'replied' | 'no_reply_needed';
  onOpen: (emailId: string) => void;
}) {
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
    return <div className="text-sm text-gray-400 py-2">No {STATUS_EMPTY_LABEL[status] ?? status} emails.</div>;
  }

  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-800">
      {data.emails.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => onOpen(e.id)}
          className="w-full text-left py-2.5 px-2 -mx-2 flex items-center justify-between gap-4 rounded-lg hover:bg-gray-100/70 dark:hover:bg-gray-800/50 transition-colors"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium truncate flex items-center gap-1.5">
              <span className="truncate">{e.subject || '(no subject)'}</span>
              {e.isCc && (
                <span
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 font-normal"
                  title="Employee was copied in (Cc), not addressed directly"
                >
                  CC
                </span>
              )}
              {/* Showing *why* something was classed as no-reply-needed is the
                  point of this tab — an admin needs to be able to spot the
                  classifier filtering out something it shouldn't have. */}
              {status === 'no_reply_needed' && e.replyClassification && REPLY_CLASS_LABELS[e.replyClassification] && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 font-normal">
                  {REPLY_CLASS_LABELS[e.replyClassification]}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 truncate">{e.fromName ? `${e.fromName} · ${e.fromAddress}` : e.fromAddress}</div>
          </div>
          <div className="text-xs text-gray-400 font-tabular shrink-0 text-right">
            {status === 'replied' ? (
              <div>replied {formatTimestamp(e.repliedAt)}</div>
            ) : (
              <>
                <div>{new Date(e.receivedAt).toLocaleString()}</div>
                {status === 'pending' && e.pendingDurationSec != null && (
                  <div>waiting {formatSeconds(e.pendingDurationSec)}</div>
                )}
              </>
            )}
          </div>
        </button>
      ))}
      {data.nextCursor && (
        <div className="text-xs text-gray-400 pt-2">Showing most recent 20 — more exist.</div>
      )}
    </div>
  );
}

interface EmployeeEmailDetail {
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  receivedAt: string;
  repliedAt: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean;
  isStarred: boolean;
  isCc: boolean;
  isReplied: boolean;
  requiresReply: boolean | null;
  replyClassification: string | null;
  pendingDurationSec: number | null;
  replyTimeSec: number | null;
  threadId: string | null;
  category: { label: string } | null;
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[];
}

/** JSON-encoded string[] header (toAddresses/ccAddresses) -> readable line. */
function parseAddressList(raw: string | null): string {
  if (!raw) return '';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.join(', ') : String(raw);
  } catch {
    return raw;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Full read-only view of a single employee mail, opened from the Pending /
 * Replied / No-reply-needed lists. Shows every header (including the full
 * date/time, which the compact list rows truncate), the body, and the
 * attachment list. The HTML body is rendered inside a sandboxed iframe
 * (sandbox="" — no script execution, no same-origin access) so untrusted
 * mail markup can't run scripts against the admin dashboard.
 */
function MailDetailModal({
  employeeId,
  emailId,
  onClose,
}: {
  employeeId: string;
  emailId: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['employee-email-detail', employeeId, emailId],
    queryFn: async () => {
      const { data } = await api.get<{ email: EmployeeEmailDetail }>(
        `/analytics/employees/${employeeId}/emails/${emailId}`
      );
      return data.email;
    },
  });

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const to = data ? parseAddressList(data.toAddresses) : '';
  const cc = data ? parseAddressList(data.ccAddresses) : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 sm:p-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="glass-card w-full max-w-3xl my-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between gap-4 p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide font-mono">Mail</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="p-8 text-sm text-gray-400">Loading mail…</div>
        ) : error || !data ? (
          <div className="p-8 text-sm text-gray-400">Couldn't load this mail.</div>
        ) : (
          <div className="overflow-y-auto p-6 space-y-4">
            {/* Subject + flags */}
            <div>
              <h2 className="text-lg font-semibold leading-snug flex items-start gap-2">
                {data.isStarred && <Star className="w-4 h-4 mt-1 shrink-0 fill-amber-400 text-amber-400" />}
                <span>{data.subject || '(no subject)'}</span>
              </h2>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {!data.isRead && <span className="badge bg-primary/10 text-primary">Unread</span>}
                {data.isReplied && <span className="badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Replied</span>}
                {data.isCc && <span className="badge bg-gray-100 dark:bg-gray-800 text-gray-500">CC</span>}
                {data.category?.label && (
                  <span className="badge bg-gray-100 dark:bg-gray-800 text-gray-500">{data.category.label}</span>
                )}
                {data.replyClassification && REPLY_CLASS_LABELS[data.replyClassification] && (
                  <span className="badge bg-gray-100 dark:bg-gray-800 text-gray-500">
                    {REPLY_CLASS_LABELS[data.replyClassification]}
                  </span>
                )}
              </div>
            </div>

            {/* Headers — labels aligned, nothing truncated */}
            <div className="text-sm space-y-1.5 border-y border-gray-100 dark:border-gray-800 py-3">
              <div className="flex gap-2">
                <span className="w-14 shrink-0 text-gray-400">From</span>
                <span className="min-w-0 break-words">
                  {data.fromName ? `${data.fromName} <${data.fromAddress}>` : data.fromAddress}
                </span>
              </div>
              {to && (
                <div className="flex gap-2">
                  <span className="w-14 shrink-0 text-gray-400">To</span>
                  <span className="min-w-0 break-words">{to}</span>
                </div>
              )}
              {cc && (
                <div className="flex gap-2">
                  <span className="w-14 shrink-0 text-gray-400">Cc</span>
                  <span className="min-w-0 break-words">{cc}</span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="w-14 shrink-0 text-gray-400">Date</span>
                <span className="min-w-0 break-words font-medium">
                  {new Date(data.receivedAt).toLocaleString(undefined, {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {data.repliedAt && (
                <div className="flex gap-2">
                  <span className="w-14 shrink-0 text-gray-400">Replied</span>
                  <span className="min-w-0 break-words">{new Date(data.repliedAt).toLocaleString()}</span>
                </div>
              )}
            </div>

            {/* Body */}
            {data.bodyHtml ? (
              <iframe
                title="Email body"
                sandbox=""
                className="w-full min-h-[240px] rounded-lg border border-gray-100 dark:border-gray-800 bg-white"
                srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:12px;word-wrap:break-word;overflow-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${data.bodyHtml}</body></html>`}
              />
            ) : (
              <pre className="text-sm whitespace-pre-wrap break-words font-sans text-gray-800 dark:text-gray-200">
                {data.bodyText || data.snippet || '(no content)'}
              </pre>
            )}

            {/* Attachments (metadata only — no download from the admin side) */}
            {data.attachments.length > 0 && (
              <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-mono mb-2">
                  {data.attachments.length} attachment{data.attachments.length === 1 ? '' : 's'}
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.attachments.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 text-xs max-w-[240px]"
                      title={`${a.filename} (${a.mimeType})`}
                    >
                      <Paperclip className="w-3 h-3 shrink-0 text-gray-400" />
                      <span className="truncate">{a.filename}</span>
                      <span className="shrink-0 text-gray-400">{formatBytes(a.sizeBytes)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
