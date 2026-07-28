/**
 * api.ts — Shared API utilities for the candidate portal.
 *
 * All portal pages should use `apiFetch` instead of raw `fetch` so that
 * cookie auth (credentials: "include") and the DEV-only Bearer fallback are
 * attached automatically.
 *
 * Usage:
 *   import { apiBase, apiFetch } from "@/lib/api";
 *   const res = await apiFetch(`${apiBase}/portal/career-profile`);
 */

/**
 * Base URL for all API calls.
 * Constructed from Vite's BASE_URL so it works under any deployment prefix
 * (e.g., `/` in dev, `/__replco/...` in Replit preview).
 */
export const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

/**
 * Bearer fallback for environments where the httpOnly session cookie is not
 * delivered (the Replit preview iframe, where browsers block third-party
 * cookies). DEV-ONLY: production builds return {} — auth there rides solely
 * on the httpOnly session cookie. Vite statically replaces import.meta.env.DEV
 * so the whole branch is dead-code-eliminated from production bundles.
 * This is the ONLY remaining client-side token read — production builds
 * dead-code-eliminate it (Phase 3c complete).
 */
export function authHeaders(): Record<string, string> {
  if (!import.meta.env.DEV) return {};
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Authenticated fetch wrapper for candidate portal API calls.
 *
 * Auth rides on the httpOnly `session_token` cookie (set by the server at
 * login) via `credentials: "include"`, with a localStorage Bearer fallback
 * for iframe contexts where the cookie is blocked (see `authHeaders`).
 *
 * @param url  - Full URL to fetch (build with `apiBase` prefix)
 * @param init - Standard RequestInit options (method, body, headers, etc.)
 * @param opts - Extra options (see ApiFetchOptions)
 *
 * On a 401 response (unless opts.allowUnauthenticated) the shared
 * session-end flow runs: cache cleared, cookie cleared server-side,
 * redirect to /login. 403s are never intercepted.
 */
/**
 * Extra apiFetch options (kept separate from RequestInit).
 */
export interface ApiFetchOptions {
  /**
   * Set true for calls where a 401 is an expected, non-session outcome —
   * e.g. probes fired on public pages before we know whether the visitor is
   * logged in (careers page candidate probe). Suppresses the global
   * redirect-to-login on 401; the caller handles the response itself.
   */
  allowUnauthenticated?: boolean;
}

/** Base path for client-side routes (no trailing slash). */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Re-entrancy guard: many parallel requests can 401 at once when a session
 * expires (dashboard pages fire 5+ loads on mount). Only the first triggers
 * the session-end flow; the redirect is a full page navigation anyway.
 */
let sessionEnding = false;

/**
 * Shared session-end flow — the single place that tears a session down.
 * Used by BOTH the explicit logout() in auth-context.tsx and the global
 * 401 interceptor below, so cache clearing, dev-token clearing, cross-tab
 * `storage` sync, server cookie clearing, and the login redirect stay in
 * lockstep.
 *
 * Steps:
 *  1. Clear the localStorage "user" cache (also fires the `storage` event
 *     in other same-origin tabs → they drop the session too).
 *  2. DEV ONLY: clear the mirrored Bearer token.
 *  3. Ask the server to clear the httpOnly cookie. Fails gracefully — an
 *     already-invalid session makes this a no-op 401/403/network error and
 *     must never throw or block the redirect (.catch + .finally).
 *  4. Redirect to the login page (skipped if we're already on it, so a 401
 *     fired from the login page itself can never loop).
 */
export function endSession(): void {
  if (sessionEnding) return;
  sessionEnding = true;
  try {
    localStorage.removeItem("user");
    if (import.meta.env.DEV) localStorage.removeItem("token");
  } catch {
    /* storage unavailable (private mode) — still redirect */
  }
  fetch(`${BASE}/api/auth/logout`, { method: "POST", credentials: "include" })
    .catch(() => {})
    .finally(() => {
      const loginPath = import.meta.env.BASE_URL + "login";
      if (window.location.pathname !== loginPath) {
        window.location.href = loginPath;
      } else {
        // Already on the login page — nothing to do; allow future calls.
        sessionEnding = false;
      }
    });
}

export async function apiFetch(
  url: string,
  init: RequestInit = {},
  opts: ApiFetchOptions = {},
): Promise<Response> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...authHeaders(),
      // Caller-supplied headers override defaults (e.g., Content-Type for JSON bodies)
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  // Global session-expiry handling: a 401 on a session-authenticated call
  // means the cookie is gone/expired → end the session and go to login.
  // 403 is deliberately NOT handled here (CSRF origin guard / role gates —
  // not a session problem); call sites keep their own 403 handling.
  if (res.status === 401 && !opts.allowUnauthenticated) {
    endSession();
  }
  return res;
}
