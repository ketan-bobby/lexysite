/**
 * lib/interview-session-cookie.ts — Resumable secure interview-session auth
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * Candidates take the interview without logging in. The session ID is the
 * candidate's bearer secret today. To make that safer + resumable across tabs
 * and refreshes, on the first /begin we issue a signed HTTP-only cookie that:
 *   • is bound to that single interview session,
 *   • carries a per-session nonce so we can invalidate stale tabs,
 *   • is HMAC-signed with INTERVIEW_COOKIE_SECRET so the browser can't
 *     fabricate it,
 *   • is paired with a fingerprint stored server-side (UA + Accept-Language +
 *     Sec-CH-UA hash). If a future request arrives with a substantially
 *     different fingerprint we DON'T hard-block — we flip
 *     `step_up_required` so the candidate must re-prove via an email OTP.
 *
 * IP is captured (coarse /24 or /48 prefix) for audit only. We do NOT
 * IP-lock — laptops roam between WiFi/4G all the time and that would lock
 * legitimate candidates out mid-interview.
 *
 * ─── Cookie format ──────────────────────────────────────────────────────────
 *   Name:  lexy_iv_<sessionId>
 *   Value: base64url(JSON{sid,nonce,iat}) + "." + base64url(HMAC-SHA256)
 *   Flags: HttpOnly; Secure (in prod); SameSite=Lax; Path=/api/interviews/<sid>
 *
 * ─── Lifecycle ──────────────────────────────────────────────────────────────
 *   first /begin       → bind fingerprint + secret, set expires_at = now+24h,
 *                        issue cookie. Tell client `durationHours: 24`.
 *   subsequent calls   → middleware verifies cookie, fingerprint, nonce,
 *                        expires_at; on mismatch returns 401 {stepUp:true}
 *                        and the client triggers /step-up/start → /verify.
 *   /step-up/verify    → rebind fingerprint to the current request, rotate
 *                        cookie_nonce + reissue cookie.
 *   /end (completed)   → cookie cleared, status flipped to completed.
 */
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { interviewSessionsTable, trustEventsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

/* ── Trust-event taxonomy ───────────────────────────────────────────────────
   Stable string IDs that match the spec (§8). We keep them as a const map
   so callers in other routes can import the same names instead of
   re-typing magic strings — typos here would silently break the recruiter
   integrity dashboard. */
export const TrustEventType = {
  SESSION_CLAIMED: "SESSION_CLAIMED",
  SESSION_RESUMED: "SESSION_RESUMED",
  SESSION_COMPLETED: "SESSION_COMPLETED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_PAUSED: "SESSION_PAUSED",
  DEVICE_MISMATCH: "DEVICE_MISMATCH",
  IP_CHANGED: "IP_CHANGED",
  SIMULTANEOUS_SESSION_ATTEMPT: "SIMULTANEOUS_SESSION_ATTEMPT",
  OTP_REQUESTED: "OTP_REQUESTED",
  OTP_VERIFIED: "OTP_VERIFIED",
  OTP_FAILED: "OTP_FAILED",
  TRUST_SCORE_UPDATED: "TRUST_SCORE_UPDATED",
  COOKIE_TAMPERED: "COOKIE_TAMPERED",
} as const;
export type TrustEventTypeName = typeof TrustEventType[keyof typeof TrustEventType];

export type TrustSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * recordTrustEvent — single source of truth for writing an integrity event.
 *
 * Side effects (all best-effort, never fail the calling request):
 *   1. INSERT into `trust_events` (the normalised audit log).
 *   2. Atomically decrement `interview_sessions.trust_score` by `scoreImpact`
 *      (clamped 0..100) and increment `suspicious_event_count` when the
 *      severity is medium-or-higher.
 *   3. When severity === "critical" the session is auto-flipped to status
 *      `flagged` with `flagged_at = now()` so a recruiter is forced to
 *      triage before the candidate can advance.
 *
 * Trust logic stays server-side (spec §11) — the client never sees
 * scoreImpact, severity, or running totals on the candidate-facing API.
 */
export async function recordTrustEvent(input: {
  sessionId: string;
  tenantId?: string | null;
  candidateId?: string | null;
  eventType: TrustEventTypeName | string;
  severity?: TrustSeverity;
  scoreImpact?: number; // negative = reduces trust; 0 for informational
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const severity: TrustSeverity = input.severity ?? "info";
  const scoreImpact = Math.trunc(input.scoreImpact ?? 0);
  try {
    /* Resolve tenantId if caller didn't supply one — we want every row
       tagged so cross-tenant filtering at the dashboard is trivial. */
    let tenantId = input.tenantId ?? null;
    let candidateId = input.candidateId ?? null;
    if (!tenantId || !candidateId) {
      const [s] = await db.select({
        tenantId: interviewSessionsTable.tenantId,
        candidateId: interviewSessionsTable.candidateId,
      }).from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.id, input.sessionId)).limit(1);
      if (s) {
        tenantId   ??= s.tenantId   ?? null;
        candidateId ??= s.candidateId ?? null;
      }
    }
    if (!tenantId) tenantId = "unknown";

    await db.insert(trustEventsTable).values({
      tenantId,
      sessionId: input.sessionId,
      candidateId,
      eventType: String(input.eventType),
      severity,
      scoreImpact,
      metadata: (input.metadata ?? {}) as any,
    });

    /* Atomic counter update — `GREATEST/LEAST` keeps trust_score in [0,100]
       even under concurrent writes (no read-modify-write race). */
    const bumpSuspicious = severity === "medium" || severity === "high" || severity === "critical";
    const setExpr: any = {
      trustScore: sql`GREATEST(0, LEAST(100, ${interviewSessionsTable.trustScore} + ${scoreImpact}))`,
    };
    if (bumpSuspicious) {
      setExpr.suspiciousEventCount = sql`${interviewSessionsTable.suspiciousEventCount} + 1`;
    }
    if (severity === "critical") {
      setExpr.status     = "flagged" as any;
      setExpr.flaggedAt  = new Date();
    }
    await db.update(interviewSessionsTable)
      .set(setExpr)
      .where(eq(interviewSessionsTable.id, input.sessionId));
  } catch (err) {
    logger.error({ err, sessionId: input.sessionId, eventType: input.eventType }, "[trust-event] write failed");
  }
}

const TTL_HOURS = Math.max(1, Math.min(168, Number(process.env.INTERVIEW_SESSION_TTL_HOURS ?? "24")));
const OTP_TTL_MIN = 10;
const MAX_STEP_UP_ATTEMPTS = 5;
const RAW_SECRET =
  process.env.INTERVIEW_COOKIE_SECRET
  ?? process.env.SESSION_SECRET
  ?? process.env.AUTH_SECRET;

/* Fail-closed by DEFAULT — without a real secret, every cookie HMAC would be
   forgeable by anyone with the source (the fallback string is public). We
   refuse to mint or verify cookies in that state and the middleware below
   treats it as a hard 500. The insecure dev fallback now requires the
   explicit opt-in ALLOW_DEV_SECRET_FALLBACK=true (never set on a real
   server) instead of being inherited whenever NODE_ENV happens to not be
   "production". */
const COOKIE_SECRET = RAW_SECRET ?? "dev-only-do-not-use-in-prod";
const SECRET_PRESENT = !!RAW_SECRET;
const ALLOW_DEV_FALLBACK = process.env.ALLOW_DEV_SECRET_FALLBACK === "true";
if (!SECRET_PRESENT && !ALLOW_DEV_FALLBACK) {
  logger.error("[interview-cookie] FATAL: INTERVIEW_COOKIE_SECRET/SESSION_SECRET/AUTH_SECRET must be set — interview-session cookies will be refused (set ALLOW_DEV_SECRET_FALLBACK=true for local dev only)");
}
function secretReady(): boolean {
  return SECRET_PRESENT || ALLOW_DEV_FALLBACK;
}

export const INTERVIEW_SESSION_TTL_HOURS = TTL_HOURS;

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function cookieNameFor(sessionId: string): string {
  /* Per-session cookie name lets one browser hold cookies for multiple
     candidate interviews without colliding. */
  return `lexy_iv_${sessionId}`;
}

export function signCookie(sid: string, nonce: string): string {
  const payload = b64url(JSON.stringify({ sid, nonce, iat: Math.floor(Date.now() / 1000) }));
  const mac = b64url(crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest());
  return `${payload}.${mac}`;
}

export function verifyCookie(value: string | undefined, sid: string): { ok: true; nonce: string } | { ok: false; reason: string } {
  if (!value) return { ok: false, reason: "no_cookie" };
  const parts = value.split(".");
  if (parts.length !== 2) return { ok: false, reason: "bad_format" };
  const [payload, mac] = parts;
  const expected = b64url(crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest());
  if (mac.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { ok: false, reason: "bad_mac" };
  }
  let parsed: any;
  try { parsed = JSON.parse(b64urlDecode(payload).toString("utf8")); } catch { return { ok: false, reason: "bad_payload" }; }
  if (parsed?.sid !== sid) return { ok: false, reason: "sid_mismatch" };
  if (typeof parsed?.nonce !== "string") return { ok: false, reason: "no_nonce" };
  return { ok: true, nonce: parsed.nonce };
}

export function fingerprintFor(req: Request): { fp: string; ua: string; ipPrefix: string } {
  const ua = String(req.headers["user-agent"] ?? "");
  const al = String(req.headers["accept-language"] ?? "");
  const ch = String(req.headers["sec-ch-ua"] ?? "");
  const platform = String(req.headers["sec-ch-ua-platform"] ?? "");
  const fp = crypto.createHash("sha256").update(`${ua}|${al}|${ch}|${platform}`).digest("hex");
  const ip = (req.ip ?? "").trim();
  let ipPrefix = "";
  if (ip) {
    if (ip.includes(":")) ipPrefix = ip.split(":").slice(0, 3).join(":") + "::/48";
    else ipPrefix = ip.split(".").slice(0, 3).join(".") + ".0/24";
  }
  return { fp, ua, ipPrefix };
}

export function setSessionCookie(res: Response, sessionId: string, nonce: string, expiresAt: Date): void {
  const value = signCookie(sessionId, nonce);
  res.cookie(cookieNameFor(sessionId), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    /* Path-scoped to this one interview so a leaked cookie can't be replayed
       against any other endpoint and so multiple interview cookies coexist. */
    path: `/api/interviews/${sessionId}`,
  });
}

export function clearSessionCookie(res: Response, sessionId: string): void {
  res.clearCookie(cookieNameFor(sessionId), { path: `/api/interviews/${sessionId}` });
}

export function newNonce(): string { return crypto.randomBytes(18).toString("hex"); }
export function newSecret(): string { return crypto.randomBytes(32).toString("hex"); }

/* Map legacy short kinds (used by older log call-sites) to the new
   normalised event types + severities so we can route everything through
   recordTrustEvent without breaking the rolling jsonb log. */
const LEGACY_KIND_MAP: Record<string, { type: TrustEventTypeName; severity: TrustSeverity; scoreImpact: number }> = {
  cookie_invalid:               { type: TrustEventType.COOKIE_TAMPERED,              severity: "high",     scoreImpact: -25 },
  nonce_mismatch:               { type: TrustEventType.SIMULTANEOUS_SESSION_ATTEMPT, severity: "high",     scoreImpact: -20 },
  fingerprint_mismatch:         { type: TrustEventType.DEVICE_MISMATCH,              severity: "medium",   scoreImpact: -10 },
  begin_fingerprint_mismatch:   { type: TrustEventType.DEVICE_MISMATCH,              severity: "medium",   scoreImpact: -10 },
  step_up_otp_failed:           { type: TrustEventType.OTP_FAILED,                   severity: "medium",   scoreImpact:  -5 },
  ip_changed:                   { type: TrustEventType.IP_CHANGED,                   severity: "low",      scoreImpact:  -2 },
};

async function logSuspicious(sessionId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  /* Keep the rolling jsonb event tail (used by the legacy proctor-report
     view) AND emit a normalised trust_events row in parallel. */
  try {
    const [s] = await db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.id, sessionId)).limit(1);
    if (s) {
      const events = ((s.suspiciousEvents as any[]) ?? []).slice(-49);
      events.push({ kind, detail, ts: new Date().toISOString() });
      await db.update(interviewSessionsTable)
        .set({ suspiciousEvents: events } as any)
        .where(eq(interviewSessionsTable.id, sessionId));
    }
    logger.warn({ sessionId, kind, ...detail }, "[interview-session] suspicious activity");
  } catch (err) {
    logger.error({ err, sessionId, kind }, "[interview-session] failed to record suspicious event");
  }
  const mapped = LEGACY_KIND_MAP[kind] ?? { type: kind as any, severity: "medium" as TrustSeverity, scoreImpact: -5 };
  await recordTrustEvent({
    sessionId,
    eventType: mapped.type,
    severity:  mapped.severity,
    scoreImpact: mapped.scoreImpact,
    metadata: { kind, ...detail },
  });
}

/**
 * requireInterviewSessionCookie — middleware applied to every candidate-facing
 * route after the first /begin. Reads the cookie, verifies HMAC, checks
 * fingerprint + nonce + expiry, and either passes through, requests step-up,
 * or 410-Gone the session.
 *
 * The route handler can read the loaded session at `req.interviewSession`
 * (avoids a duplicate DB hit).
 */
export async function requireInterviewSessionCookie(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sid = (req.params as any).interviewId as string | undefined;
  if (!sid) { res.status(400).json({ error: "interviewId required" }); return; }
  if (!secretReady()) {
    /* Fail-closed: in production with no secret env var we refuse the request
       rather than verify against a known dev string. */
    res.status(500).json({ error: "session_auth_unavailable" }); return;
  }

  const cookieVal = (req as any).cookies?.[cookieNameFor(sid)];
  const verified = verifyCookie(cookieVal, sid);

  const [session] = await db.select().from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sid)).limit(1);
  if (!session) { res.status(404).json({ error: "Not found" }); return; }

  /* Terminal states — no resume allowed. */
  if (session.status === "completed" || session.completedAt) {
    res.status(410).json({ error: "session_completed" }); return;
  }
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    if (session.status !== "expired" as any && session.status !== "abandoned" as any) {
      await db.update(interviewSessionsTable)
        .set({ status: "expired" as any, expiredAt: new Date() } as any)
        .where(eq(interviewSessionsTable.id, sid)).catch(() => {});
      void recordTrustEvent({
        sessionId: sid,
        tenantId: session.tenantId,
        candidateId: session.candidateId,
        eventType: TrustEventType.SESSION_EXPIRED,
        severity: "info",
        scoreImpact: 0,
        metadata: { expiresAt: session.expiresAt.toISOString() },
      });
    }
    res.status(410).json({ error: "SESSION_EXPIRED", code: "SESSION_EXPIRED", expiresAt: session.expiresAt.toISOString() });
    return;
  }

  /* No binding yet — session has never been opened. The route should be
     /begin, which handles binding itself; deny everything else. */
  if (!session.bindSecret || !session.cookieNonce || !session.bindFingerprint) {
    res.status(401).json({ error: "session_not_started", needsBegin: true });
    return;
  }

  /* Cookie present but bad MAC / wrong sid — treat as a takeover attempt. */
  if (!verified.ok) {
    void logSuspicious(sid, "cookie_invalid", { reason: verified.reason, ip: req.ip });
    res.status(401).json({ error: "VERIFICATION_REQUIRED", code: "VERIFICATION_REQUIRED", stepUp: true });
    return;
  }

  /* Nonce mismatch = the session was already resumed elsewhere (or step-up
     rotated it). Refuse — only one active session at a time. */
  if (verified.nonce !== session.cookieNonce) {
    void logSuspicious(sid, "nonce_mismatch", { ip: req.ip });
    res.status(401).json({ error: "SESSION_ALREADY_ACTIVE", code: "SESSION_ALREADY_ACTIVE", stepUp: true });
    return;
  }

  /* Fingerprint mismatch → require step-up but do not hard-block. */
  const { fp, ipPrefix } = fingerprintFor(req);
  if (fp !== session.bindFingerprint) {
    if (!session.stepUpRequired) {
      await db.update(interviewSessionsTable)
        .set({ stepUpRequired: true, verificationRequired: true } as any)
        .where(eq(interviewSessionsTable.id, sid)).catch(() => {});
    }
    void logSuspicious(sid, "fingerprint_mismatch", {
      bound: session.bindFingerprint?.slice(0, 12),
      seen: fp.slice(0, 12),
      boundIp: session.bindIpPrefix,
      seenIp: ipPrefix,
    });
    res.status(401).json({ error: "SESSION_DEVICE_MISMATCH", code: "SESSION_DEVICE_MISMATCH", stepUp: true });
    return;
  }

  /* IP-prefix change is a SOFT signal only (per spec §5: do not hard-lock
     by IP). Log once when it changes and let the request through. */
  if (session.bindIpPrefix && ipPrefix && session.bindIpPrefix !== ipPrefix) {
    void recordTrustEvent({
      sessionId: sid,
      tenantId: session.tenantId,
      candidateId: session.candidateId,
      eventType: TrustEventType.IP_CHANGED,
      severity: "low",
      scoreImpact: -2,
      metadata: { from: session.bindIpPrefix, to: ipPrefix },
    });
    await db.update(interviewSessionsTable)
      .set({ bindIpPrefix: ipPrefix } as any)
      .where(eq(interviewSessionsTable.id, sid)).catch(() => {});
  }

  if (session.stepUpRequired) {
    res.status(401).json({ error: "VERIFICATION_REQUIRED", code: "VERIFICATION_REQUIRED", stepUp: true });
    return;
  }

  /* Touch lastActiveAt — best-effort, fire-and-forget so we don't add a
     synchronous round-trip to every request. */
  void db.update(interviewSessionsTable)
    .set({ lastActiveAt: new Date() } as any)
    .where(eq(interviewSessionsTable.id, sid))
    .catch(() => {});

  (req as any).interviewSession = session;
  next();
}

export async function bindOrResumeOnBegin(
  req: Request,
  res: Response,
  sessionId: string,
): Promise<{ ok: true; expiresAt: Date; firstOpen: boolean } | { ok: false; status: number; body: any }> {
  if (!secretReady()) {
    return { ok: false, status: 500, body: { error: "session_auth_unavailable" } };
  }
  const [session] = await db.select().from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sessionId)).limit(1);
  if (!session) return { ok: false, status: 404, body: { error: "Not found" } };
  if (session.status === "completed" || session.completedAt) {
    return { ok: false, status: 410, body: { error: "SESSION_COMPLETED", code: "SESSION_COMPLETED" } };
  }
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    return { ok: false, status: 410, body: { error: "SESSION_EXPIRED", code: "SESSION_EXPIRED", expiresAt: session.expiresAt.toISOString() } };
  }

  const { fp, ua, ipPrefix } = fingerprintFor(req);
  const now = new Date();

  /* First-ever open: bind fingerprint, mint secret/nonce, start the 24h clock. */
  if (!session.bindSecret || !session.cookieNonce || !session.bindFingerprint || !session.expiresAt) {
    const nonce = newNonce();
    const connectionId = crypto.randomBytes(12).toString("hex");
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000);
    await db.update(interviewSessionsTable).set({
      bindSecret: newSecret(),
      bindUserAgent: ua.slice(0, 500),
      bindFingerprint: fp,
      bindIpPrefix: ipPrefix,
      cookieNonce: nonce,
      expiresAt,
      stepUpRequired: false,
      verificationRequired: false,
      /* State-machine bookkeeping (spec §2 + §12). */
      status: "active" as any,
      claimedAt: now,
      openedAt: now,
      lastActiveAt: now,
      activeConnectionId: connectionId,
    } as any).where(eq(interviewSessionsTable.id, sessionId));
    setSessionCookie(res, sessionId, nonce, expiresAt);
    void recordTrustEvent({
      sessionId,
      tenantId: session.tenantId,
      candidateId: session.candidateId,
      eventType: TrustEventType.SESSION_CLAIMED,
      severity: "info",
      scoreImpact: 0,
      metadata: { ipPrefix, fpPrefix: fp.slice(0, 12) },
    });
    return { ok: true, expiresAt, firstOpen: true };
  }

  /* Resume path — fingerprint must match. If it does we rotate the nonce and
     re-issue the cookie (handles candidate clearing cookies between sittings).
     If it doesn't, flip step-up and refuse to bind a new device until OTP. */
  if (fp !== session.bindFingerprint) {
    await db.update(interviewSessionsTable)
      .set({ stepUpRequired: true, verificationRequired: true } as any)
      .where(eq(interviewSessionsTable.id, sessionId)).catch(() => {});
    void logSuspicious(sessionId, "begin_fingerprint_mismatch", { ip: req.ip });
    return { ok: false, status: 401, body: { error: "SESSION_DEVICE_MISMATCH", code: "SESSION_DEVICE_MISMATCH", stepUp: true } };
  }

  if (session.stepUpRequired) {
    return { ok: false, status: 401, body: { error: "VERIFICATION_REQUIRED", code: "VERIFICATION_REQUIRED", stepUp: true } };
  }

  const nonce = newNonce();
  const connectionId = crypto.randomBytes(12).toString("hex");
  await db.update(interviewSessionsTable)
    .set({
      cookieNonce: nonce,
      status: "resumed" as any,
      resumedAt: now,
      lastActiveAt: now,
      resumeCount: sql`${interviewSessionsTable.resumeCount} + 1`,
      activeConnectionId: connectionId,
    } as any)
    .where(eq(interviewSessionsTable.id, sessionId));
  setSessionCookie(res, sessionId, nonce, session.expiresAt);
  void recordTrustEvent({
    sessionId,
    tenantId: session.tenantId,
    candidateId: session.candidateId,
    eventType: TrustEventType.SESSION_RESUMED,
    severity: (session.resumeCount ?? 0) >= 5 ? "medium" : "info",
    scoreImpact: (session.resumeCount ?? 0) >= 5 ? -3 : 0,
    metadata: { resumeCount: (session.resumeCount ?? 0) + 1 },
  });
  return { ok: true, expiresAt: session.expiresAt, firstOpen: false };
}

export const STEP_UP_OTP_TTL_MIN = OTP_TTL_MIN;
export const STEP_UP_MAX_ATTEMPTS = MAX_STEP_UP_ATTEMPTS;

export function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(`${COOKIE_SECRET}|${otp}`).digest("hex");
}

export function generateOtp(): string {
  /* 6 random digits — leading-zero safe. */
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export async function clearOnComplete(sessionId: string, res: Response): Promise<void> {
  await db.update(interviewSessionsTable)
    .set({ cookieNonce: null, stepUpRequired: false, verificationRequired: false, activeConnectionId: null } as any)
    .where(eq(interviewSessionsTable.id, sessionId)).catch(() => {});
  clearSessionCookie(res, sessionId);
}
