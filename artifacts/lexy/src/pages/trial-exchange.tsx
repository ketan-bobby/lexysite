/**
 * pages/trial-exchange.tsx — Legacy redirect to /auth/trial-setup
 *
 * Older trial verification emails (sent before May 2026) redirected the
 * browser here. We now use a friendlier "set your password" page instead,
 * so this file simply forwards the loginToken on to /auth/trial-setup
 * without touching it (preserves the one-time, single-use guarantee).
 */
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function TrialExchange() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lt = params.get("lt");
    const dest = lt
      ? `${BASE}/auth/trial-setup?lt=${encodeURIComponent(lt)}`
      : `${BASE}/login?trial_error=invalid`;
    window.location.replace(dest);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
        <h1 className="text-lg font-semibold text-foreground mb-1">Redirecting…</h1>
        <p className="text-sm text-muted-foreground">Taking you to set your password.</p>
      </div>
    </div>
  );
}
