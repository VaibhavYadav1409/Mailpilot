'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut, ExternalLink } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useAuthInit, useLogout } from '@/hooks/useAuthInit';
import { useLiveUpdates } from '@/hooks/useLiveUpdates';

const ROLE_RANK: Record<string, number> = { EMPLOYEE: 0, MANAGER: 1, ADMIN: 2, COO: 3, CEO: 4 };

// Where employees work (email + MIS Daily Report). Employees who sign in to the
// admin site by mistake are pointed there instead of hitting a dead end.
const EMPLOYEE_PORTAL_URL = process.env.NEXT_PUBLIC_EMPLOYEE_APP_URL || 'https://mailpilot-employee.vercel.app';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  useAuthInit();
  useLiveUpdates();

  const router = useRouter();
  const logoutMutation = useLogout();
  const user = useAuthStore((s) => s.user);
  const initializing = useAuthStore((s) => s.initializing);

  useEffect(() => {
    if (!initializing && !user) {
      router.replace('/login');
    }
  }, [initializing, user, router]);

  if (initializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return null; // redirecting

  if (ROLE_RANK[user.role] < ROLE_RANK.MANAGER) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6 text-center">
        <div className="glass-card p-8 max-w-md">
          <h1 className="text-xl font-semibold mb-2">Manager access required</h1>
          <p className="text-gray-500 text-sm">
            This dashboard is for managers and above. Your account ({user.role.toLowerCase()}) doesn't have access to
            company-wide analytics.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            Employees use the <span className="font-medium text-gray-700 dark:text-gray-300">Employee Portal</span> for
            email and the MIS Daily Report.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <a href={EMPLOYEE_PORTAL_URL} className="btn-primary flex items-center justify-center gap-2">
              <ExternalLink className="w-4 h-4" />
              Open Employee Portal
            </a>
            <button
              onClick={async () => {
                await logoutMutation.mutateAsync().catch(() => undefined);
                router.replace('/login');
              }}
              disabled={logoutMutation.isPending}
              className="btn-secondary justify-center"
            >
              {logoutMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
