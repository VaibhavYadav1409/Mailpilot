import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api, { refreshAccessToken } from '@/services/api';
import { useAuthStore, type AdminUser } from '@/store/authStore';

/**
 * Runs once when the app mounts: tries the httpOnly refresh cookie before
 * deciding whether to show the login screen, exactly like the employee
 * app's useAuth.tsx does. Without this, a fully authenticated admin would
 * see a flash of the login page on every reload.
 */
export function useAuthInit() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const setInitializing = useAuthStore((s) => s.setInitializing);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await refreshAccessToken();
      if (!token) {
        if (!cancelled) {
          logout();
          useAuthStore.getState().setInitializing(false);
        }
        return;
      }
      try {
        const { data } = await api.get<{ employee: AdminUser }>('/auth/me');
        if (!cancelled) setAuth(data.employee, token);
      } catch {
        if (!cancelled) logout();
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useLogin() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return useMutation({
    mutationFn: async (creds: { email: string; password: string }) => {
      const { data } = await api.post<{ accessToken: string; employee: AdminUser }>('/auth/login', creds);
      return data;
    },
    onSuccess: (data) => setAuth(data.employee, data.accessToken),
  });
}

export function useLogout() {
  const logout = useAuthStore((s) => s.logout);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      logout();
      queryClient.clear();
    },
  });
}
