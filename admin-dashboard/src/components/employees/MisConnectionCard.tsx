'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Loader2, Link2, Unlink } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { useMisConnection } from './misApi';

/**
 * The Microsoft 365 account MailPilot reads MIS spreadsheets with. Signing in
 * happens on Microsoft's page — MailPilot never sees or stores the password,
 * only a read-only file-access token.
 */
export function MisConnectionCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data: conn, isLoading } = useMisConnection();
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  // Result of the Microsoft sign-in redirect (?mis=connected / ?misError=…).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mis') === 'connected') setFlash({ ok: true, text: `Connected ${q.get('account') ?? ''}. Checking MIS files now…` });
    else if (q.get('misError')) setFlash({ ok: false, text: `Microsoft sign-in failed: ${q.get('misError')}` });
    if (q.has('mis') || q.has('misError')) {
      window.history.replaceState(null, '', window.location.pathname);
      queryClient.invalidateQueries({ queryKey: ['mis-connection'] });
      queryClient.invalidateQueries({ queryKey: ['mis-sources'] });
    }
  }, [queryClient]);

  const connect = useMutation({
    mutationFn: async () => (await api.post<{ authUrl: string }>('/mis/connection/start')).data.authUrl,
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (err: any) => setFlash({ ok: false, text: err?.response?.data?.error ?? 'Could not start Microsoft sign-in.' }),
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete('/mis/connection'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mis-connection'] }),
  });

  const needsReconnect = conn?.connected && conn.status === 'NEEDS_RECONNECT';

  return (
    <div className="glass-card p-4 flex flex-wrap items-center gap-3">
      <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />
      <div className="flex-1 min-w-[240px]">
        <div className="text-sm font-medium">MIS auto-check</div>
        <div className="text-xs text-gray-500">
          {isLoading
            ? 'Loading…'
            : !conn?.connected
            ? 'Connect the Microsoft 365 account that has the MIS spreadsheets (e.g. contactus@). Read-only — no password is stored.'
            : needsReconnect
            ? `Microsoft access for ${conn.accountEmail} expired — connect again.`
            : `Reading MIS spreadsheets as ${conn.accountEmail}. Checked every 10 minutes.`}
        </div>
        {flash && (
          <div className={cn('text-xs mt-1', flash.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {flash.text}
          </div>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          {(!conn?.connected || needsReconnect) && (
            <button onClick={() => connect.mutate()} disabled={connect.isPending} className="btn-primary flex items-center gap-2">
              {connect.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              {needsReconnect ? 'Reconnect Microsoft' : 'Connect Microsoft account'}
            </button>
          )}
          {conn?.connected && (
            <button
              onClick={() => {
                if (window.confirm('Stop reading MIS spreadsheets? Linked files are kept.')) disconnect.mutate();
              }}
              className="btn-secondary flex items-center gap-2"
            >
              <Unlink className="w-4 h-4" /> Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
