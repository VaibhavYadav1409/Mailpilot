import axios from 'axios';
import { useAuthStore } from '../store/authStore';

// Talks to the unified backend from Phases 1-5, not the old admin-only
// Express/Prisma backend this frontend originally shipped with.
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api',
  // The refresh token lives in an httpOnly cookie set by the backend (see
  // COOKIE_NAME in shared/const.ts) — withCredentials is what makes the
  // browser attach it automatically, the same way Electron's cookie jar
  // does for the employee app.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      // No refreshToken in the body — the old admin backend expected one
      // client-side, but this backend reads it from the httpOnly cookie, so
      // there's nothing here for the browser to hold or leak.
      const { data } = await axios.post(
        `${api.defaults.baseURL}/auth/refresh`,
        {},
        { withCredentials: true }
      );
      useAuthStore.getState().setAccessToken(data.accessToken);
      return data.accessToken as string;
    } catch {
      useAuthStore.getState().logout();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const newToken = await refreshAccessToken();
      if (newToken) {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      }
    }
    return Promise.reject(error);
  }
);

export { refreshAccessToken };
export default api;
