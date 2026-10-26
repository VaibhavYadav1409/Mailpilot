'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, CheckCircle2, ChevronLeft, ChevronRight, Copy, Link2, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { HolidaysCard } from '@/components/mis/HolidaysCard';
import { IntimationReportCard } from '@/components/mis/IntimationReportCard';
import { dmy, monthLabel, shiftMonth } from '@/components/mis/circleApi';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

type LeaveType = 'PLANNED' | 'EMERGENCY' | 'ABSENT' | 'SATURDAY_OFF';
type LeaveStatus = 'APPROVED' | 'REJECTED';

interface Leave {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  personName: string;
  email: string | null;
  from: string;
  to: string;
  workingDays: number;
  type: LeaveType;
  status: LeaveStatus;
  leaveKind: string | null;
  reason: string | null;
  note: string | null;
  submittedAt: string | null;
  noticeDays: number | null;
  source: 'FORM' | 'MANUAL' | 'REPORT';
  editedInApp: boolean;
}

interface LeaveData {
  leaves: Leave[];
  people: { employeeId: string; name: string; username: string; saturdaysOff?: boolean }[];
  settings: {
    noticeDays: number;
    lastReceivedAt: string | null;
    lastSummary: {
      mode?: string;
      received: number;
      created: number;
      updated: number;
      unchanged: number;
      keptManualEdits: number;
      unmatched: string[];
      errors: string[];
      columns: Record<string, string>;
    } | null;
  };
  formUrl: string;
  script: string;
}

// The response sheet's link is kept only in this browser (the code is public).
const LINK_KEY = 'mailpilot.leaveSheetLink';
const storedLink = () => {
  try {
    return typeof window === 'undefined' ? '' : window.localStorage.getItem(LINK_KEY) ?? '';
  } catch {
    return '';
  }
};
const errText = (e: unknown, fallback: string) => (e as any)?.response?.data?.error ?? fallback;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
const monthEnd = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
};

export default function MisLeavePage() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = !!role && ['ADMIN', 'COO', 'CEO'].includes(role);
  const [month, setMonth] = useState(thisMonth());
  const [allMonths, setAllMonths] = useState(false);
  const [search, setSearch] = useState('');
  const [gid, setGid] = useState('1231513219');
  const params = allMonths ? { gid } : { from: `${month}-01`, to: monthEnd(month), gid };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['mis-leaves', params],
    queryFn: async () => (await api.get<LeaveData>('/mis/leaves', { params })).data,
  });

  const rows = (data?.leaves ?? []).filter((l) =>
    `${l.employeeName ?? ''} ${l.personName} ${l.reason ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const approved = rows.filter((l) => l.status === 'APPROVED');
  const unmatched = rows.filter((l) => !l.employeeId);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1400px]">
      <PageHeader
        eyebrow="MIS"
        title="Leave Records"
        subtitle="Leave from the Google leave form, approved automatically. Approved leave days need no MIS — they are never red circles and get no warning email."
      />

      <RulesCard noticeDays={data?.settings.noticeDays ?? 2} canEdit={canEdit} />

      <IntimationReportCard canEdit={canEdit} />

      {data && <ConnectCard data={data} gid={gid} setGid={setGid} />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-800">
          <button onClick={() => setMonth(shiftMonth(month, -1))} disabled={allMonths} className="p-2 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40" aria-label="Previous month">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-3 text-sm font-medium min-w-[130px] text-center">{allMonths ? 'All months' : monthLabel(month)}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={allMonths} className="p-2 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40" aria-label="Next month">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} /> Show all
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or reason"
            className="pl-9 pr-3 py-2 w-60 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
          />
        </div>
        <span className="text-xs text-gray-500 ml-auto">
          {approved.length} approved · {approved.filter((l) => l.type === 'EMERGENCY').length} emergency · {approved.reduce((n, l) => n + l.workingDays, 0)} working days
        </span>
      </div>

      {unmatched.length > 0 && (
        <div className="glass-card px-5 py-3 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {unmatched.length} request{unmatched.length === 1 ? '' : 's'} couldn't be matched to a person automatically — choose the person in the table below (until then they don't count as leave).
        </div>
      )}

      {isLoading && <div className="glass-card h-64 animate-pulse" />}
      {isError && (
        <div className="glass-card p-6 flex items-center justify-between">
          <p className="text-sm text-gray-500">Couldn't load leave records.</p>
          <button onClick={() => refetch()} className="btn-secondary">
            Retry
          </button>
        </div>
      )}
      {data && <LeaveTable rows={rows} people={data.people} canEdit={canEdit} />}
      {data && canEdit && <AddLeave people={data.people} />}

      {data && <SaturdaysOffCard people={data.people} canEdit={canEdit} />}

      <HolidaysCard year={Number(month.slice(0, 4))} canEdit={canEdit} defaultOpen />
    </div>
  );
}

// ---------------------------------------------------------------------------

function RulesCard({ noticeDays, canEdit }: { noticeDays: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: (n: number) => api.put('/mis/leaves/settings', { noticeDays: n }),
    onSuccess: () => {
      setValue(null);
      qc.invalidateQueries({ queryKey: ['mis-leaves'] });
      qc.invalidateQueries({ queryKey: ['mis-circle'] });
    },
  });
  const n = value ?? noticeDays;
  return (
    <div className="glass-card p-5 grid gap-4 md:grid-cols-3 text-sm">
      <div className="rounded-lg border border-sky-200 dark:border-sky-900 p-4">
        <p className="font-semibold text-sky-800 dark:text-sky-300">Planned leave (OL)</p>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Form filled at least <b>{noticeDays} days</b> before the leave starts — e.g. on the 12th for the 15th. Approved automatically.
        </p>
      </div>
      <div className="rounded-lg border border-amber-200 dark:border-amber-900 p-4">
        <p className="font-semibold text-amber-800 dark:text-amber-300">Emergency leave (EL)</p>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Form filled later than that, or after the leave was taken. Also approved automatically, but marked as emergency.
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <p className="font-semibold">What leave does</p>
        <p className="text-gray-600 dark:text-gray-400">
          Approved leave days need no MIS: never a red circle, no 9:30 warning, shown as OL / EL on the Circle Report — past days update too. Change or reject any request below.
        </p>
        {canEdit && (
          <div className="flex items-center gap-2 text-xs">
            Planned = asked at least
            <input
              type="number"
              min={0}
              max={30}
              value={n}
              onChange={(e) => setValue(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
              className="w-14 px-2 py-1 border border-gray-200 dark:border-gray-800 rounded bg-transparent"
            />
            days before
            {value !== null && value !== noticeDays && (
              <button onClick={() => save.mutate(n)} disabled={save.isPending} className="btn-secondary text-xs">
                {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConnectCard({ data, gid, setGid }: { data: LeaveData; gid: string; setGid: (g: string) => void }) {
  const [open, setOpen] = useState(!data.settings.lastReceivedAt);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState(storedLink);
  const qc = useQueryClient();
  const rotate = useMutation({ mutationFn: () => api.post('/mis/leaves/token'), onSuccess: () => qc.invalidateQueries({ queryKey: ['mis-leaves'] }) });
  const s = data.settings.lastSummary;
  const connected = !!data.settings.lastReceivedAt;
  return (
    <div className={cn('glass-card overflow-hidden', !connected && 'ring-1 ring-amber-300 dark:ring-amber-700')}>
      <button onClick={() => setOpen(!open)} className="w-full px-5 py-3 flex items-center gap-2 text-left">
        {connected ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Link2 className="w-4 h-4 text-amber-500" />}
        <span className="text-sm font-semibold">Google leave form</span>
        <span className="text-xs text-gray-500">
          {connected
            ? `Connected — last received ${when(data.settings.lastReceivedAt!)}${s ? ` (${s.received} responses: ${s.created} new, ${s.updated} updated)` : ''}`
            : 'Not connected yet — 2-minute setup'}
        </span>
        <span className="ml-auto text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3 text-sm">
          <ol className="list-decimal pl-5 space-y-1.5 text-gray-700 dark:text-gray-300">
            <li>
              Open the leave form's{' '}
              {link.startsWith('https://') ? (
                <a href={link} target="_blank" rel="noreferrer" className="text-primary underline">
                  response sheet
                </a>
              ) : (
                <b>response sheet</b>
              )}{' '}
              (paste its link in the box below once) → menu <b>Extensions → Apps Script</b>.
            </li>
            <li>
              Delete what is in the editor, click <b>Copy script</b> below and paste it there. Click <b>Save</b> (disk icon).
            </li>
            <li>
              In the function list at the top choose <b>setup</b>, click <b>Run</b>, and allow access (Google asks once: “Advanced → Go to project”).
            </li>
            <li>That's it — all existing requests arrive now, new ones within seconds, and edits in the sheet every hour.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                try {
                  window.localStorage.setItem(LINK_KEY, e.target.value.trim());
                } catch {
                  /* not saved — fine */
                }
                const m = /gid=(\d+)/.exec(e.target.value);
                if (m) setGid(m[1]);
              }}
              placeholder="Paste the response sheet link (https://docs.google.com/spreadsheets/…)"
              className="flex-1 min-w-[280px] px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-xs"
              title="Response sheet link — its tab (gid) is put into the script"
            />
            <span className="text-[11px] text-gray-500">tab {gid || 'first'}</span>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(data.script);
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              }}
              className="btn-primary text-sm flex items-center gap-2"
            >
              <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy script'}
            </button>
          </div>
          {s && (
            <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
              <p>
                Columns understood:{' '}
                {Object.entries(s.columns)
                  .map(([k, v]) => `${k} = “${v}”`)
                  .join(' · ') || '—'}
              </p>
              {s.keptManualEdits > 0 && <p>{s.keptManualEdits} request(s) edited in MailPilot were left as you edited them.</p>}
              {s.unmatched.length > 0 && <p className="text-amber-600">Not matched to a person: {s.unmatched.join(', ')} — choose the person in the table.</p>}
              {s.errors.length > 0 && <p className="text-red-600">Couldn't read: {s.errors.slice(0, 5).join(' · ')}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            The script holds a private link to MailPilot — don't share it outside HR.
            <button
              onClick={() => {
                if (window.confirm('Make a new private link? The script already in the sheet stops working until you paste the new script and run setup again.')) rotate.mutate();
              }}
              disabled={rotate.isPending}
              className="underline hover:text-red-600"
            >
              {rotate.isPending ? 'Making…' : 'Make a new link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LeaveTable({ rows, people, canEdit }: { rows: Leave[]; people: LeaveData['people']; canEdit: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['mis-leaves'] });
    qc.invalidateQueries({ queryKey: ['mis-circle'] });
    qc.invalidateQueries({ queryKey: ['msi-admin'] });
    qc.invalidateQueries({ queryKey: ['mis-sources'] });
  };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<Leave, 'employeeId' | 'from' | 'to' | 'type' | 'status' | 'reason'>> }) => api.patch(`/mis/leaves/${id}`, body),
    onSuccess: () => {
      setErr('');
      refresh();
    },
    onError: (e) => setErr(errText(e, 'Could not save.')),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/mis/leaves/${id}`), onSuccess: refresh, onError: (e) => setErr(errText(e, 'Could not delete.')) });
  const sorted = useMemo(() => [...rows].sort((a, b) => b.from.localeCompare(a.from) || a.personName.localeCompare(b.personName)), [rows]);
  const input = 'px-2 py-1 border border-gray-200 dark:border-gray-800 rounded-md bg-transparent text-xs';

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-3 flex items-center gap-2 border-b border-gray-100 dark:border-gray-800">
        <CalendarCheck className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Leave requests ({rows.length})</h2>
        {canEdit && <span className="text-xs text-gray-500 ml-auto">Every field can be changed — changes apply to the Circle Report straight away.</span>}
      </div>
      {err && <p className="px-5 py-2 text-xs text-red-600">{err}</p>}
      {sorted.length === 0 ? (
        <p className="p-8 text-center text-sm text-gray-500">No leave requests for this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-gray-400 text-left border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-2.5">Person</th>
                <th className="px-2 py-2.5">From</th>
                <th className="px-2 py-2.5">To</th>
                <th className="px-2 py-2.5">Working days</th>
                <th className="px-2 py-2.5">Type</th>
                <th className="px-2 py-2.5">Status</th>
                <th className="px-2 py-2.5">Reason</th>
                <th className="px-2 py-2.5">Asked</th>
                {canEdit && <th className="px-2 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => (
                <tr key={`${l.id}|${l.from}|${l.to}|${l.reason ?? ""}`} className={cn('border-b border-gray-50 dark:border-gray-900 align-top', l.status === 'REJECTED' && 'opacity-60')}>
                  <td className="px-4 py-2">
                    {canEdit ? (
                      <select
                        value={l.employeeId ?? ''}
                        onChange={(e) => patch.mutate({ id: l.id, body: { employeeId: e.target.value || null } })}
                        className={cn(input, 'w-44', !l.employeeId && 'border-amber-400 text-amber-700')}
                      >
                        <option value="">⚠ choose person</option>
                        {people.map((p) => (
                          <option key={p.employeeId} value={p.employeeId}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-medium">{l.employeeName ?? l.personName}</span>
                    )}
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      Form: {l.personName}
                      {l.email ? ` · ${l.email}` : ''}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    {canEdit ? (
                      <input type="date" defaultValue={l.from} onBlur={(e) => e.target.value && e.target.value !== l.from && patch.mutate({ id: l.id, body: { from: e.target.value } })} className={input} />
                    ) : (
                      dmy(l.from)
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {canEdit ? (
                      <input type="date" defaultValue={l.to} onBlur={(e) => e.target.value && e.target.value !== l.to && patch.mutate({ id: l.id, body: { to: e.target.value } })} className={input} />
                    ) : (
                      dmy(l.to)
                    )}
                  </td>
                  <td className="px-2 py-2 text-center">{l.workingDays}</td>
                  <td className="px-2 py-2">
                    <select
                      disabled={!canEdit}
                      value={l.type}
                      onChange={(e) => patch.mutate({ id: l.id, body: { type: e.target.value as LeaveType } })}
                      className={cn(input, l.type === 'EMERGENCY' ? 'text-amber-700 dark:text-amber-400' : 'text-sky-700 dark:text-sky-300')}
                    >
                      <option value="PLANNED">Planned (OL)</option>
                      <option value="EMERGENCY">Emergency (EL)</option>
                      <option value="ABSENT">Absent (A)</option>
                      <option value="SATURDAY_OFF">Saturday off (SO)</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      disabled={!canEdit}
                      value={l.status}
                      onChange={(e) => patch.mutate({ id: l.id, body: { status: e.target.value as LeaveStatus } })}
                      className={cn(input, l.status === 'APPROVED' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}
                    >
                      <option value="APPROVED">Approved</option>
                      <option value="REJECTED">Rejected</option>
                    </select>
                  </td>
                  <td className="px-2 py-2 max-w-[260px]">
                    {canEdit ? (
                      <input
                        defaultValue={l.reason ?? ''}
                        onBlur={(e) => e.target.value.trim() !== (l.reason ?? '') && patch.mutate({ id: l.id, body: { reason: e.target.value.trim() || null } })}
                        className={cn(input, 'w-56')}
                      />
                    ) : (
                      <span className="text-xs">{l.reason ?? '—'}</span>
                    )}
                    {l.leaveKind && <div className="text-[11px] text-gray-500 mt-0.5">{l.leaveKind}</div>}
                  </td>
                  <td className="px-2 py-2 text-[11px] text-gray-500 whitespace-nowrap">
                    {l.submittedAt ? when(l.submittedAt) : '—'}
                    {l.noticeDays !== null && (
                      <div>{l.noticeDays > 0 ? `${l.noticeDays} day${l.noticeDays === 1 ? '' : 's'} before` : l.noticeDays === 0 ? 'same day' : `${-l.noticeDays} day${l.noticeDays === -1 ? '' : 's'} after`}</div>
                    )}
                    <div>
                      {l.source === 'FORM' ? 'Google form' : l.source === 'REPORT' ? 'Intimation report' : 'Added here'}
                      {l.editedInApp && l.source === 'FORM' ? ' · edited' : ''}
                    </div>
                  </td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete this leave request (${l.employeeName ?? l.personName}, ${dmy(l.from)})? Those days will count normally again.`)) del.mutate(l.id);
                        }}
                        className="text-gray-400 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddLeave({ people }: { people: LeaveData['people'] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ employeeId: '', from: '', to: '', type: 'PLANNED' as LeaveType, reason: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const add = useMutation({
    mutationFn: () => api.post('/mis/leaves', { ...form, to: form.to || form.from, reason: form.reason || null }),
    onSuccess: () => {
      setMsg({ ok: true, text: 'Leave added.' });
      setForm({ employeeId: '', from: '', to: '', type: 'PLANNED', reason: '' });
      qc.invalidateQueries({ queryKey: ['mis-leaves'] });
      qc.invalidateQueries({ queryKey: ['mis-circle'] });
    },
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not add the leave.') }),
  });
  const input = 'px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      className="glass-card p-5 flex flex-wrap items-end gap-3"
    >
      <div className="text-sm font-semibold w-full">Add a leave by hand</div>
      <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} className={cn(input, 'w-52')} required>
        <option value="">Person…</option>
        {people.map((p) => (
          <option key={p.employeeId} value={p.employeeId}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="text-xs text-gray-500">
        From
        <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={cn(input, 'block')} required />
      </label>
      <label className="text-xs text-gray-500">
        To
        <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} className={cn(input, 'block')} />
      </label>
      <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LeaveType })} className={input}>
        <option value="PLANNED">Planned (OL)</option>
        <option value="EMERGENCY">Emergency (EL)</option>
        <option value="ABSENT">Absent (A)</option>
        <option value="SATURDAY_OFF">Saturday off (SO)</option>
      </select>
      <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Reason (optional)" className={cn(input, 'w-60')} />
      <button type="submit" disabled={add.isPending || !form.employeeId || !form.from} className="btn-primary flex items-center gap-2">
        {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add leave
      </button>
      {msg && <span className={cn('text-xs', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------

/** People whose every Saturday is off (not only the 2nd): no MIS, no circle, Friday's deadline moves to Monday. */
function SaturdaysOffCard({ people, canEdit }: { people: LeaveData['people']; canEdit: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const toggle = useMutation({
    mutationFn: (v: { employeeId: string; off: boolean }) => api.put('/mis/leaves/saturdays-off', v),
    onSuccess: () => {
      setErr('');
      for (const k of ['mis-leaves', 'mis-circle', 'msi-admin', 'mis-sources']) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => setErr(errText(e, 'Could not save.')),
  });
  const on = people.filter((p) => p.saturdaysOff);
  const shown = people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarCheck className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Every Saturday off</h2>
        <span className="text-xs text-gray-500">
          {on.length ? `On for: ${on.map((p) => p.name).join(', ')}` : 'Nobody yet — everyone works the 1st, 3rd, 4th and 5th Saturday.'}
        </span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        For people whose every Saturday is off: no MIS is needed on any Saturday and it is never a red circle (shown as SO). Their Friday MIS is due by 12:00 PM on Monday. Past Saturdays update too.
      </p>
      {canEdit && (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a person"
            className="px-3 py-1.5 w-60 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm"
          />
          <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
            {shown.map((p) => (
              <label
                key={p.employeeId}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs cursor-pointer',
                  p.saturdaysOff ? 'border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800' : 'border-gray-200 dark:border-gray-800',
                )}
              >
                <input type="checkbox" checked={!!p.saturdaysOff} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ employeeId: p.employeeId, off: e.target.checked })} />
                {p.name}
              </label>
            ))}
          </div>
        </>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}
