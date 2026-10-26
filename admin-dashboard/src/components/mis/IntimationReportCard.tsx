'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ChevronDown, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';

interface Row {
  section: 'INTIMATION' | 'ADVANCE';
  name: string;
  matchedName: string | null;
  kind: string;
  result: string;
  reason: string;
  replacement: string;
}
interface Report {
  id: string;
  reportDate: string;
  fileName: string;
  uploadedAt: string;
  rows: Row[];
}
interface UploadResult {
  reportDate: string;
  dateFromImage: boolean;
  rows: Row[];
  leaveAdded: number;
  unmatched: string[];
}

const errText = (e: unknown, fallback: string) => (e as any)?.response?.data?.error ?? fallback;
const long = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Phone photos can be large: shrink to ≤1600 px JPEG before upload (keeps the text sharp, the upload small). */
async function shrink(file: File): Promise<{ fileName: string; dataBase64: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataBase64 = canvas.toDataURL('image/jpeg', 0.9);
    return { fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg', dataBase64 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function RowsTable({ rows }: { rows: Row[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
          <th className="py-1.5 pr-2 font-medium">Name (as written)</th>
          <th className="py-1.5 pr-2 font-medium">Person in MailPilot</th>
          <th className="py-1.5 pr-2 font-medium">What MailPilot did</th>
          <th className="py-1.5 pr-2 font-medium">Reason · Replacement</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-gray-50 dark:border-gray-900 align-top">
            <td className="py-1.5 pr-2">
              {r.name}
              {r.section === 'ADVANCE' && <span className="ml-1 text-[10px] text-sky-600">advance</span>}
            </td>
            <td className={cn('py-1.5 pr-2', !r.matchedName && 'text-red-600')}>{r.matchedName ?? 'Not found'}</td>
            <td className={cn('py-1.5 pr-2', /not found|not recorded/i.test(r.result) ? 'text-red-600' : /already recorded|recorded \(/i.test(r.result) ? 'text-gray-500' : 'text-emerald-700 dark:text-emerald-400 font-medium')}>
              {r.result}
            </td>
            <td className="py-1.5 pr-2 text-gray-500">
              {[r.reason && !/^nil$/i.test(r.reason) ? r.reason : null, r.replacement && !/^nil$/i.test(r.replacement) ? `→ ${r.replacement}` : null].filter(Boolean).join(' · ') || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Daily Intimation Report: upload the day's photo/screenshot; MailPilot reads it
 * and records the leave (planned / emergency / Saturday off / absent) at once.
 */
export function IntimationReportCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [last, setLast] = useState<UploadResult | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['mis-intimation'], queryFn: async () => (await api.get<{ reports: Report[] }>('/mis/leaves/intimation')).data });
  const refresh = () => {
    for (const k of ['mis-intimation', 'mis-leaves', 'mis-circle', 'msi-admin', 'mis-sources']) qc.invalidateQueries({ queryKey: [k] });
  };
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/mis/leaves/intimation/${id}`),
    onSuccess: refresh,
    onError: (e) => setMsg({ ok: false, text: errText(e, 'Could not delete.') }),
  });

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    setLast(null);
    try {
      const f = await shrink(file);
      const r = await api.post<UploadResult>('/mis/leaves/intimation', { file: f, reportDate: date });
      setLast(r.data);
      setMsg({
        ok: true,
        text: `Report of ${long(r.data.reportDate)} read — ${r.data.leaveAdded} new leave record${r.data.leaveAdded === 1 ? '' : 's'} added.${r.data.dateFromImage ? '' : ' (Date taken from the date box — it wasn’t readable in the image.)'}`,
      });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Could not read the photo. Please try again.') });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const viewImage = async (id: string) => {
    try {
      const res = await api.get(`/mis/leaves/intimation/${id}/image`, { responseType: 'blob' });
      window.open(URL.createObjectURL(res.data as Blob), '_blank');
    } catch {
      setMsg({ ok: false, text: 'Could not open the image.' });
    }
  };

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Camera className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold">Daily Intimation Report</h2>
        <span className="text-xs text-gray-500">Upload the day&apos;s photo or screenshot — leave is recorded automatically.</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Advance leave → Planned (2+ days ahead) or Emergency · Intimation of leave → Emergency leave · Saturday off → SO · No intimation / Absent → Absent ·
        Late, Half day and WFH are recorded only (MIS still needed). The same leave on several days&apos; reports is kept once. Uploading the same day again replaces it.
        Anything wrong can be fixed in the table below.
      </p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-500">
            Report date (if not readable in the image)
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block mt-0.5 px-3 py-1.5 border border-gray-200 dark:border-gray-800 rounded-lg bg-transparent text-sm" />
          </label>
          <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0] ?? null)} />
          <button onClick={() => input.current?.click()} disabled={busy} className="btn-primary flex items-center gap-2 self-end">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
            {busy ? 'Reading the report…' : 'Upload photo / screenshot'}
          </button>
        </div>
      )}
      {msg && <p className={cn('text-sm', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
      {last && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 p-3 space-y-2">
          <RowsTable rows={last.rows} />
          {last.unmatched.length > 0 && (
            <p className="text-xs text-red-600">Not found in MailPilot (not recorded): {last.unmatched.join(', ')} — add their leave by hand below, or correct the name in the report.</p>
          )}
        </div>
      )}

      {(data?.reports.length ?? 0) > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500">Uploaded reports</p>
          {data!.reports.map((r) => (
            <div key={r.id} className="rounded-lg border border-gray-200 dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="flex items-center gap-1.5 font-medium">
                  <ChevronDown className={cn('w-4 h-4 transition-transform', openId === r.id && 'rotate-180')} /> {long(r.reportDate)}
                </button>
                <span className="text-xs text-gray-500">{r.rows.length} rows</span>
                <button onClick={() => viewImage(r.id)} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <ImageIcon className="w-3.5 h-3.5" /> View photo
                </button>
                {canEdit && (
                  <button
                    onClick={() => window.confirm(`Delete the report of ${long(r.reportDate)}? Leave added only by it is removed too.`) && del.mutate(r.id)}
                    className="ml-auto text-gray-400 hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              {openId === r.id && (
                <div className="px-3 pb-3">
                  <RowsTable rows={r.rows} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
