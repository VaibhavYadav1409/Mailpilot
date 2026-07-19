import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Mail, Loader2, Eye, EyeOff } from "lucide-react";
import { authApi, ApiError } from "@/lib/api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await authApi.login(email, password);
      // Hard reload is intentional (resets all in-memory state after auth
      // changes) — see useAuth.ts's logout for why this goes through the
      // hash rather than an absolute path: `window.location.href = "/"`
      // fails under the packaged desktop app's file:// protocol.
      window.location.hash = "/";
      window.location.reload();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm p-8 shadow-lg">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center mb-4">
            <Mail className="text-primary-foreground w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">MailPilot AI</h1>
          <p className="text-muted-foreground text-sm mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              className="w-full px-3 py-2 rounded-md border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              placeholder="you@company.com"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                className="w-full px-3 py-2 pr-10 rounded-md border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                placeholder="Enter password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in…</> : "Sign in"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground text-center mt-6">
          After <code className="font-mono">pnpm db:seed</code>, try{" "}
          <code className="font-mono">agent1@acme.com</code> / <code className="font-mono">ChangeMe123!</code>
        </p>
      </Card>
    </div>
  );
}
