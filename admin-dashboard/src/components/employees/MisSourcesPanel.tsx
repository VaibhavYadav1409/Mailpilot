'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2, SlidersHorizontal } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { misStatusLabel, type MisSource } from './misApi';

/**
 * One MSI staff member's MIS spreadsheets: add a link, see today's result, and
 * (optionally) pin which particulars must be filled. By default MailPilot
 * learns them — anything filled on at least half of the last 10 working days.
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
      // First read happens in the background; poll once shortly after.
      setTimeout(refresh, 8000);
      refresh();
    },
    onError: (err: any) => setError(err?.response?.data?.error ?? 'Could not add this file.'),
  });

  const recheck = useMutation({
    mutationFn: () => api.post('/mis/check', { employeeId }),
    onSettled: refresh,
  });

  return (
    <div className="space-y-3 py-2">
      {sources.length === 0 && <p className="text-sm text-gray-500">No MIS spreadsheet linked yet.</p>}
      {sources.map((s) => (
        <SourceCard key={s.id} source={s} canManage={canManage} onChanged={refresh} />
      ))}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name, e.g. NPS MIS"
            className="w-40 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
          />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Paste the SharePoint / OneDrive link to the Excel file"
            className="flex-1 min-w-[260px] px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-sm outline-none"
          />
          <button onClick={() => add.mutate()} disabled={!link.trim() || add.isPending} className="btn-primary flex items-center gap-2">
            {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Link MIS
          </button>
          {sources.length > 0 && (
            <button onClick={() => recheck.mutate()} disabled={recheck.isPending} className="btn-secondary flex items-center gap-2">
              <RefreshCw className={cn('w-4 h-4', recheck.isPending && 'animate-spin')} /> Check now
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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const t = s.today;
  const badge = misStatusLabel(t?.status ?? (s.lastError ? 'ERROR' : undefined), t?.missingColumns.length ?? 0);
  const custom = s.requiredColumns !== null;

  const save = useMutation({
    mutationFn: (requiredColumns: string[]) => api.patch(`/mis/sources/${s.id}`, { requiredColumns }),
    onSuccess: () => {
      setEditing(false);
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
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white/60 dark:bg-gray-900/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{s.label}</span>
        <a href={s.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="w-3.5 h-3.5" /> {s.fileName ?? 'Open file'}
        </a>
        <span className={cn('badge', badge.cls)}>{badge.text}</span>
        <span className="text-xs text-gray-400">
          {s.lastCheckedAt ? `checked ${new Date(s.lastCheckedAt).toLocaleTimeString()}` : 'not checked yet'}
          {' · '}
          {custom ? `${s.requiredColumns!.length} required (custom)` : `${s.fields.filter((f) => f.required).length} required (automatic)`}
        </span>
        {canManage && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={startEditing} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800">
              <SlidersHorizontal className="w-3.5 h-3.5" /> Required fields
            </button>
            <button
              onClick={() => window.confirm(`Unlink "${s.label}"?`) && remove.mutate()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" /> Unlink
            </button>
          </span>
        )}
      </div>

      {s.lastError && (!t || t.status === 'ERROR') && <p className="text-xs text-red-600 dark:text-red-400">{s.lastError}</p>}
      {t?.note && t.status !== 'ERROR' && <p className="text-xs text-gray-500">{t.note}</p>}
      {t?.status === 'INCOMPLETE' && t.blanks.length > 0 && (
        <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5 max-h-40 overflow-auto">
          {t.blanks.map((b) => (
            <li key={`${b.sheet}!${b.cell}`}>
              <span className="font-mono text-gray-500">{b.cell}</span> {b.field}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="border-t border-gray-100 dark:border-gray-800 pt-2 space-y-2">
          <p className="text-xs text-gray-500">
            Tick the particulars that must be filled every day. Automatic mode requires whatever was filled on at least half
            of the last 10 working days (manager remarks / approval rows are never required).
          </p>
          {s.fields.length === 0 ? (
            <p className="text-xs text-gray-500">No particulars found yet — check the file first.</p>
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
            <button onClick={() => save.mutate([...picked])} disabled={save.isPending || picked.size === 0} className="btn-primary text-xs">
              {save.isPending ? 'Saving…' : 'Save as custom'}
            </button>
            {custom && (
              <button onClick={() => save.mutate([])} disabled={save.isPending} className="btn-secondary text-xs">
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
