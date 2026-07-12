'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useAuthInit } from '@/hooks/useAuthInit';
import { useLiveUpdates } from '@/hooks/useLiveUpdates';

const ROLE_RANK: Record<string, number> = { EMPLOYEE: 0, MANAGER: 1, ADMIN: 2, COO: 3, CEO: 4 };

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  useAuthInit();
  useLiveUpdates();

  const router = useRouter();
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
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
