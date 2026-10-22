'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';

/**
 * Remove someone who has left — permanently: the person and all their mail,
 * reports and MIS data. Asks the admin to type the person's login first.
 */
export function useRemoveEmployee() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (args: { id: string; confirm: string }) =>
      api.delete<{ name: string; emails: number; reports: number; misFiles: number }>(`/employees/${args.id}`, { data: { confirm: args.confirm } }),
    onSuccess: () => {
      for (const k of ['employees', 'mis-circle', 'msi-admin', 'mis-sources', 'mis-leaves', 'mis-email-recipients']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const remove = async (e: { id: string; name: string; login: string }) => {
    const typed = window.prompt(
      `Remove ${e.name} permanently?\n\nThis deletes ${e.name} and ALL their data from MailPilot: mailbox and emails, daily reports, MIS file, MIS checks, red circles and leave records. It can't be undone (Suspend can).\n\nType their login to confirm: ${e.login}`,
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== e.login.toLowerCase()) {
      window.alert('That did not match — nothing was removed.');
      return;
    }
    try {
      await m.mutateAsync({ id: e.id, confirm: typed.trim() });
    } catch (err: any) {
      window.alert(err?.response?.data?.error ?? 'Could not remove. Try again.');
    }
  };
  return { remove, removing: m.isPending };
}
