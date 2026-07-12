import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'CEO' | 'COO' | 'ADMIN' | 'MANAGER' | 'EMPLOYEE';
  companyId: string;
  departmentId: string | null;
}

interface AuthState {
  user: AdminUser | null;
  accessToken: string | null;
  /** True until the initial silent-refresh attempt (see hooks/useAuthInit.ts) resolves. */
  initializing: boolean;
  setAccessToken: (token: string | null) => void;
  setAuth: (user: AdminUser, accessToken: string) => void;
  setInitializing: (value: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      initializing: true,
      setAccessToken: (accessToken) => set({ accessToken }),
      setAuth: (user, accessToken) => set({ user, accessToken }),
      setInitializing: (initializing) => set({ initializing }),
      logout: () => set({ user: null, accessToken: null }),
    }),
    {
      name: 'mailpilot-admin-auth',
      // Only `user` (display data) survives a reload. The access token is
      // short-lived and re-obtained via the httpOnly refresh cookie anyway
      // (see hooks/useAuthInit.ts), so there's no reason for it — or a
      // long-lived refresh token, which this store never held even before —
      // to sit in localStorage where any script running on the page could
      // read it.
      partialize: (state) => ({ user: state.user }) as AuthState,
    }
  )
);
