import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';

let socket: Socket | null = null;

/**
 * One socket per browser tab, connected as soon as we have an access token
 * and torn down on logout. Auth token goes in `auth`, not a query string —
 * see the matching comment in backend/src/sockets/index.ts for why.
 */
export function useLiveUpdates() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!accessToken) {
      socket?.disconnect();
      socket = null;
      return;
    }

    const url = process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/?$/, '') || 'http://localhost:4000';
    socket = io(url, { auth: { token: accessToken }, withCredentials: true });

    socket.on('employee:status-changed', () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    });

    socket.on('employee:updated', () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
    });

    socket.on('notification:new', () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    return () => {
      socket?.disconnect();
      socket = null;
    };
  }, [accessToken, queryClient]);
}
