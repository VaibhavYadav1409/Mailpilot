'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, Loader2, Upload } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';

interface Row {
  name: string;
  url: string;
  checkedBy?: string;
  approvedBy?: string;
}

interface Result {
  name: string;
  username: string | null;
  label: string;
  result: 'linked' | 'already linked' | 'skipped' | 'failed';
  detail: string;
}

/**
 * Turns rows copied from Excel (Name | Link | Checked by | Approved by) into
 * import rows. Header rows, blank rows and rows without a link are ignored.
 */
export function parsePastedRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('\t').map((c) => c.trim());
    const urlIdx = cells.findIndex((c) => /^https?:\/\//i.test(c));
    if (urlIdx < 0) continue;
    const name = cells.slice(0, urlIdx).filter(Boolean).join(' ').trim();
    if (!name) continue;
    const rest = cells.slice(urlIdx + 1).filter(Boolean);
    rows.push({ name, url: cells[urlIdx], checkedBy: rest[0], approvedBy: rest[1] });
  }
  return rows;
}

/**
 * Bulk-link MIS spreadsheets: copy the rows from the "All MIS Spreadsheet
 * Link" Excel and paste them here. Each new name gets a login (username =
 * name, password = NAME in capitals); existing people get the file added.
 */
export function MisImportPanel({ onDone }: { onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const rows = parsePastedRows(text);

  const run = useMutation({
    mutationFn: async () => (await api.post<{ results: Result[] }>('/mis/import', { rows })).data.results,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['mis-sources'] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['mis-sources'] }), 15000);
      onDone?.();
    },
  });

  const color: Record<Result['result'], string> = {
    linked: 'text-emerald-700 dark:text-emerald-400',
    'already linked': 'text-gray-500',
    skipped: 'text-amber-700 dark:text-amber-400',
    failed: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start gap-3">
        <ClipboardPaste className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium">Import many MIS files at once</p>
          <ol className="text-gray-500 text-xs mt-1 list-decimal pl-4 space-y-0.5">
            <li>Open the Excel that lists everyone’s MIS link (Name | Link | Checked by | Approved by).</li>
            <li>Select the rows (you can include the header) and press Ctrl+C.</li>
            <li>Click in the box below, press Ctrl+V, then “Import”.</li>
          </ol>
          <p className="text-gray-500 text-xs mt-1">
            New names get a login — username = their name, password = their name in CAPITALS. Text in brackets becomes the file’s
            name, e.g. “Anjali Jha (NPS MIS)”. Google Sheets links are skipped (only Excel files in SharePoint/OneDrive can be read).
          </p>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={'ANKUR JAIN\thttps://farsightshare-my.sharepoint.com/...\tNCM SIR\tNCM SIR'}
        className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg text-xs font-mono outline-none focus:ring-2 focus:ring-primary/20"
      />
      <div className="flex items-center gap-3">
        <button onClick={() => run.mutate()} disabled={rows.length === 0 || run.isPending} className="btn-primary flex items-center gap-2">
          {run.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Import {rows.length > 0 ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}
        </button>
        {text && rows.length === 0 && <span className="text-xs text-red-500">No rows with a name and a link found.</span>}
        {run.isError && <span className="text-xs text-red-500">{(run.error as any)?.response?.data?.error ?? 'Import failed.'}</span>}
      </div>
      {run.data && (
        <div className="overflow-x-auto">
          <p className="text-xs text-gray-500 mb-1">
            {run.data.filter((r) => r.result === 'linked').length} linked · {run.data.filter((r) => r.result === 'already linked').length} already
            linked · {run.data.filter((r) => r.result === 'skipped').length} skipped · {run.data.filter((r) => r.result === 'failed').length} failed.
            First results appear within a minute.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 uppercase tracking-wider">
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Login</th>
                <th className="py-1 pr-3">File</th>
                <th className="py-1">Result</th>
              </tr>
            </thead>
            <tbody>
              {run.data.map((r, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1 pr-3">{r.name}</td>
                  <td className="py-1 pr-3 font-mono">{r.username ?? '—'}</td>
                  <td className="py-1 pr-3">{r.label}</td>
                  <td className={cn('py-1', color[r.result])}>
                    {r.result} — {r.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
