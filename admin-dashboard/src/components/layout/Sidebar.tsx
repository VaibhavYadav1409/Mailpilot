'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Building2,
  BarChart3,
  Trophy,
  FileText,
  Settings,
  LogOut,
  Loader2,
  Plane,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import { useLogout } from '@/hooks/useAuthInit';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';

const ROLE_RANK: Record<string, number> = { EMPLOYEE: 0, MANAGER: 1, ADMIN: 2, COO: 3, CEO: 4 };

const menuItems = [
  { icon: LayoutDashboard, label: 'Dashboard', href: '/dashboard', minRole: 'MANAGER' },
  { icon: Users, label: 'Employees', href: '/employees', minRole: 'MANAGER' },
  { icon: Building2, label: 'Departments', href: '/departments', minRole: 'MANAGER' },
  { icon: BarChart3, label: 'Analytics', href: '/analytics', minRole: 'MANAGER' },
  { icon: Trophy, label: 'Leaderboard', href: '/leaderboard', minRole: 'MANAGER' },
  { icon: FileText, label: 'Reports', href: '/reports', minRole: 'ADMIN' },
  { icon: Settings, label: 'Settings', href: '/settings', minRole: 'ADMIN' },
];

export const Sidebar = () => {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logoutMutation = useLogout();

  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    router.replace('/login');
  };

  const visibleItems = menuItems.filter(
    (item) => !user || ROLE_RANK[user.role] >= ROLE_RANK[item.minRole]
  );

  const initials = user ? `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}` : '';

  return (
    <aside className="w-64 h-screen shrink-0 flex flex-col bg-ink-950 text-gray-300 border-r border-white/[0.06]">
      {/* Brand */}
      <div className="px-5 pt-6 pb-5 flex items-center justify-between gap-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative w-8 h-8 shrink-0 rounded-lg bg-gradient-to-br from-primary-500 to-primary-800 flex items-center justify-center shadow-glow">
            <Plane className="w-4 h-4 text-white -rotate-45" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold tracking-tight text-white truncate">MailPilot</h2>
            <p className="text-[10px] font-mono tracking-[0.14em] text-gray-500 uppercase">Control Deck</p>
          </div>
        </div>
        <NotificationBell />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {visibleItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex items-center gap-3 pl-3.5 pr-3 py-2 rounded-lg transition-colors text-[13.5px]',
                active ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
              )}
            >
              <span
                className={cn(
                  'absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full bg-primary-400 transition-opacity',
                  active ? 'opacity-100' : 'opacity-0'
                )}
              />
              <item.icon className={cn('w-[17px] h-[17px] shrink-0', active ? 'text-primary-300' : 'text-gray-500')} />
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer / user */}
      <div className="p-3 border-t border-white/[0.06] space-y-2">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
            <div className="relative shrink-0">
              <div className="w-8 h-8 rounded-full bg-white/[0.08] border border-white/10 flex items-center justify-center text-[11px] font-semibold text-white">
                {initials}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 beacon-dot ring-2 ring-ink-950" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-[10.5px] font-mono tracking-wide text-gray-500 uppercase">{user.role}</p>
            </div>
            <ThemeToggle />
          </div>
        )}
        <button
          onClick={handleLogout}
          disabled={logoutMutation.isPending}
          className="flex items-center gap-3 px-3.5 py-2 w-full text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50 text-[13.5px]"
        >
          {logoutMutation.isPending ? (
            <Loader2 className="w-[17px] h-[17px] animate-spin" />
          ) : (
            <LogOut className="w-[17px] h-[17px]" />
          )}
          <span className="font-medium">Sign out</span>
        </button>
      </div>
    </aside>
  );
};
