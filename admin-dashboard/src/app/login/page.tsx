'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plane, Loader2, ArrowRight } from 'lucide-react';
import { useLogin } from '@/hooks/useAuthInit';
import { useAuthStore } from '@/store/authStore';

export default function LoginPage() {
  const router = useRouter();
  const loginMutation = useLogin();
  const user = useAuthStore((s) => s.user);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (user) {
    router.replace('/dashboard');
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await loginMutation.mutateAsync({ email, password });
      router.replace('/dashboard');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Login failed. Please try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-950 px-4 relative overflow-hidden">
      {/* Faint instrument grid, purely atmospheric */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[560px] h-[560px] rounded-full bg-primary-600/20 blur-[120px]" />

      <div className="relative w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="relative w-12 h-12 rounded-xl bg-gradient-to-br from-primary-500 to-primary-800 flex items-center justify-center mb-5 shadow-glow">
            <Plane className="text-white w-6 h-6 -rotate-45" strokeWidth={2} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">MailPilot Admin</h1>
          <p className="text-gray-500 text-sm mt-1.5">Sign in with your manager or admin account</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-7 shadow-panel-dark">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Work email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loginMutation.isPending}
                className="w-full px-4 py-2.5 bg-white/[0.04] text-white border border-white/10 rounded-lg focus:ring-2 focus:ring-primary/40 focus:border-primary/40 outline-none disabled:opacity-50 placeholder:text-gray-600 transition-shadow"
                placeholder="you@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loginMutation.isPending}
                className="w-full px-4 py-2.5 bg-white/[0.04] text-white border border-white/10 rounded-lg focus:ring-2 focus:ring-primary/40 focus:border-primary/40 outline-none disabled:opacity-50 placeholder:text-gray-600 transition-shadow"
                placeholder="Enter password"
              />
            </div>

            {error && (
              <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loginMutation.isPending}
              className="btn-primary w-full flex items-center justify-center gap-2 mt-2"
            >
              {loginMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowRight className="w-4 h-4" />
              )}
              {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-600 mt-6 font-mono tracking-wide">
          MAILPILOT ENTERPRISE · SECURE ADMIN ACCESS
        </p>
      </div>
    </div>
  );
}
