'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Clock,
  Copy,
  Eye,
  Link2,
  Loader2,
  MailCheck,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/utils/cn';

interface Settings {
  enabled: boolean;
  sendTime: string;
  audience: 'ALL' | 'ISSUES';
  skipOffDays: boolean;
  hrSummary: boolean;
  hrEmails: string | null;
  subject: string | null;
  intro: string | null;
  footer: string | null;
  lastRunDate: string | null;
  lastRunAt: string | null;
  lastRunSummary: RunSummary | null;
}

interface RunSummary {
  runDate: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  sent: number;
  failed: number;
  skipped: number;
  noEmail: string[];
  hr: string | null;
  note: string | null;
  errors: string[];
}

interface Sender {
  driver: string;
  from: string | null;
  canSend: boolean;
  problem: string | null;
  needsReconnect: boolean;
}

interface Recipient {
  employeeId: string;
  name: string;
  username: string;
  email: string | null;
  emailSource: 'CONTACT' | 'LOGIN' | null;
  hasMis: boolean;
}

interface EmailData {
  settings: Settings;
  sender: Sender;
  recipients: Recipient[];
  cronUrl: string;
  timezone: string;
}

interface LogRow {
  id: string;
  runDate: string;
  trigger: string;
  name: string | null;
  toEmail: string;
  subject: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error: string | null;
  createdAt: string;
}

const errText = (e: unknown, fallback: string) => (e as any)?.response?.data?.error ?? fallback;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const time12 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export default function MisEmailPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['mis-email'], queryFn: async () => (await api.get<EmailData>('/mis/email')).data });
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  // Back from Microsoft sign-in (?mis=connected / ?misError=…).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mis') === 'connected') setFlash({ ok: true, text: `Signed in as ${q.get('account') ?? ''}. If the box below is green, sending is allowed.` });
    else if (q.get('misError')) setFlash({ ok: false, text: `Microsoft sign-in failed: ${q.get('misError')}` });
    if (q.has('mis') || q.has('misError')) {
      window.history.replaceState(null, '', window.location.pathname);
      qc.invalidateQueries({ queryKey: ['mis-email'] });
    }
  }, [qc]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1200px]">
      <PageHeader
        eyebrow="MIS"
        title="MIS Emails"
        subtitle="One email to every MIS staff member each night: their MIS status, what is missing, the deadline, and their red circles this month — plus a summary for HR."
      />

      {flash && <div className={cn('glass-card px-5 py-3 text-sm', flash.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>{flash.text}</div>}
      {isLoading && <div className="glass-card h-64 animate-pulse" />}
      {isError && (
        <div className="glass-card p-6 flex items-center justify-between">
          <p className="text-sm text-gray-500">Couldn't load the email settings.</p>
          <button onClick={() => refetch()} className="btn-secondary">
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <SenderCard sender={data.sender} />
          <SettingsCard data={data} />
          <RecipientsCard recipients={data.recipients} />
          <PreviewCard data={data} />
          <BackupScheduleCard data={data} />
          <LogCard settings={data.settings} canSend={data.sender.canSend} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SenderCard({ sender }: { sender: Sender }) {
  const start = useMutation({
    mutationFn: async () => (await api.post<{ authUrl: string }>('/mis/connection/start', { page: 'mis-email' })).data.authUrl,
    onSuccess: (url) => {
      window.location.href = url;
    },
  });
  return (
    <div className={cn('glass-card p-5 flex flex-wrap items-start gap-4', sender.canSend ? '' : 'ring-1 ring-amber-300 dark:ring-amber-700')}>
      {sender.canSend ? <ShieldCheck className="w-6 h-6 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0" />}
      <div className="flex-1 min-w-[260px] text-sm">
        <p className="font-semibold">{sender.canSend ? 'Ready to send' : 'Sending is not set up yet'}</p>
        <p className="text-gray-600 dark:text-gray-400 mt-0.5">
          {sender.driver === 'graph' ? (
            <>
              Emails are sent free from <b>{sender.from ?? 'the Microsoft 365 account'}</b> through Microsoft 365 — a copy of each one stays in its Sent Items.
            </>
          ) : (
            <>
              Sender: <b>{sender.from ?? '—'}</b> ({sender.driver}).
            </>
          )}
        </p>
        {sender.problem && <p className="text-amber-700 dark:text-amber-400 mt-1">{sender.problem}</p>}
        {sender.needsReconnect && sender.driver === 'graph' && (
          <p className="text-xs text-gray-500 mt-1">
            Microsoft will ask to “Send mail as you” — accept it. Reading the MIS files keeps working while you do this. If Microsoft says an admin must approve, see step 1 in
            “Before you switch it on” at the bottom of this page.
          </p>
        )}
        {start.isError && <p className="text-xs text-red-600 mt-1">{errText(start.error, 'Could not start Microsoft sign-in.')}</p>}
      </div>
      {sender.needsReconnect && sender.driver === 'graph' && (
        <button onClick={() => start.mutate()} disabled={start.isPending} className="btn-primary flex items-center gap-2">
          {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
          Allow sending{sender.from ? ` (${sender.from})` : ''}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SettingsCard({ data }: { data: EmailData }) {
  const qc = useQueryClient();
  const s = data.settings;
  const [form, setForm] = useState({
    enabled: s.enabled,
    sendTime: s.sendTime,
    audience: s.audience,
    skipOffDays: s.skipOffDays,
    hrSummary: s.hrSummary,
    hrEmails: s.hrEmails ?? '',
    subject: s.subject ?? '',
    intro: s.intro ?? '',
    footer: s.footer ?? '',
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.put('/mis/email/settings', form),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      qc.invalidateQueries({ queryKey: ['mis-email'] });
    },
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const missing = data.recipients.filter((r) => !r.email).length;

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Schedule and content</h2>
      </div>

      <label className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
        <input type="checkbox" className="w-4 h-4" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span className="text-sm">
          <b>Send the nightly email</b>
          <span className="block text-xs text-gray-500">
            {form.enabled
              ? `Every night at ${time12(form.sendTime)} (India time) to ${data.recipients.length - missing} people${missing ? ` — ${missing} have no email yet` : ''}.`
              : 'Off — nothing is sent automatically. You can still preview and send a test below.'}
          </span>
        </span>
      </label>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm space-y-1">
          <span className="text-xs font-medium text-gray-500">Send time (India time)</span>
          <input type="time" value={form.sendTime} onChange={(e) => set('sendTime', e.target.value)} className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent" />
          <span className="block text-[11px] text-gray-500">00:00 = midnight. A run just after midnight reports the day that just ended.</span>
        </label>
        <label className="text-sm space-y-1">
          <span className="text-xs font-medium text-gray-500">Who gets it</span>
          <select value={form.audience} onChange={(e) => set('audience', e.target.value as 'ALL' | 'ISSUES')} className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent">
            <option value="ALL">Everyone, every night</option>
            <option value="ISSUES">Only people with something missing / a red circle</option>
          </select>
        </label>
        <label className="text-sm flex items-start gap-2 pt-6">
          <input type="checkbox" className="mt-0.5" checked={form.skipOffDays} onChange={(e) => set('skipOffDays', e.target.checked)} />
          <span>
            Don't send on days off
            <span className="block text-[11px] text-gray-500">Sundays, 2nd Saturday, holidays</span>
          </span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-[auto_1fr] items-start">
        <label className="text-sm flex items-center gap-2 pt-2">
          <input type="checkbox" checked={form.hrSummary} onChange={(e) => set('hrSummary', e.target.checked)} /> Summary for HR
        </label>
        <label className="text-sm space-y-1">
          <input
            value={form.hrEmails}
            onChange={(e) => set('hrEmails', e.target.value)}
            disabled={!form.hrSummary}
            placeholder="hr@farsightshares.com, boss@farsightshares.com"
            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent disabled:opacity-50"
          />
          <span className="block text-[11px] text-gray-500">One table of everyone: last two working days, red circles and salary days this month.</span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm space-y-1">
          <span className="text-xs font-medium text-gray-500">Subject</span>
          <input
            value={form.subject}
            onChange={(e) => set('subject', e.target.value)}
            placeholder="MIS update — {name} — {date}"
            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent"
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="text-xs font-medium text-gray-500">Opening line</span>
          <input
            value={form.intro}
            onChange={(e) => set('intro', e.target.value)}
            placeholder="Here is your MIS status from MailPilot."
            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent"
          />
        </label>
      </div>
      <label className="text-sm space-y-1 block">
        <span className="text-xs font-medium text-gray-500">Closing note (optional)</span>
        <textarea
          value={form.footer}
          onChange={(e) => set('footer', e.target.value)}
          rows={2}
          placeholder="e.g. Please fill your MIS before leaving the office. Questions: HR, ext. 201."
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent"
        />
        <span className="block text-[11px] text-gray-500">You can use {'{first}'}, {'{name}'}, {'{date}'}, {'{month}'} in the subject, opening line and closing note.</span>
      </label>

      <div className="flex items-center gap-3">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary flex items-center gap-2">
          {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save
        </button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        {save.isError && <span className="text-sm text-red-600">{errText(save.error, 'Could not save.')}</span>}
        {form.enabled && !data.sender.canSend && <span className="text-xs text-amber-600">Nothing can be sent until “Allow sending” above is done.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RecipientsCard({ recipients }: { recipients: Recipient[] }) {
  const qc = useQueryClient();
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const missing = recipients.filter((r) => !r.email);
  const save = useMutation({
    mutationFn: ({ id, email }: { id: string; email: string | null }) => api.put(`/mis/email/recipients/${id}`, { email }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mis-email'] }),
  });
  const bulk = useMutation({
    mutationFn: async () => {
      const rows = parsePastedEmails(paste);
      if (!rows.length) throw new Error('Paste rows like: Mamta [tab] mamta@company.com');
      return (await api.post<{ updated: { name: string; matched: string }[]; notFound: string[]; invalid: string[] }>('/mis/email/recipients/bulk', { rows })).data;
    },
    onSuccess: (r) => {
      setResult(
        `${r.updated.length} saved.${r.notFound.length ? ` Not found: ${r.notFound.join(', ')}.` : ''}${r.invalid.length ? ` Not an email: ${r.invalid.join('; ')}.` : ''}`,
      );
      if (!r.notFound.length && !r.invalid.length) setPaste('');
      qc.invalidateQueries({ queryKey: ['mis-email'] });
    },
    onError: (e) => setResult((e as Error).message),
  });

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-4 flex flex-wrap items-center gap-3 border-b border-gray-100 dark:border-gray-800">
        <Users className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Who gets it ({recipients.length})</h2>
        {missing.length > 0 ? (
          <span className="text-xs text-amber-600">{missing.length} without an email address — they are skipped.</span>
        ) : (
          <span className="text-xs text-emerald-600">Everyone has an email address.</span>
        )}
        <button onClick={() => setShowPaste(!showPaste)} className="btn-secondary text-sm ml-auto flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4" /> {showPaste ? 'Close' : 'Paste emails from Excel'}
        </button>
      </div>
      {showPaste && (
        <div className="px-5 py-4 space-y-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/30">
          <p className="text-xs text-gray-500">
            One person per line: the name, then their email(s) — copied from Excel or typed like “Diya - farsightkunjee@gmail.com and info@trryitt.com”. Names are matched to the MIS
            logins (e.g. “Anjali Jha” → ANJALI); someone with two addresses gets the email at both.
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            placeholder={'Mamta\tmamta@farsightshares.com\nAnjali Jha\tanjali@farsightshares.com'}
            className="w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-950 font-mono text-xs"
          />
          <div className="flex items-center gap-3">
            <button onClick={() => bulk.mutate()} disabled={bulk.isPending || !paste.trim()} className="btn-primary text-sm flex items-center gap-2">
              {bulk.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save emails
            </button>
            {result && <span className="text-xs text-gray-600 dark:text-gray-400">{result}</span>}
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-gray-400 text-left border-b border-gray-100 dark:border-gray-800">
              <th className="px-5 py-2.5">Name</th>
              <th className="px-5 py-2.5">Login</th>
              <th className="px-5 py-2.5">Email for MIS updates</th>
            </tr>
          </thead>
          <tbody>
            {recipients.map((r) => (
              <RecipientRow key={r.employeeId} r={r} onSave={(email) => save.mutate({ id: r.employeeId, email })} saving={save.isPending && save.variables?.id === r.employeeId} />
            ))}
          </tbody>
        </table>
      </div>
      {save.isError && <p className="px-5 py-2 text-xs text-red-600">{errText(save.error, 'Could not save.')}</p>}
    </div>
  );
}

/**
 * One person per line: the name, then one or more email addresses in any
 * format — "01) Diya - Email - a@x.com and b@y.com", "Mamta<tab>m@x.com", …
 */
function parsePastedEmails(text: string): { name: string; email: string }[] {
  const EMAIL = /[^\s,;<>()"']+@[^\s,;<>()"']+\.[^\s,;<>()"']+/g;
  const out: { name: string; email: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const emails = line.match(EMAIL)?.map((e) => e.replace(/[.,;:]+$/, '').toLowerCase()) ?? [];
    if (!emails.length) continue;
    const name = line
      .slice(0, line.search(EMAIL))
      .replace(/^\s*\d+\s*[).:-]?\s*/, '') // "01)"
      .replace(/[-–:\s]*(e-?mail|mail)?[-–:\s]*$/i, '') // "- Email -"
      .trim();
    if (name) out.push({ name, email: [...new Set(emails)].join(', ') });
  }
  return out;
}

function RecipientRow({ r, onSave, saving }: { r: Recipient; onSave: (email: string | null) => void; saving: boolean }) {
  const [value, setValue] = useState(r.emailSource === 'CONTACT' ? r.email ?? '' : '');
  useEffect(() => setValue(r.emailSource === 'CONTACT' ? r.email ?? '' : ''), [r.email, r.emailSource]);
  const changed = value.trim().toLowerCase() !== (r.emailSource === 'CONTACT' ? r.email ?? '' : '');
  return (
    <tr className="border-b border-gray-50 dark:border-gray-900">
      <td className="px-5 py-2">
        <span className="font-medium">{r.name}</span>
        {!r.hasMis && <span className="ml-2 text-[11px] text-amber-600">no MIS file linked</span>}
      </td>
      <td className="px-5 py-2 text-xs text-gray-500 font-mono">{r.username}</td>
      <td className="px-5 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(value.trim() || null);
          }}
          className="flex items-center gap-2"
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={r.emailSource === 'LOGIN' ? `${r.email} (login email)` : 'name@farsightshares.com (comma for more)'}
            className={cn('w-72 px-2.5 py-1.5 border rounded-lg bg-transparent text-sm', r.email ? 'border-gray-200 dark:border-gray-800' : 'border-amber-300 dark:border-amber-700')}
          />
          {changed && (
            <button type="submit" disabled={saving} className="btn-secondary text-xs">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
            </button>
          )}
        </form>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

function PreviewCard({ data }: { data: EmailData }) {
  const [employeeId, setEmployeeId] = useState<string>(data.recipients.find((r) => r.hasMis)?.employeeId ?? data.recipients[0]?.employeeId ?? '');
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const preview = useQuery({
    queryKey: ['mis-email-preview', employeeId],
    queryFn: async () => (await api.get<{ subject: string; html: string; to: string | null; name: string }>('/mis/email/preview', { params: { employeeId } })).data,
    enabled: !!employeeId,
  });
  const test = useMutation({
    mutationFn: async () => (await api.post<RunSummary>('/mis/email/test', { to: testTo, employeeId })).data,
    onSuccess: (r) => setMsg({ ok: true, text: r.note ?? 'Test email sent.' }),
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not send the test email.') }),
  });
  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Eye className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Preview</h2>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm">
          {data.recipients.map((r) => (
            <option key={r.employeeId} value={r.employeeId}>
              {r.name}
            </option>
          ))}
        </select>
        <button onClick={() => preview.refetch()} className="text-gray-500 hover:text-primary" title="Refresh preview">
          <RefreshCw className={cn('w-4 h-4', preview.isFetching && 'animate-spin')} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            test.mutate();
          }}
          className="flex items-center gap-2 ml-auto"
        >
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your email" className="w-56 px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm" />
          <button type="submit" disabled={!testTo.trim() || test.isPending || !data.sender.canSend} className="btn-secondary text-sm flex items-center gap-2" title={data.sender.canSend ? '' : 'Allow sending first'}>
            {test.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send me a test
          </button>
        </form>
      </div>
      {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
      {preview.data && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-4 py-2 text-xs bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 space-y-0.5">
            <div>
              <span className="text-gray-500">To:</span> {preview.data.to ?? <span className="text-amber-600">no email address — would be skipped</span>}
            </div>
            <div>
              <span className="text-gray-500">Subject:</span> <b>{preview.data.subject}</b>
            </div>
          </div>
          <iframe title="Email preview" srcDoc={preview.data.html} sandbox="" className="w-full h-[560px] bg-white" />
        </div>
      )}
      {preview.isError && <p className="text-xs text-red-600">{errText(preview.error, 'Could not build the preview.')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function BackupScheduleCard({ data }: { data: EmailData }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({ mutationFn: () => api.post('/mis/email/cron-token'), onSuccess: () => qc.invalidateQueries({ queryKey: ['mis-email'] }) });
  const [h, m] = data.settings.sendTime.split(':');
  return (
    <div className="glass-card p-5 space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <MailCheck className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Before you switch it on</h2>
      </div>
      <ol className="list-decimal pl-5 space-y-2 text-gray-700 dark:text-gray-300">
        <li>
          <b>Allow sending</b> (box at the top). If Microsoft says an administrator must approve: in{' '}
          <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer" className="text-primary underline">
            Azure → App registrations
          </a>{' '}
          open the MailPilot app → API permissions → Add a permission → Microsoft Graph → Delegated → <b>Mail.Send</b> → Add → <b>Grant admin consent</b>. Then click “Allow sending”
          again.
        </li>
        <li>
          <b>Add email addresses</b> for the staff (table above, or paste from Excel).
        </li>
        <li>
          <b>Preview</b> and <b>send yourself a test</b>, then tick “Send the nightly email” and Save.
        </li>
        <li>
          <b>Backup timer (recommended, free):</b> MailPilot sends on its own at the set time, but if the free server is asleep at that moment the email would be late. A free
          cron-job.org timer wakes it exactly on time (a day is never sent twice):
          <ol className="list-[lower-alpha] pl-5 mt-1 space-y-1 text-gray-600 dark:text-gray-400">
            <li>
              Sign up at{' '}
              <a href="https://console.cron-job.org/signup" target="_blank" rel="noreferrer" className="text-primary underline">
                cron-job.org
              </a>{' '}
              (free) → <b>Create cronjob</b>.
            </li>
            <li>
              Title: <i>MailPilot MIS email</i>. URL: the link below.
            </li>
            <li>
              Schedule: <b>Every day</b> at <b>{h}:{m}</b>, time zone <b>Asia/Kolkata</b> → <b>Create</b>.
            </li>
            <li>If you change the send time here, change it there too.</li>
          </ol>
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <code className="flex-1 min-w-[280px] px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 text-xs break-all">{data.cronUrl}</code>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(data.cronUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="btn-secondary text-sm flex items-center gap-2"
        >
          <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy link'}
        </button>
        <button
          onClick={() => {
            if (window.confirm('Make a new secret link? The old one stops working — update cron-job.org with the new link.')) rotate.mutate();
          }}
          className="btn-secondary text-sm"
        >
          New link
        </button>
      </div>
      <p className="text-[11px] text-gray-500">Keep this link private — anyone with it can trigger tonight's emails (only once a day, and only to your staff).</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LogCard({ settings, canSend }: { settings: Settings; canSend: boolean }) {
  const qc = useQueryClient();
  const log = useQuery({ queryKey: ['mis-email-log'], queryFn: async () => (await api.get<{ log: LogRow[] }>('/mis/email/log')).data.log, refetchInterval: 15_000 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sendNow = useMutation({
    mutationFn: async () => (await api.post<{ note: string }>('/mis/email/send-now')).data,
    onSuccess: (r) => {
      setMsg({ ok: true, text: r.note });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['mis-email-log'] });
        qc.invalidateQueries({ queryKey: ['mis-email'] });
      }, 4000);
    },
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not send.') }),
  });
  const runs = useMemo(() => {
    const map = new Map<string, LogRow[]>();
    for (const r of log.data ?? []) {
      const k = `${r.runDate} · ${r.trigger}`;
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    return [...map.entries()].slice(0, 7);
  }, [log.data]);
  const last = settings.lastRunSummary;

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Send className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Sent emails</h2>
        {last && (
          <span className="text-xs text-gray-500">
            Last run {settings.lastRunAt ? when(settings.lastRunAt) : last.runDate}: {last.sent} sent, {last.failed} failed, {last.skipped} skipped
            {last.note ? ` — ${last.note}` : ''}
          </span>
        )}
        <button
          onClick={() => {
            if (window.confirm('Send the MIS email to everyone now?')) sendNow.mutate();
          }}
          disabled={sendNow.isPending || !canSend}
          className="btn-secondary text-sm ml-auto flex items-center gap-2"
        >
          {sendNow.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send to everyone now
        </button>
      </div>
      {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
      {last?.noEmail?.length ? <p className="text-xs text-amber-600">No email address (skipped): {last.noEmail.join(', ')}</p> : null}
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing sent yet.</p>
      ) : (
        runs.map(([k, rows]) => (
          <details key={k} className="rounded-lg border border-gray-100 dark:border-gray-800">
            <summary className="px-4 py-2 text-sm cursor-pointer">
              <b>{k}</b> — {rows.filter((r) => r.status === 'SENT').length} sent
              {rows.some((r) => r.status === 'FAILED') && <span className="text-red-600">, {rows.filter((r) => r.status === 'FAILED').length} failed</span>}
            </summary>
            <table className="w-full text-xs">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-50 dark:border-gray-900">
                    <td className="px-4 py-1.5 whitespace-nowrap text-gray-500">{when(r.createdAt)}</td>
                    <td className="px-2 py-1.5">{r.name ?? '—'}</td>
                    <td className="px-2 py-1.5 text-gray-500">{r.toEmail}</td>
                    <td className={cn('px-2 py-1.5 font-medium', r.status === 'SENT' ? 'text-emerald-600' : r.status === 'FAILED' ? 'text-red-600' : 'text-gray-400')}>{r.status.toLowerCase()}</td>
                    <td className="px-2 py-1.5 text-gray-500">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}
    </div>
  );
}
