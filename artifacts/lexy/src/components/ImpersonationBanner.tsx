/**
 * ImpersonationBanner.tsx — Persistent platform-admin "view as" banner.
 *
 * Renders a sticky banner across the top of the app whenever the
 * caller has an open impersonation session (resolved via GET
 * /api/admin/impersonation/active). Hidden for everyone else.
 *
 * The audit row exists DB-side (admin_impersonation_sessions); this
 * banner is the operator's safety rail — it makes "I forgot I was
 * viewing as Alice" impossible to miss. The "Stop" button POSTs to
 * /api/admin/impersonation/stop and reloads the page so the auth
 * state resets cleanly.
 */
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { canReadImpersonation } from "@/lib/shell-permissions";

interface ActiveSession {
  active: boolean;
  sessionId?: string;
  impersonatedUserId?: string;
  impersonatedUserEmail?: string | null;
  impersonatedUserName?: string | null;
  impersonatedUserRole?: string | null;
  impersonatedTenantId?: string | null;
  expiresAt?: string;
  reason?: string;
}

export function ImpersonationBanner() {
  const { user, isLoading } = useAuth();
  const canLoad = !isLoading && !!user && canReadImpersonation(user.role);
  const [session, setSession] = useState<{ viewerId: string; data: ActiveSession } | null>(null);
  const data = canLoad && session?.viewerId === user?.id ? session.data : null;
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    setSession(null);
    if (!canLoad) return;
    const viewerId = user!.id;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await apiFetch(`${apiBase}/admin/impersonation/active`);
        if (!r.ok) return;
        const json: ActiveSession = await r.json();
        if (!cancelled) setSession({ viewerId, data: json });
      } catch { /* Preserve the page if the admin status check fails. */ }
    };
    void load();
    /* Re-poll every 60s so the banner reflects expiry without a
     * page reload — important when the session is close to its
     * hard cap. */
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [canLoad, user?.id]);

  if (!data?.active) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await apiFetch(`${apiBase}/admin/impersonation/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } finally {
      window.location.reload();
    }
  };

  const minutesLeft = data.expiresAt
    ? Math.max(0, Math.round((new Date(data.expiresAt).getTime() - Date.now()) / 60_000))
    : null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 bg-rose-600 text-white text-sm border-b border-rose-700"
      data-testid="impersonation-banner"
    >
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3">
        <ShieldAlert className="w-4 h-4 shrink-0" />
        <div className="flex-1 min-w-0 truncate">
          <span className="font-semibold">Impersonating</span>{" "}
          <span className="font-mono">
            {data.impersonatedUserEmail ?? data.impersonatedUserName ?? data.impersonatedUserId}
          </span>
          {data.impersonatedUserRole ? <span className="opacity-80"> · {data.impersonatedUserRole}</span> : null}
          {minutesLeft != null ? <span className="opacity-80"> · {minutesLeft}m left</span> : null}
        </div>
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          className="rounded-md bg-white/10 hover:bg-white/20 px-3 py-1 text-xs font-medium disabled:opacity-60"
          data-testid="impersonation-stop"
        >
          Stop session
        </button>
      </div>
    </div>
  );
}

export default ImpersonationBanner;
