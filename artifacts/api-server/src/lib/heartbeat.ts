/**
 * lib/heartbeat.ts — BetterStack (or any URL-based) cron heartbeat helper.
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * BetterStack (formerly Better Uptime) lets you create "heartbeat" monitors
 * that alert when a URL is NOT pinged within a configured window. That's the
 * right primitive for our schedulers — an HTTP /healthz check only proves the
 * web server is up, not that the 15-minute outreach tick actually ran.
 *
 * Usage:
 *   import { heartbeat } from "./heartbeat";
 *   // at the end of a successful scheduler tick:
 *   heartbeat("outreach");                  // success ping
 *   heartbeat("outreach", "fail", err);     // failure ping (BetterStack: /fail)
 *
 * Configuration (env vars, one per heartbeat — no central registry):
 *   BETTERSTACK_HEARTBEAT_OUTREACH_URL=https://uptime.betterstack.com/api/v1/heartbeat/<token>
 *   BETTERSTACK_HEARTBEAT_RECRUITER_DIGEST_URL=...
 *   BETTERSTACK_HEARTBEAT_TRIAL_EXPIRY_URL=...
 *   BETTERSTACK_HEARTBEAT_ANTI_GHOST_URL=...
 *
 * The name passed to heartbeat() is upper-snake-cased and looked up as
 * `BETTERSTACK_HEARTBEAT_<NAME>_URL`. If the env var is unset the call is a
 * silent no-op — that means:
 *   • Dev / preview boots without errors even though no monitoring is wired.
 *   • Adding a new scheduler is a one-line `heartbeat("foo")` + one secret.
 *   • Removing a monitor in BetterStack just means unset the secret; no code
 *     change required.
 *
 * ─── Why not block on the ping? ──────────────────────────────────────────────
 * The HTTP ping is fire-and-forget: we await nothing and swallow errors. A
 * scheduler tick must not fail because BetterStack is unreachable, and we
 * must not delay the next tick by 5s waiting for a ping timeout. Errors are
 * logged at debug-level only — failed pings will show up in BetterStack as
 * missed heartbeats, which is exactly the alert we want.
 */
import { logger } from "./logger";

type HeartbeatStatus = "ok" | "fail";

const PING_TIMEOUT_MS = 5_000;

function envKey(name: string): string {
  /* "recruiter-digest" / "recruiter_digest" → RECRUITER_DIGEST */
  const slug = name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase().replace(/^_+|_+$/g, "");
  return `BETTERSTACK_HEARTBEAT_${slug}_URL`;
}

export function heartbeat(name: string, status: HeartbeatStatus = "ok", _err?: unknown): void {
  /* Belt-and-suspenders: a scheduler tick MUST NOT crash because of anything
   * that happens in this helper — bad URL parsing, missing fetch global, etc.
   * The whole body is wrapped so we can guarantee zero-throw. The `_err` param
   * is kept for call-site readability but intentionally unused — failure
   * context is the scheduler's responsibility to log at error level; the
   * helper is transport-observability only. */
  try {
    const key = envKey(name);
    const base = process.env[key];
    if (!base) return; // No-op when unconfigured — see file docs.

    /* BetterStack convention: append `/fail` for failure pings. Other
     * providers (healthchecks.io etc.) follow the same suffix. */
    const url = status === "fail" ? `${base.replace(/\/$/, "")}/fail` : base;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    /* fire-and-forget — we deliberately don't await this. */
    fetch(url, { method: "POST", signal: controller.signal })
      .catch((e) => {
        /* Debug-level only: a missed ping is the alert itself, on
         * BetterStack's side. We don't want a noisy logger.warn every time
         * BetterStack has a hiccup. */
        logger.debug({ heartbeat: name, err: (e as Error)?.message }, "[heartbeat] ping failed");
      })
      .finally(() => clearTimeout(timer));
  } catch (e) {
    logger.debug({ heartbeat: name, err: (e as Error)?.message }, "[heartbeat] helper threw");
  }
}
