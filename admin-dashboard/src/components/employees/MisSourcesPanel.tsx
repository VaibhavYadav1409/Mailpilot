'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { BlankList, StatusBadge, TONE, dmy, explainSource, shortDay, toneOf } from '@/components/mis/misUi';
import { sourceStatus, type MisSource } from './misApi';

/**
 * One MIS staff member's spreadsheets: link a file, see yesterday's and the
 * day before's result with the reason, fix who checks/approves it, and
 * (optionally) pin which rows must be filled.
 */
export function MisSourcesPanel({
  employeeId,
  sources,
  canManage,
}: {
  employeeId: string;
  sources: MisSource[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['mis-sources'] });
    queryClient.invalidateQueries({ queryKey: ['msi-admin'] });
  };

  const add = useMutation({
    mutationFn: () => api.post('/mis/sources', { employeeId, label: label || 'MIS', shareUrl: link }),
    onSuccess: () => {
      setLabel('');
      setLink('');
      setError('');
      refresh();
      setTimeout(refresh, 10000); // first read runs in the background
    },
    onError: (err: any) => setError(err?.response?.data?.error ?? 'Could not add this file.'),
  });

  const recheck = useMutation({
    mutationFn: () => api.post('/mis/check', { employeeId }),
    onSettled: refresh,
  });

  return (
    <div className="space-y-3 py-3">
      {sources.length === 0 && (
        <p className="text-sm text-gray-500">No MIS spreadsheet linked yet — paste the link to their Excel file below.</p>
      )}
      {sources.map((s) => (
        <SourceCard key={s.id} source={s} canManage={canManage} onChanged={refresh} />
      ))}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="File name, e.g. NPS MIS"
            className="w-44 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
          />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Paste the SharePoint / OneDrive link to the Excel file"
            className="flex-1 min-w-[260px] px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
          />
          <button onClick={() => add.mutate()} disabled={!link.trim() || add.isPending} className="btn-primary flex items-center gap-2">
            {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Link MIS file
          </button>
          {sources.length > 0 && (
            <button onClick={() => recheck.mutate()} disabled={recheck.isPending} className="btn-secondary flex items-center gap-2">
              <RefreshCw className={cn('w-4 h-4', recheck.isPending && 'animate-spin')} /> Re-check now
            </button>
          )}
          {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function SourceCard({ source: s, canManage, onChanged }: { source: MisSource; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editPeople, setEditPeople] = useState(false);
  const [checkedBy, setCheckedBy] = useState(s.checkedBy ?? '');
  const [approvedBy, setApprovedBy] = useState(s.approvedBy ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const custom = s.requiredColumns !== null;
  const requiredCount = custom ? s.requiredColumns!.length : s.fields.filter((f) => f.required).length;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/mis/sources/${s.id}`, body),
    onSuccess: () => {
      setEditing(false);
      setEditPeople(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/mis/sources/${s.id}`),
    onSuccess: onChanged,
  });

  const startEditing = () => {
    setPicked(new Set(s.fields.filter((f) => f.required).map((f) => f.name)));
    setEditing(true);
  };

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white/70 dark:bg-gray-900/40 p-4 space-y-3">
      {/* Title row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-sm">{s.label}</span>
        <a href={s.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="w-3.5 h-3.5" /> {s.fileName ?? 'Open file'}
        </a>
        <span className="text-xs text-gray-400">
          {s.lastCheckedAt ? `read ${new Date(s.lastCheckedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'not read yet'}
          {' · '}
          {requiredCount} rows required ({custom ? 'custom list' : 'learned from past days'})
        </span>
        {canManage && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={startEditing} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <SlidersHorizontal className="w-3.5 h-3.5" /> Required rows
            </button>
            <button
              onClick={() => window.confirm(`Unlink "${s.label}"? Its results stop being checked.`) && remove.mutate()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" /> Unlink
            </button>
          </span>
        )}
      </div>

      {/* Checked by / approved by */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
        {editPeople ? (
          <>
            <input value={checkedBy} onChange={(e) => setCheckedBy(e.target.value)} placeholder="Checked by" className="px-2 py-1 border border-gray-200 dark:border-gray-800 rounded bg-transparent w-36" />
            <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} placeholder="Approved by" className="px-2 py-1 border border-gray-200 dark:border-gray-800 rounded bg-transparent w-36" />
            <button onClick={() => patch.mutate({ checkedBy, approvedBy })} className="btn-primary text-xs px-3 py-1">
              Save
            </button>
            <button onClick={() => setEditPeople(false)} className="btn-secondary text-xs px-3 py-1">
              Cancel
            </button>
          </>
        ) : (
          <>
            <span>
              Checked by <b className="text-gray-700 dark:text-gray-300">{s.checkedBy ?? '—'}</b> · Approved by{' '}
              <b className="text-gray-700 dark:text-gray-300">{s.approvedBy ?? '—'}</b>
            </span>
            {canManage && (
              <button onClick={() => setEditPeople(true)} className="inline-flex items-center gap-1 text-primary hover:underline">
                <Pencil className="w-3 h-3" /> edit
              </button>
            )}
          </>
        )}
      </div>

      {/* Yesterday + day before */}
      <div className="grid gap-3 md:grid-cols-2">
        {s.days.map((d, i) => {
          const st = sourceStatus(s, i);
          const tone = toneOf(st);
          const check = d.check ?? (s.lastError ? { status: 'ERROR' as const, note: s.lastError, missingColumns: [], blanks: [], rowCount: 0, completedAt: null, checkedAt: '' } : null);
          return (
            <div key={d.date} className={cn('rounded-lg border-l-4 bg-gray-50/70 dark:bg-gray-900/40 p-3 space-y-1.5', TONE[tone].border)}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {d.label} <span className="font-normal text-gray-500">· {shortDay(d.date)}</span>
                </span>
                <StatusBadge status={st} blanks={check?.missingColumns.length ?? 0} size="sm" />
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {explainSource(
                  {
                    id: s.id,
                    label: s.label,
                    fileName: s.fileName,
                    webUrl: s.webUrl,
                    checkedBy: s.checkedBy,
                    approvedBy: s.approvedBy,
                    status: st,
                    rowCount: check?.rowCount ?? 0,
                    missingColumns: check?.missingColumns ?? [],
                    blanks: check?.blanks ?? [],
                    note: check?.note ?? null,
                    checkedAt: check?.checkedAt ?? null,
                  },
                  d.date,
                )}
              </p>
              {st === 'INCOMPLETE' && check && check.blanks.length > 0 && <BlankList blanks={check.blanks} max={6} />}
              {st === 'ERROR' && (
                <p className="text-[11px] text-gray-500">
                  Fix: open the file in Excel online → Share → Copy link, then unlink this file and link it again with that link.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Required rows editor */}
      {editing && (
        <div className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-2">
          <p className="text-xs text-gray-500">
            Tick the rows that must be filled every day for this file. Automatic mode requires whatever the person filled on at least half
            of their last 10 working days ({dmy(s.days[0]?.date ?? '')} and earlier); manager rows (Approved by / Remarks / Reply) are never
            required.
          </p>
          {s.fields.length === 0 ? (
            <p className="text-xs text-gray-500">No rows found yet — the file must be read once first.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 max-h-72 overflow-auto">
              {s.fields.map((f) => (
                <label key={f.name} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(f.name)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(f.name);
                      else next.delete(f.name);
                      setPicked(next);
                    }}
                  />
                  <span>{f.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => patch.mutate({ requiredColumns: [...picked] })} disabled={patch.isPending || picked.size === 0} className="btn-primary text-xs">
              {patch.isPending ? 'Saving…' : `Save (${picked.size} required)`}
            </button>
            {custom && (
              <button onClick={() => patch.mutate({ requiredColumns: [] })} disabled={patch.isPending} className="btn-secondary text-xs">
                Back to automatic
              </button>
            )}
            <button onClick={() => setEditing(false)} className="btn-secondary text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
