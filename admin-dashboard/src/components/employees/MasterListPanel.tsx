'use client';

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';

type SaturdayRule = 'SECOND' | 'TWO' | 'ALL';

interface PlanPerson {
  lines: number[];
  listName: string;
  employeeId: string | null;
  name: string;
  username: string | null;
  isNew: boolean;
  weekly: boolean;
  files: { label: string; fileName: string | null; url: string; state: 'already linked' | 'new' | 'invalid'; problem?: string }[];
  oldFiles: { id: string; label: string; fileName: string | null }[];
  emails: { now: string[]; list: string[]; change: boolean };
  saturday: { now: SaturdayRule; list: SaturdayRule | null; change: boolean; kept: boolean };
  notes: string[];
}

interface Plan {
  people: PlanPerson[];
  notInList: { employeeId: string; name: string; files: number }[];
  leftButActive: { employeeId: string; name: string; listName: string }[];
  counts: { people: number; newPeople: number; newFiles: number; oldFiles: number; emailChanges: number; saturdayChanges: number; problems: number };
}

interface ApplyResult {
  plan: Plan;
  done: { name: string; actions: string[]; error?: string }[];
}

const SAT: Record<SaturdayRule, string> = { SECOND: '2nd Saturday', TWO: '2 Saturdays a month', ALL: 'Every Saturday' };

const errText = (e: unknown, fallback: string) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

function readFile(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(f);
  });
}

/**
 * Upload the company's master list (Excel: Employee Name | MIS Links | Email | Off) → see every
 * change MailPilot would make → Apply. Nobody is removed automatically.
 */
export function MasterListPanel() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ fileName: string; dataBase64: string } | null>(null);
  const [removeOld, setRemoveOld] = useState(true);

  const preview = useMutation({
    mutationFn: async (f: { fileName: string; dataBase64: string }) => (await api.post<Plan>('/mis/master-list/preview', { file: f })).data,
  });
  const apply = useMutation({
    mutationFn: async () => (await api.post<ApplyResult>('/mis/master-list/apply', { file, removeOldFiles: removeOld })).data,
    onSuccess: () => {
      for (const k of ['employees', 'mis-sources', 'mis-leaves', 'mis-circle', 'msi-admin', 'mis-email-recipients', 'mis-email']) qc.invalidateQueries({ queryKey: [k] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['mis-sources'] }), 15000);
    },
  });

  const choose = async (f: File | undefined) => {
    if (!f) return;
    apply.reset();
    const data = { fileName: f.name, dataBase64: await readFile(f) };
    setFile(data);
    preview.mutate(data);
  };

  const plan = apply.data?.plan ?? preview.data;
  const changed = (p: PlanPerson) =>
    p.isNew || p.files.some((f) => f.state !== 'already linked') || p.oldFiles.length > 0 || p.emails.change || p.saturday.change || p.notes.length > 0;

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium">Import master list (Excel)</p>
          <p className="text-gray-500 text-xs mt-1">
            Upload the Excel with every employee’s MIS link (Employee Name | MIS Links | Email | Off). You will see every change first — nothing changes until you click
            Apply. It links each person’s MIS file, sets where their MIS emails go (the first email is the one that must reply) and their Saturdays off. Nobody is removed.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input ref={input} type="file" accept=".xlsx" className="hidden" onChange={(e) => choose(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <button onClick={() => input.current?.click()} disabled={preview.isPending || apply.isPending} className="btn-secondary flex items-center gap-2">
          {preview.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {file ? `Choose another file` : 'Choose Excel file'}
        </button>
        {file && <span className="text-xs text-gray-500">{file.fileName}</span>}
        {preview.isError && <span className="text-xs text-red-500">{errText(preview.error, 'Could not read the file.')}</span>}
      </div>

      {plan && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {plan.counts.people} people · {plan.counts.newPeople} new · {plan.counts.newFiles} file(s) to link · {plan.counts.oldFiles} old file(s) ·{' '}
            {plan.counts.emailChanges} email change(s) · {plan.counts.saturdayChanges} Saturday change(s)
            {plan.counts.problems ? ` · ${plan.counts.problems} link problem(s)` : ''}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 uppercase tracking-wider">
                  <th className="py-1 pr-3">Row</th>
                  <th className="py-1 pr-3">Person</th>
                  <th className="py-1 pr-3">MIS file(s)</th>
                  <th className="py-1 pr-3">MIS emails</th>
                  <th className="py-1 pr-3">Saturdays off</th>
                </tr>
              </thead>
              <tbody>
                {plan.people.map((p) => (
                  <tr key={p.lines.join('-')} className={cn('border-t border-gray-100 dark:border-gray-800 align-top', !changed(p) && 'text-gray-400')}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{p.lines.join(', ')}</td>
                    <td className="py-1.5 pr-3">
                      <div className="font-medium">{p.name}</div>
                      {p.isNew ? (
                        <div className="text-emerald-700 dark:text-emerald-400">New — login {p.username}</div>
                      ) : (
                        p.listName.toUpperCase() !== p.name.toUpperCase() && <div className="text-gray-500">“{p.listName}” in the list</div>
                      )}
                      {p.notes.map((n) => (
                        <div key={n} className="text-amber-700 dark:text-amber-400">
                          {n}
                        </div>
                      ))}
                    </td>
                    <td className="py-1.5 pr-3">
                      {p.files.map((f, i) => (
                        <div key={i} className={f.state === 'new' ? 'text-emerald-700 dark:text-emerald-400' : f.state === 'invalid' ? 'text-red-600' : ''}>
                          {f.state === 'new' ? '+ ' : f.state === 'invalid' ? '! ' : '✓ '}
                          {f.fileName ?? f.label}
                          {f.problem ? ` — ${f.problem}` : ''}
                        </div>
                      ))}
                      {p.oldFiles.map((o) => (
                        <div key={o.id} className="text-red-600 line-through">
                          {o.fileName ?? o.label}
                        </div>
                      ))}
                    </td>
                    <td className="py-1.5 pr-3">
                      {p.emails.change ? (
                        <>
                          <div className="text-emerald-700 dark:text-emerald-400">{p.emails.list.join(', ')}</div>
                          {p.emails.now.length > 0 && <div className="text-gray-400 line-through">{p.emails.now.join(', ')}</div>}
                        </>
                      ) : (
                        <div>{(p.emails.list.length ? p.emails.list : p.emails.now).join(', ') || '—'}</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {p.saturday.change ? (
                        <>
                          <div className="text-emerald-700 dark:text-emerald-400">{SAT[p.saturday.list!]}</div>
                          <div className="text-gray-400 line-through">{SAT[p.saturday.now]}</div>
                        </>
                      ) : (
                        <div>{SAT[p.saturday.now]}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.leftButActive.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              In the “left” list but still active in MailPilot: {plan.leftButActive.map((x) => x.name).join(', ')}. Remove them from the staff list if they have left.
            </p>
          )}
          {plan.notInList.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Have an MIS file in MailPilot but are not in the list: {plan.notInList.map((x) => x.name).join(', ')}. Nothing changes for them.
            </p>
          )}

          {!apply.data && (
            <div className="flex flex-wrap items-center gap-4">
              {plan.counts.oldFiles > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={removeOld} onChange={(e) => setRemoveOld(e.target.checked)} />
                  Remove the {plan.counts.oldFiles} old file(s) (crossed out) — red circles already marked stay
                </label>
              )}
              <button onClick={() => apply.mutate()} disabled={apply.isPending || !file} className="btn-primary flex items-center gap-2">
                {apply.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Apply changes
              </button>
              {apply.isError && <span className="text-xs text-red-500">{errText(apply.error, 'Could not apply.')}</span>}
            </div>
          )}

          {apply.data && (
            <div className="text-xs space-y-1">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">Done. The new files are checked within a minute.</p>
              {apply.data.done
                .filter((d) => d.actions.length || d.error)
                .map((d, i) => (
                  <div key={i}>
                    <span className="font-medium">{d.name}:</span> {d.actions.join(' · ')}
                    {d.error && <span className="text-red-600"> {d.error}</span>}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
