import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { authApi, ApiError, type Employee } from "@/lib/api";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = "/login" } = options ?? {};
  const queryClient = useQueryClient();

  const meQuery = useQuery<Employee | null, ApiError>({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => queryClient.setQueryData(["auth", "me"], null),
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 401) return;
      throw error;
    } finally {
      queryClient.setQueryData(["auth", "me"], null);
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      // A hard reload (not wouter's SPA navigate) is intentional here — it
      // resets all in-memory state/caches on logout, same as the original
      // behavior. What's different is the target: `window.location.href =
      // "/login"` resolves as an absolute path, which under the packaged
      // desktop app's file:// protocol tries to load a file that doesn't
      // exist (a real failed navigation, not just a route mismatch — see
      // App.tsx's hash-routing fix for the same underlying issue). Setting
      // the hash first, then reloading the current document, works
      // identically in the Vite dev server and the packaged app.
      window.location.hash = "/login";
      window.location.reload();
    }
  }, [logoutMutation, queryClient]);

  const user = meQuery.data ?? null;
  // name is used in the header ("Hi, {user?.name}") — Employee has first/last, not a combined name.
  const userWithName = useMemo(
    () => (user ? { ...user, name: `${user.firstName} ${user.lastName}`.trim() } : null),
    [user]
  );

  const state = useMemo(
    () => ({
      user: userWithName,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(user),
    }),
    [userWithName, user, meQuery.isLoading, meQuery.error, logoutMutation.isPending, logoutMutation.error]
  );

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    // Same file:// consideration as `logout` above: compare/navigate via
    // the hash, not pathname, since pathname is the on-disk file path in
    // the packaged app.
    const currentHashPath = "/" + window.location.hash.replace(/^#\/?/, "");
    if (currentHashPath === redirectPath) return;
    window.location.hash = redirectPath;
    window.location.reload();
  }, [redirectOnUnauthenticated, redirectPath, logoutMutation.isPending, meQuery.isLoading, state.user]);

  return { ...state, refresh: () => meQuery.refetch(), logout };
}
