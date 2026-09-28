'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, KeyRound, UserX, UserCheck, Loader2, Search } from 'lucide-react';
import api from '@/services/api';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { isMsiStaffLogin } from './staffKind';

interface StaffRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string; // for MSI staff this is the username, e.g. "ashok kumar"
  status: 'ONLINE' | 'OFFLINE' | 'IDLE' | 'SUSPENDED';
  lastActiveAt: string | null;
}

interface UpsertResult {
  created: boolean;
  username: string;
  password: string;
}

/**
 * People who only file the MSI Daily Work Report — no mailbox, no email.
 * They sign in on the Employee Portal with their name as username and their
 * name in CAPITALS as password.
 */
export function MsiStaffTable() {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const canManage = currentUser && ['ADMIN', 'COO', 'CEO'].includes(currentUser.role);

  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Same query key as the mail table, so both sections share one request.
  const { data: employees, isLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: async () => (await api.get<StaffRow[]>('/employees')).data,
  });

  const staff = (employees ?? [])
    .filter((e) => isMsiStaffLogin(e.email))
    .filter((e) => `${e.firstName} ${e.lastName}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));

  const upsert = useMutation({
    mutationFn: async (staffName: string) => (await api.post<UpsertResult>('/employees/msi-staff', { name: staffName })).data,
    onSuccess: (r) => {
      setNotice({
        kind: 'ok',
        text: `${r.created ? 'Added' : 'Password reset'} — username: ${r.username} · password: ${r.password}`,
      });
      setName('');
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: (err: any) => setNotice({ kind: 'error', text: err?.response?.data?.error ?? 'Could not save. Try again.' }),
  });

  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: 'SUSPENDED' | 'OFFLINE' }) =>
      api.patch(`/employees/${args.id}`, { status: args.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search MSI staff..."
            className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-gray-900 border-none rounded-lg focus:ring-2 focus:ring-primary/20 outline-none text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {canManage && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) upsert.mutate(name);
            }}
          >
            <input
              type="text"
              placeholder="Full name, e.g. Ashok Kumar"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={upsert.isPending}
              className="w-60 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg outline-none text-sm focus:ring-2 focus:ring-primary/20"
            />
            <button type="submit" disabled={upsert.isPending || !name.trim()} className="btn-primary flex items-center gap-2">
              {upsert.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add staff
            </button>
          </form>
        )}
      </div>

      {notice && (
        <div
          className={cn(
            'mx-4 mt-4 px-3 py-2 rounded-lg text-sm',
            notice.kind === 'ok'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-red-500/10 text-red-600 dark:text-red-400'
          )}
        >
          {notice.text}
        </div>
      )}

      {isLoading ? (
        <div className="p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-50 dark:bg-gray-900 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : staff.length === 0 ? (
        <p className="p-8 text-center text-sm text-gray-500">No MSI staff yet. Add someone by name above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800">
                <th className="px-6 py-3.5">Name</th>
                <th className="px-6 py-3.5">Username</th>
                <th className="px-6 py-3.5">Password</th>
                <th className="px-6 py-3.5">Status</th>
                <th className="px-6 py-3.5">Last active</th>
                {canManage && <th className="px-6 py-3.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {staff.map((s) => {
                const fullName = `${s.firstName} ${s.lastName}`.trim();
                return (
                  <tr key={s.id} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                          {s.firstName[0]}
                          {s.lastName[0] ?? ''}
                        </div>
                        <span className="font-medium text-[13.5px]">{fullName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-mono">{s.email.toUpperCase()}</td>
                    <td className="px-6 py-4 text-xs text-gray-500">Name in CAPITALS</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full',
                            s.status === 'ONLINE'
                              ? 'bg-emerald-500 beacon-dot'
                              : s.status === 'SUSPENDED'
                              ? 'bg-red-500'
                              : 'bg-gray-300 dark:bg-gray-600'
                          )}
                        />
                        <span className="text-sm capitalize">{s.status.toLowerCase()}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-tabular text-gray-500">
                      {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString() : 'Never'}
                    </td>
                    {canManage && (
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => upsert.mutate(fullName)}
                            disabled={upsert.isPending}
                            title="Reset password back to their name"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                          >
                            <KeyRound className="w-3.5 h-3.5" /> Reset password
                          </button>
                          {s.status === 'SUSPENDED' ? (
                            <button
                              onClick={() => setStatus.mutate({ id: s.id, status: 'OFFLINE' })}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                              <UserCheck className="w-3.5 h-3.5" /> Reactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => setStatus.mutate({ id: s.id, status: 'SUSPENDED' })}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-red-500"
                            >
                              <UserX className="w-3.5 h-3.5" /> Suspend
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
