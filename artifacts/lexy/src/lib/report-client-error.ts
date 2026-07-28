/**
 * lib/report-client-error.ts — fire-and-forget browser error telemetry
 *
 * Posts a client-side failure to POST /api/client-errors, which lands it in
 * the api-server's `system_errors` table (the self-hosted Sentry equivalent)
 * so platform admins see it on the System Errors dashboard.
 *
 * Contract:
 *   - Fire-and-forget: never awaited by callers, never throws, swallows its
 *     own failures. Reporting an error must never create a second error.
 *   - `keepalive: true` so reports fired during page-teardown-adjacent
 *     moments (interview end / upload settle) still get sent.
 *   - Auth: bearer header when available, plus the httpOnly session cookie
 *     via credentials: "include" — same dual path the recording routes use.
 */
import { apiBase, authHeaders } from "@/lib/api";

export function reportClientError(
  message: string,
  extra?: Record<string, unknown> & { sessionId?: string; phase?: string },
): void {
  try {
    const { sessionId, phase, ...rest } = extra ?? {};
    fetch(`${apiBase}/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify({
        message,
        context: {
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          phase: typeof phase === "string" ? phase : undefined,
          extra: Object.keys(rest).length ? rest : undefined,
        },
      }),
    }).catch(() => {
      /* best-effort — telemetry only */
    });
  } catch {
    /* never let telemetry break the caller */
  }
}
