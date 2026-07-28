/**
 * pages/auth-microsoft-callback.tsx — Microsoft Entra SSO landing page
 *
 * The API callback (GET /api/auth/microsoft/callback) finishes the OIDC code
 * exchange and sets the httpOnly session cookie, then 302s the browser here.
 *
 * Production: this page simply calls GET /api/auth/me (cookie auth) to load
 * the user profile, caches it via useAuth().login(user), and redirects to the
 * role-appropriate home — the session token never appears client-side.
 *
 * DEV ONLY: the Replit preview iframe blocks third-party cookies, so the
 * server also hands the token in the URL FRAGMENT (#token=…, never a query
 * param, so it can't hit server logs or Referer). We strip it from the
 * address bar immediately and feed it to the shared DEV Bearer fallback.
 *
 * On any failure it shows a friendly message with a link back to /login.
 * (Server-side OIDC failures never reach this page — they redirect straight
 * to /login?sso_error=<code>.)
 *
 * Route: /auth/microsoft/callback
 */
import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { apiBase, authHeaders } from "@/lib/api";
import type { User } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function MicrosoftCallback() {
  const { login } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // DEV fragment handoff: #token=<v2-token> (absent in production).
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const devToken = new URLSearchParams(hash).get("token");

      // Strip the fragment from the address bar immediately.
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        /* no-op */
      }

      try {
        const res = await fetch(`${apiBase}/auth/me`, {
          credentials: "include",
          headers: {
            "Cache-Control": "no-cache",
            // DEV iframe fallback: prefer the fresh fragment token; otherwise
            // fall back to the shared DEV Bearer helper. Both are {} in prod.
            ...(import.meta.env.DEV && devToken
              ? { Authorization: `Bearer ${devToken}` }
              : authHeaders()),
          },
        });
        if (!res.ok) throw new Error("me_failed");
        const user = (await res.json()) as User;

        login(user, import.meta.env.DEV && devToken ? devToken : undefined);

        const dest =
          user.role === "candidate"      ? "portal"    :
          user.role === "platform_admin" ? "platform"  :
          "dashboard";
        window.location.href = import.meta.env.BASE_URL + dest;
      } catch {
        if (!cancelled) setError("We couldn't complete your Microsoft sign-in. Please try again.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [login]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      {error ? (
        <div className="max-w-sm text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
            <ShieldAlert className="w-6 h-6 text-rose-400" />
          </div>
          <p className="text-sm text-foreground/80">{error}</p>
          <a
            href={`${BASE}/login`}
            className="inline-block text-sm font-semibold text-primary hover:opacity-80 transition-opacity"
          >
            ← Back to sign in
          </a>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-sm">Completing your Microsoft sign-in…</p>
        </div>
      )}
    </div>
  );
}
