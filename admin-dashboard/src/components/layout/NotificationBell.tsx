'use client';

import { useState } from 'react';
import { Bell } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications } from '@/hooks/useNotifications';

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SEVERITY_DOT: Record<string, string> = {
  INFO: 'bg-blue-400',
  WARNING: 'bg-yellow-500',
  CRITICAL: 'bg-red-500',
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data: notifications } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unreadCount = notifications?.filter((n) => !n.readAt).length ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg hover:bg-white/[0.06] transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-[18px] h-[18px] text-gray-400" />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-beacon beacon-dot" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto glass-card p-2 z-20 text-foreground">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllRead.mutate()}
                  className="text-xs text-primary hover:underline font-medium"
                >
                  Mark all read
                </button>
              )}
            </div>

            {!notifications || notifications.length === 0 ? (
              <p className="text-sm text-gray-400 px-2 py-6 text-center">No notifications yet.</p>
            ) : (
              <div className="space-y-1 mt-1">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => !n.readAt && markRead.mutate(n.id)}
                    className={cn(
                      'w-full text-left px-2 py-2 rounded-lg text-sm flex items-start gap-2 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors',
                      !n.readAt && 'bg-gray-50/70 dark:bg-gray-900/40'
                    )}
                  >
                    <span className={cn('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', SEVERITY_DOT[n.severity] ?? 'bg-gray-300')} />
                    <span className="flex-1">
                      <span className={cn(!n.readAt && 'font-medium')}>{n.message}</span>
                      <span className="block text-xs text-gray-400 mt-0.5">{timeAgo(n.createdAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
