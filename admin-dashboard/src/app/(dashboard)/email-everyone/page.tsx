'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Clock, Loader2, Search, Send, X, XCircle } from 'lucide-react';
import api from '@/services/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

type Audience = 'ALL' | 'MIS' | 'MAILBOX' | 'CHOSEN';
interface Sent {
  id: string;
  subject: string;
  body: string;
  audience: Audience;
  sendAt: string;
  status: 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED';
  total: number;
  sent: number;
  failed: number;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}
interface Data {
  emails: Sent[];
  people: { employeeId: string; name: string; emails: string[]; group: 'MIS' | 'MAILBOX' }[];
  counts: Record<'ALL' | 'MIS' | 'MAILBOX', number>;
  noEmail: string[];
}

const errText = (e: unknown, fallback: string) => (e as any)?.response?.data?.error ?? fallback;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
/** "2026-10-24T15:30" (India time) -> ISO instant. */
const istToIso = (local: string) => new Date(`${local}:00+05:30`).toISOString();
const AUDIENCE_LABEL: Record<Audience, string> = { ALL: 'Everyone', MIS: 'MIS staff', MAILBOX: 'Mailbox users', CHOSEN: 'Chosen people' };
const STATUS: Record<Sent['status'], { text: string; cls: string }> = {
  SCHEDULED: { text: 'Scheduled', cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  SENDING: { text: 'Sending…', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  SENT: { text: 'Sent', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  CANCELLED: { text: 'Cancelled', cls: 'bg-gray-100 dark:bg-gray-800 text-gray-500' },
  FAILED: { text: 'Failed', cls: 'bg-red-500/10 text-red-700 dark:text-red-400' },
};

export default function EmailEveryonePage() {
  const qc = useQueryClient();
  const myEmail = useAuthStore((s) => s.user?.email ?? '');
  const { data, isLoading } = useQuery({
    queryKey: ['company-email'],
    queryFn: async () => (await api.get<Data>('/mis/company-email')).data,
    refetchInterval: (q) => ((q.state.data as Data | undefined)?.emails.some((e) => e.status === 'SENDING' || e.status === 'SCHEDULED') ? 10_000 : false),
  });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Hi {first},\n\n');
  const [audience, setAudience] = useState<Audience>('ALL');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState('');
  const [testTo, setTestTo] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const count = audience === 'CHOSEN' ? chosen.size : data?.counts[audience] ?? 0;
  const shown = useMemo(
    () => (data?.people ?? []).filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())),
    [data, search],
  );

  const send = useMutation({
    mutationFn: () =>
      api.post<{ total: number; sendAt: string; immediate: boolean }>('/mis/company-email', {
        subject,
        body,
        audience,
        employeeIds: audience === 'CHOSEN' ? [...chosen] : undefined,
        sendAt: later && sendAt ? istToIso(sendAt) : null,
      }),
    onSuccess: (r) => {
      setMsg({
        ok: true,
        text: r.data.immediate ? `Sending to ${r.data.total} people now — each gets their own copy.` : `Scheduled for ${when(r.data.sendAt)} — ${r.data.total} people.`,
      });
      setSubject('');
      setBody('Hi {first},\n\n');
      setLater(false);
      setSendAt('');
      qc.invalidateQueries({ queryKey: ['company-email'] });
    },
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not send. Please try again.') }),
  });
  const test = useMutation({
    mutationFn: () => api.post('/mis/company-email/test', { subject, body, to: testTo || myEmail }),
    onSuccess: () => setMsg({ ok: true, text: `Test sent to ${testTo || myEmail}.` }),
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not send the test.') }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.delete(`/mis/company-email/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-email'] }),
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not cancel.') }),
  });

  const confirmSend = () => {
    if (!subject.trim() || !body.trim()) return setMsg({ ok: false, text: 'Write the subject and the message.' });
    if (later && !sendAt) return setMsg({ ok: false, text: 'Choose the date and time, or untick "Send later".' });
    const what = later ? `on ${when(istToIso(sendAt))}` : 'now';
    if (window.confirm(`Send "${subject}" to ${count} ${count === 1 ? 'person' : 'people'} ${what}?`)) send.mutate();
  };

  const input = 'w-full px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm';
  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1100px]">
      <PageHeader
        eyebrow="Email"
        title="Email Everyone"
        subtitle="Write an email and send it to everyone in the company — now or at a time you choose. Each person gets their own copy from the MIS email account."
      />

      <div className="glass-card p-5 space-y-4">
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="e.g. Office closed on Diwali" className={input} />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Message</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={cn(input, 'font-sans leading-relaxed')} />
          <p className="text-[11px] text-gray-500 mt-1">{'{first}'} = the person&apos;s first name, {'{name}'} = full name. Leave a blank line between paragraphs.</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Send to</p>
          <div className="flex flex-wrap gap-2">
            {(['ALL', 'MIS', 'MAILBOX', 'CHOSEN'] as Audience[]).map((a) => (
              <button
                key={a}
                onClick={() => setAudience(a)}
                className={cn(
                  'px-3 py-1.5 rounded-full border text-sm',
                  audience === a ? 'bg-primary text-white border-primary' : 'border-gray-200 dark:border-gray-800 hover:border-primary',
                )}
              >
                {AUDIENCE_LABEL[a]}
                {a !== 'CHOSEN' && data ? ` (${data.counts[a]})` : a === 'CHOSEN' && chosen.size ? ` (${chosen.size})` : ''}
              </button>
            ))}
          </div>
          {audience === 'CHOSEN' && data && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a person" className="pl-8 pr-3 py-1.5 w-56 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm" />
                </div>
                <button onClick={() => setChosen(new Set(shown.map((p) => p.employeeId)))} className="text-xs text-primary hover:underline">
                  Select all shown
                </button>
                <button onClick={() => setChosen(new Set())} className="text-xs text-gray-500 hover:underline">
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto">
                {shown.map((p) => (
                  <label
                    key={p.employeeId}
                    title={p.emails.join(', ')}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs cursor-pointer',
                      chosen.has(p.employeeId) ? 'border-primary bg-primary/10' : 'border-gray-200 dark:border-gray-800',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(p.employeeId)}
                      onChange={(e) => {
                        const n = new Set(chosen);
                        if (e.target.checked) n.add(p.employeeId);
                        else n.delete(p.employeeId);
                        setChosen(n);
                      }}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {data && data.noEmail.length > 0 && (
            <p className="text-[11px] text-amber-600">No email address (won&apos;t get it): {data.noEmail.join(', ')}. Add one on the MIS Emails page.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
            <CalendarClock className="w-4 h-4 text-gray-500" /> Send later
          </label>
          {later && (
            <>
              <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm" />
              <span className="text-xs text-gray-500">India time</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button onClick={confirmSend} disabled={send.isPending || !count} className="btn-primary flex items-center gap-2">
            {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : later ? <CalendarClock className="w-4 h-4" /> : <Send className="w-4 h-4" />}
            {later ? `Schedule for ${count} people` : `Send now to ${count} people`}
          </button>
          <span className="text-xs text-gray-400 mx-1">or</span>
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={myEmail || 'your email'}
            className="px-3 py-1.5 w-56 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm"
          />
          <button onClick={() => test.mutate()} disabled={test.isPending} className="btn-secondary text-sm">
            {test.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send me a test'}
          </button>
        </div>
        {msg && <p className={cn('text-sm', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
      </div>

      <div className="glass-card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 text-sm font-semibold">Sent and scheduled</div>
        {isLoading && <div className="h-24 animate-pulse" />}
        {data && data.emails.length === 0 && <p className="p-6 text-sm text-gray-500 text-center">Nothing sent yet.</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {data?.emails.map((e) => (
            <li key={e.id} className="px-5 py-3 flex flex-wrap items-center gap-3 text-sm">
              <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS[e.status].cls)}>{STATUS[e.status].text}</span>
              <span className="font-medium flex-1 min-w-[200px]">{e.subject}</span>
              <span className="text-xs text-gray-500">{AUDIENCE_LABEL[e.audience]}</span>
              <span className="text-xs text-gray-500 flex items-center gap-1">
                {e.status === 'SCHEDULED' ? <Clock className="w-3.5 h-3.5" /> : e.status === 'FAILED' ? <XCircle className="w-3.5 h-3.5 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                {e.status === 'SCHEDULED' ? when(e.sendAt) : `${e.sent} of ${e.total} sent${e.failed ? `, ${e.failed} failed` : ''} · ${when(e.sentAt ?? e.sendAt)}`}
              </span>
              {e.status === 'SCHEDULED' && (
                <button onClick={() => window.confirm(`Cancel "${e.subject}"?`) && cancel.mutate(e.id)} className="text-xs text-gray-400 hover:text-red-600 flex items-center gap-1">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              )}
              {e.error && <span className="w-full text-xs text-red-600">{e.error}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
