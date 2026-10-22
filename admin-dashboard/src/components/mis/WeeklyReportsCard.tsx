'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, CheckCircle2, Clock, Download, Loader2, Trash2, Upload, X } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';

interface WeeklyReport {
  id: string;
  weekStart: string;
  week: string;
  fileName: string;
  fileSize: number;
  submittedAt: string;
  onTime: boolean;
}
interface WeeklyData {
  thisWeek: string;
  thisWeekLabel: string;
  deadline: string;
  people: { employeeId: string; name: string; login: string; since: string; reports: WeeklyReport[] }[];
}
interface EmployeeLite {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status?: string;
}

const errText = (e: unknown, fallback: string) => (e as any)?.response?.data?.error ?? fallback;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Weekly reporters: people who send one report (PDF) a week instead of a daily
 * MIS. Uploaded by Saturday night = the whole week is green on the Circle Report.
 */
export function WeeklyReportsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['mis-weekly'], queryFn: async () => (await api.get<WeeklyData>('/mis/weekly')).data });
  const { data: employees } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => (await api.get<EmployeeLite[]>('/employees')).data,
    enabled: canEdit,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['mis-weekly'] });
    qc.invalidateQueries({ queryKey: ['mis-circle'] });
  };
  const setPerson = useMutation({
    mutationFn: (v: { employeeId: string; on: boolean }) => api.put('/mis/weekly/person', v),
    onSuccess: () => {
      setAdding('');
      setMsg(null);
      refresh();
    },
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not save.') }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/mis/weekly/${id}`),
    onSuccess: refresh,
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not delete.') }),
  });

  const download = async (r: WeeklyReport) => {
    try {
      const res = await api.get(`/mis/weekly/${r.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      setMsg({ ok: false, text: 'Could not download the file.' });
    }
  };

  const weekly = new Set((data?.people ?? []).map((p) => p.employeeId));
  const candidates = (employees ?? []).filter((e) => !weekly.has(e.id) && e.status !== 'SUSPENDED');

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarRange className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Weekly reports</h2>
        {data && (
          <span className="text-xs text-gray-500">
            This week: {data.thisWeekLabel} · upload by {when(new Date(new Date(data.deadline).getTime() - 60_000).toISOString())}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        For people who send one report a week instead of a daily MIS. Upload the week&apos;s report (PDF, Word, Excel or image) any day up to <b>Saturday night</b> and
        every working day of that week is green. If nothing is uploaded by then, the week&apos;s last working day is one red circle.
      </p>

      {isLoading && <div className="h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-900" />}
      {data && data.people.length === 0 && <p className="text-sm text-gray-500">No weekly reporters yet.</p>}

      {data?.people.map((p) => {
        const current = p.reports.find((r) => r.weekStart === data.thisWeek) ?? null;
        return (
          <div key={p.employeeId} className="rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <p className="font-medium text-sm">{p.name}</p>
                <p className="text-[11px] text-gray-500">{p.login}</p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
                  current ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                )}
              >
                {current ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
                {current ? `This week uploaded ${when(current.submittedAt)}` : 'This week not uploaded yet'}
              </span>
              {canEdit && <UploadButton employeeId={p.employeeId} replacing={!!current} onDone={(t) => (setMsg(t), refresh())} />}
              {canEdit && (
                <button
                  onClick={() => window.confirm(`Make ${p.name} a daily MIS person again? Their weekly reports are kept.`) && setPerson.mutate({ employeeId: p.employeeId, on: false })}
                  className="ml-auto text-xs text-gray-400 hover:text-red-600 flex items-center gap-1"
                  title="Stop weekly reports for this person"
                >
                  <X className="w-3.5 h-3.5" /> Not weekly
                </button>
              )}
            </div>
            {p.reports.length > 0 && (
              <ul className="text-xs divide-y divide-gray-100 dark:divide-gray-800">
                {p.reports.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="w-36 shrink-0 font-medium">{r.week}</span>
                    <button onClick={() => download(r)} className="flex items-center gap-1 text-primary hover:underline">
                      <Download className="w-3.5 h-3.5" /> {r.fileName}
                    </button>
                    <span className="text-gray-400">{kb(r.fileSize)}</span>
                    <span className={r.onTime ? 'text-emerald-600' : 'text-red-600'}>{r.onTime ? `on time · ${when(r.submittedAt)}` : `late · ${when(r.submittedAt)}`}</span>
                    {canEdit && (
                      <button
                        onClick={() => window.confirm(`Delete the report for ${r.week}? That week will count as not submitted.`) && remove.mutate(r.id)}
                        className="ml-auto text-gray-400 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} className="px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm w-72">
            <option value="">Add a weekly reporter…</option>
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {`${e.firstName} ${e.lastName}`.trim()} ({e.email})
              </option>
            ))}
          </select>
          <button onClick={() => adding && setPerson.mutate({ employeeId: adding, on: true })} disabled={!adding || setPerson.isPending} className="btn-secondary text-sm">
            {setPerson.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
          </button>
          <span className="text-[11px] text-gray-500">Starts with the current week.</span>
        </div>
      )}
      {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
    </div>
  );
}

function UploadButton({ employeeId, replacing, onDone }: { employeeId: string; replacing: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.post<{ week: string; onTime: boolean }>('/mis/weekly/upload', { employeeId, file: { fileName: file.name, dataBase64: await toBase64(file) } });
      onDone({
        ok: r.data.onTime,
        text: r.data.onTime ? `Uploaded — the week ${r.data.week} counts as submitted.` : `Uploaded, but after Saturday night — the week ${r.data.week} stays a red circle.`,
      });
    } catch (e) {
      onDone({ ok: false, text: errText(e, 'Upload failed. Please try again.') });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <input ref={input} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.rtf,.csv" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      <button onClick={() => input.current?.click()} disabled={busy} className="btn-primary text-xs flex items-center gap-1.5">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} {replacing ? 'Replace this week’s report' : 'Upload this week’s report'}
      </button>
    </>
  );
}
