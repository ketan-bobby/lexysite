/**
 * routes/invites.ts — Candidate Portal Magic-Link Invites
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Handles magic-link generation, validation, and acceptance for all four
 * candidate portal invite flows. Invited candidates receive an email with a
 * unique token URL; clicking it creates their portal account and signs them in.
 *
 * ─── Four invite flows ───────────────────────────────────────────────────────
 *   1. Recruiter manually invites a candidate from the Candidates page
 *      POST /invites/:candidateId/send → generates token → sends email
 *   2. Post-apply auto-invite (triggered from public.ts when a candidate
 *      submits a job application through the public careers portal)
 *   3. Magic-link acceptance — GET /accept-invite?token=<tok>
 *      Validates the token, creates a users row (role="candidate"), redirects
 *      to the portal with a session token.
 *   4. Auto-invite on intelligence stage advance — when the Intelligence Agent
 *      advances a candidate to "invite_sent" stage it calls generateInviteToken()
 *      directly and enqueues an email.
 *
 * ─── Exported helpers ────────────────────────────────────────────────────────
 *   ensureCandidateUser(candidateId, tenantId)
 *     Find or create the users row for a candidate (idempotent). Called by
 *     applications.ts and public.ts before generating invite tokens.
 *
 *   generateInviteToken(candidateId, tenantId, expiresIn?)
 *     Generate a UUID token, persist it in invite_tokens with a 7-day TTL,
 *     and return the full magic-link URL. Used by all four invite flows above.
 *
 * ─── Token security ──────────────────────────────────────────────────────────
 * Tokens are UUID v4. Expiry is enforced at validation time (GET /accept-invite
 * checks expires_at before accepting). After acceptance the token is marked used
 * so replay attacks are impossible.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { candidatesTable, usersTable, inviteTokensTable, candidateCareerProfilesTable } from "@workspace/db";
import { eq, and, desc as descOp, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { issueToken, getAuthUserId, setSessionTokenCookie, devOnlyTokenBody } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { getTenantRegion } from "../lib/region";
import { rateLimit } from "../middlewares/rateLimit";
import { validate } from "../middlewares/validate";
import { sendEmail, isEmailConfigured, plainToHtml } from "../lib/email";

const GenerateInviteBody = z.object({
  candidateId: z.string().min(1),
});

const BulkCareerInviteBody = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(200),
});

const router: IRouter = Router();

/* ─── Helpers ────────────────────────────────────────────────────────────── */

export async function ensureCandidateUser(candidateId: string, tenantId: string): Promise<string | null> {
  const [candidate] = await db
    .select({ id: candidatesTable.id, firstName: candidatesTable.firstName, lastName: candidatesTable.lastName, email: candidatesTable.email, pool: candidatesTable.pool })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)))
    .limit(1);

  if (!candidate) return null;

  /* Look up an existing portal user for this candidate, scoped strictly to
   * (same tenant) AND (role === 'candidate'). The old version matched on
   * email alone, which meant a recruiter / admin in the same tenant who
   * shared an email with the candidate would be returned as the "existing"
   * user — and the invite-accept flow then minted a fresh session for that
   * staff role. That is a privilege-escalation path; this scope closes it. */
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.email, candidate.email),
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.role, "candidate" as any),
    ))
    .limit(1);

  /* Ruling (July 2026): portal access and platform-pool discovery are
   * DECOUPLED. This helper used to promote any candidate to pool='platform'
   * here — that made applying to one job / receiving an invite silently make
   * the candidate discoverable to every licensed tenant. Removed. Platform-
   * pool entry now happens ONLY via the explicit opt-in chokepoint in
   * lib/discovery-consent.ts. */

  if (existing.length > 0) {
    /* Backfill candidates.user_id for legacy candidates whose portal user
     * pre-existed. Idempotent — only sets when still NULL. The unique index
     * (migration 0012) prevents two candidate rows from claiming the user. */
    await db.update(candidatesTable)
      .set({ userId: existing[0].id })
      .where(and(eq(candidatesTable.id, candidateId), sql`${candidatesTable.userId} IS NULL`));
    return existing[0].id;
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({
      tenantId,
      email:        candidate.email,
      name:         `${candidate.firstName} ${candidate.lastName}`,
      passwordHash: "portal_invited",
      role:         "candidate",
    })
    .returning({ id: usersTable.id });

  /* Link the candidate row to the freshly-minted portal user so the candidate
   * resolves via FK in getCandidateId(), not via email. */
  await db.update(candidatesTable)
    .set({ userId: newUser.id })
    .where(eq(candidatesTable.id, candidateId));

  return newUser.id;
}

export async function generateInviteToken(candidateId: string, userId: string, tenantId: string): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insert(inviteTokensTable).values({ token, candidateId, userId, tenantId, expiresAt });

  return token;
}

/* ─── POST /api/invites/generate ─────────────────────────────────────────── */
// Recruiter-triggered: create a portal invite for a candidate
router.post("/invites/generate", validate({ body: GenerateInviteBody }), async (req, res) => {
  try {
    /* Hard auth: resolve the caller to a real user row — header presence is
     * not authentication. This endpoint now sends real invite emails and mints
     * portal accounts, so an unauthenticated / cross-tenant caller must not be
     * able to trigger it. */
    const callerId = getAuthUserId(req);
    if (!callerId) return res.status(401).json({ error: "Unauthorized" });
    const [caller] = await db
      .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.id, callerId))
      .limit(1);
    if (!caller) return res.status(401).json({ error: "Unauthorized" });

    const { candidateId } = req.body as { candidateId?: string };
    if (!candidateId) return res.status(400).json({ error: "candidateId required" });

    const [candidate] = await db
      .select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId, firstName: candidatesTable.firstName, lastName: candidatesTable.lastName, email: candidatesTable.email })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!candidate) return res.status(404).json({ error: "Candidate not found" });

    /* Tenant scoping: a caller may only invite candidates within their own
     * tenant subtree. Platform admins (allowed === null) bypass. Return 404 to
     * avoid leaking the existence of candidates in other tenants. */
    if (caller.role !== "platform_admin") {
      const allowed = await getDataScopeTenantIds(caller);
      if (allowed && !allowed.includes(candidate.tenantId ?? "")) {
        return res.status(404).json({ error: "Candidate not found" });
      }
    }

    /* Plain-recruiter ownership ceiling: a recruiter may only invite a candidate
       reachable via a requisition ASSIGNED to them. Tenant scope alone would let
       a recruiter invite any candidate in the tenant. 404 to avoid leaking. */
    if (!(await recruiterOwnsResource(caller, { kind: "candidateId", value: candidateId }))) {
      return res.status(404).json({ error: "Candidate not found" });
    }

    const userId = await ensureCandidateUser(candidateId, candidate.tenantId);
    if (!userId) return res.status(500).json({ error: "Failed to create portal account" });

    const token = await generateInviteToken(candidateId, userId, candidate.tenantId);

    logger.info({ candidateId, userId }, "Portal invite generated by recruiter");

    /* Send the magic-link invite email. The recruiter clicked "Invite to
     * Portal" expecting the candidate to actually receive an invitation, so
     * delivery is the primary action here — the returned link is just a
     * fallback the recruiter can copy. */
    const baseUrl = process.env.APP_BASE_URL ?? "https://app.lexy.ai";
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;
    const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();

    let emailSent = false;
    if (candidate.email) {
      const emailBody =
        `Hi ${candidate.firstName || "there"},\n\n` +
        `You've been invited to access your candidate portal on L3xy. ` +
        `Click the link below to set up your account and view your profile:\n\n` +
        `${inviteUrl}\n\n` +
        `This invitation expires in 7 days.\n\n` +
        `If you weren't expecting this email, you can safely ignore it.`;
      const result = await sendEmail({
        to: candidate.email,
        subject: "You're invited to your L3xy candidate portal",
        html: plainToHtml(emailBody),
        text: emailBody,
        audit: {
          tenantId: candidate.tenantId ?? null,
          actorLabel: "Recruiter",
          subjectType: "candidate",
          subjectId: candidate.id,
          subjectLabel: candidateName || candidate.email,
          metadata: { candidateId, kind: "portal_invite" },
        },
      });
      emailSent = result.ok;
      if (!result.ok) {
        logger.error({ candidateId, err: result.error }, "Portal invite email failed to send");
      }
    }

    res.json({
      token,
      candidateName,
      email: candidate.email,
      inviteUrl,
      emailSent,
      emailConfigured: isEmailConfigured(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate invite");
    res.status(500).json({ error: "Failed to generate invite" });
  }
});

/* ─── GET /api/invites/career-campaign-status ───────────────────────────── */
// Returns completion status for candidates: invited / interview_started / profile_complete
// NOTE: this static route MUST be registered before GET /invites/:token below —
// otherwise the param route greedily matches "/invites/career-campaign-status"
// (token = "career-campaign-status") and shadows this handler entirely.
router.get("/invites/career-campaign-status", async (req, res) => {
  try {
    /* Hard auth: header presence is not authentication. Resolve the caller and
     * scope the candidate set to their tenant subtree (platform_admin sees all).
     * candidates is RLS-protected so the query is already tenant-bound, but we
     * add an explicit filter for defense-in-depth and clear intent. */
    const callerId = getAuthUserId(req);
    if (!callerId) return res.status(401).json({ error: "Unauthorized" });
    const [caller] = await db
      .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.id, callerId))
      .limit(1);
    if (!caller) return res.status(401).json({ error: "Unauthorized" });

    // Get all candidates and join against invite tokens + career profiles
    const { candidateCareerProfilesTable } = await import("@workspace/db");
    const { or, inArray, and, desc: descOp } = await import("drizzle-orm");

    const allowedTenantIds = caller.role === "platform_admin"
      ? null
      : await getDataScopeTenantIds(caller);

    const candidatesRaw = await db
      .select({
        id: candidatesTable.id,
        firstName: candidatesTable.firstName,
        lastName: candidatesTable.lastName,
        email: candidatesTable.email,
        jobTitle: candidatesTable.jobTitle,
        company: candidatesTable.company,
      })
      .from(candidatesTable)
      .where(allowedTenantIds ? inArray(candidatesTable.tenantId, allowedTenantIds) : undefined)
      .limit(200);

    /* Plain-recruiter ownership ceiling: narrow the tenant-scoped set to only
       candidates reachable via a requisition ASSIGNED to the caller. */
    let candidates = candidatesRaw;
    if (caller.role === "recruiter") {
      const owned = await Promise.all(
        candidatesRaw.map((c) => recruiterOwnsResource(caller, { kind: "candidateId", value: c.id })),
      );
      candidates = candidatesRaw.filter((_, i) => owned[i]);
    }

    const tokens = await db
      .select()
      .from(inviteTokensTable)
      .orderBy(descOp(inviteTokensTable.createdAt));

    const { default: dbModule } = await import("@workspace/db");
    const profiles = await db
      .select({
        candidateId: candidateCareerProfilesTable.candidateId,
        baselineInterviewCompleted: candidateCareerProfilesTable.baselineInterviewCompleted,
        profileCompleteness: candidateCareerProfilesTable.profileCompleteness,
        updatedAt: candidateCareerProfilesTable.updatedAt,
      })
      .from(candidateCareerProfilesTable);

    const profileMap = new Map(profiles.map(p => [p.candidateId, p]));
    const tokenMap = new Map<string, typeof tokens[0]>();
    for (const t of tokens) {
      if (!tokenMap.has(t.candidateId)) tokenMap.set(t.candidateId, t);
    }

    const userIdMap = new Map<string, string>();
    // Tenant-scope the candidate-user lookup too: usersTable is NOT RLS-protected,
    // so an unscoped role='candidate' read would leak users across tenants and let
    // a same-email collision in another tenant flip status to portal_created.
    const users = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        allowedTenantIds
          ? and(eq(usersTable.role, "candidate"), inArray(usersTable.tenantId, allowedTenantIds))
          : eq(usersTable.role, "candidate"),
      );
    for (const u of users) userIdMap.set(u.email, u.id);

    const result = candidates.map(c => {
      const token = tokenMap.get(c.id);
      const profile = profileMap.get(c.id);
      const userId = userIdMap.get(c.email);

      let status: "not_invited" | "invited" | "portal_created" | "interview_completed" | "profile_complete";
      if (profile?.baselineInterviewCompleted) {
        status = "profile_complete";
      } else if (profile) {
        status = "interview_completed";
      } else if (token && token.usedAt) {
        status = "portal_created";
      } else if (token) {
        status = "invited";
      } else if (userId) {
        status = "portal_created";
      } else {
        status = "not_invited";
      }

      return {
        candidateId: c.id,
        name: `${c.firstName} ${c.lastName}`,
        email: c.email,
        jobTitle: c.jobTitle,
        company: c.company,
        status,
        invitedAt: token?.createdAt?.toISOString() ?? null,
        completedAt: profile?.updatedAt?.toISOString() ?? null,
        profileCompleteness: profile?.profileCompleteness ?? 0,
      };
    });

    res.json({ data: result });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch career campaign status");
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

/* ─── GET /api/invites/:token ────────────────────────────────────────────── */
// Validates a token — called by the accept-invite page before showing the UI
router.get("/invites/:token", async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(inviteTokensTable)
      .where(eq(inviteTokensTable.token, req.params.token))
      .limit(1);

    if (!row) return res.status(404).json({ valid: false, error: "Invite link not found" });
    if (row.usedAt) return res.status(410).json({ valid: false, error: "This invite link has already been used" });
    if (new Date() > row.expiresAt) return res.status(410).json({ valid: false, error: "This invite link has expired" });

    const [candidate] = await db
      .select({ firstName: candidatesTable.firstName, lastName: candidatesTable.lastName, email: candidatesTable.email })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, row.candidateId))
      .limit(1);

    res.json({
      valid: true,
      candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : "Candidate",
      email: candidate?.email,
      expiresAt: row.expiresAt.toISOString(),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to validate invite token");
    res.status(500).json({ valid: false, error: "Failed to validate invite" });
  }
});

/* ─── POST /api/invites/:token/accept ───────────────────────────────────── */
// Accepts a token — marks it used and returns the auth token for the portal session.
// Rate-limited per IP: this is a session-minting endpoint, so unbounded calls let
// an attacker probe / brute-force the token namespace. Tokens are UUIDv4 (122 bits)
// which is already astronomically hard, but defence-in-depth costs us nothing.
const inviteAcceptIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  scope: "invite-accept-ip",
});
router.post("/invites/:token/accept", inviteAcceptIpLimit, async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(inviteTokensTable)
      .where(eq(inviteTokensTable.token, req.params.token))
      .limit(1);

    if (!row) return res.status(404).json({ error: "Invite link not found" });
    if (row.usedAt) return res.status(410).json({ error: "This invite link has already been used" });
    if (new Date() > row.expiresAt) return res.status(410).json({ error: "This invite link has expired" });

    /* Atomic claim — gate the UPDATE on `used_at IS NULL` so that two
     * concurrent /accept calls on the same token can't both succeed (and
     * therefore can't both insert a "candidate accepted" notification).
     * If `marked.length === 0`, another request beat us to it. */
    const marked = await db
      .update(inviteTokensTable)
      .set({ usedAt: new Date() })
      .where(and(eq(inviteTokensTable.token, req.params.token), sql`${inviteTokensTable.usedAt} IS NULL`))
      .returning({ id: inviteTokensTable.token });
    if (marked.length === 0) {
      return res.status(410).json({ error: "This invite link has already been used" });
    }

    const userId = row.userId;
    if (!userId) return res.status(500).json({ error: "No user account linked to this invite" });

    const [user] = await db
      .select({ id: usersTable.id, tenantId: usersTable.tenantId, email: usersTable.email, name: usersTable.name, role: usersTable.role, avatarUrl: usersTable.avatarUrl, createdAt: usersTable.createdAt, lockedAt: usersTable.lockedAt })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) return res.status(404).json({ error: "User account not found" });

    /* Lockout-bypass guard (architect 2026-05-16): /invites/:token/accept
     * mints a session token below, so without this check a locked candidate
     * with a fresh invite link could bypass the admin-unlock model in
     * lib/account-lockout.ts. Refuse and require admin unlock first. The
     * invite token has already been marked used above — that's intentional
     * single-use behaviour; an attacker who has both a valid invite AND
     * knowledge that the account is locked cannot retry without a new
     * invite, and invites are recruiter-issued. */
    if (user.lockedAt) {
      logger.warn({ userId: user.id }, "[invites/accept] rejected: account is locked — admin unlock required");
      return res.status(423).json({
        error: "ACCOUNT_LOCKED",
        message:
          "This account is locked after too many failed sign-in attempts. Please contact your administrator to unlock it.",
      });
    }

    logger.info({ userId, candidateId: row.candidateId }, "Portal invite accepted");

    /* Notify the recruiter (the staff user who invited this candidate) that
     * the candidate accepted. We use the candidate's `createdById` as the
     * recruiter — that's set when the candidate is sourced or imported.
     * Wrapped in try/catch so a notification failure never breaks the
     * candidate's portal sign-in. */
    try {
      if (row.candidateId) {
        const { candidatesTable } = await import("@workspace/db");
        const { userNotificationsTable } = await import("@workspace/db");
        const [cand] = await db.select().from(candidatesTable)
          .where(eq(candidatesTable.id, row.candidateId)).limit(1);
        if (cand?.createdById && cand.createdById !== userId) {
          const candName = `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || cand.email || "Candidate";
          await db.insert(userNotificationsTable).values({
            tenantId: cand.tenantId ?? user.tenantId ?? "acme",
            userId: cand.createdById,
            type: "candidate_accepted_invite",
            title: "Candidate accepted interview invite",
            message: `${candName} accepted the interview invitation and signed in to the candidate portal.`,
            actionUrl: `/candidates/${cand.id}`,
          });
          const { recordAudit } = await import("../lib/audit.js");
          void recordAudit({
            tenantId: cand.tenantId ?? user.tenantId ?? "acme",
            actorType: "candidate",
            actorId: cand.id,
            actorLabel: candName,
            subjectType: "user",
            subjectId: cand.createdById,
            subjectLabel: candName,
            channel: "in_app",
            direction: "outbound",
            action: "notification.user.candidate_accepted_invite",
            title: "Candidate accepted interview invite",
            body: `${candName} accepted the interview invitation and signed in to the portal.`,
            metadata: { candidateId: cand.id },
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to create invite-accepted notification");
    }

    const acceptToken = issueToken({ userId: user.id, role: user.role, tenantId: user.tenantId, region: await getTenantRegion(user.tenantId) });
    setSessionTokenCookie(res, acceptToken);
    res.json({
      user: { id: user.id, tenantId: user.tenantId, email: user.email, name: user.name, role: user.role, avatarUrl: user.avatarUrl, createdAt: user.createdAt.toISOString() },
      ...devOnlyTokenBody(acceptToken),
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to accept invite token");
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

/* ─── POST /api/invites/bulk-career-invite ──────────────────────────────── */
// Bulk-generate portal invites for a list of candidates (career profile flow)
router.post("/invites/bulk-career-invite", validate({ body: BulkCareerInviteBody }), async (req, res) => {
  try {
    /* Hard auth: resolve the caller to a real user row — header presence is
     * not authentication. This mints portal accounts + invite tokens, so an
     * unauthenticated / cross-tenant caller must not be able to trigger it. */
    const callerId = getAuthUserId(req);
    if (!callerId) return res.status(401).json({ error: "Unauthorized" });
    const [caller] = await db
      .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.id, callerId))
      .limit(1);
    if (!caller) return res.status(401).json({ error: "Unauthorized" });

    /* Tenant scoping: a caller may only invite candidates within their own
     * tenant subtree. platform_admin (allowed === null) bypasses the filter. */
    const allowedTenantIds = caller.role === "platform_admin"
      ? null
      : await getDataScopeTenantIds(caller);

    const { candidateIds } = req.body as { candidateIds?: string[] };
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      return res.status(400).json({ error: "candidateIds array required" });
    }
    if (candidateIds.length > 200) {
      return res.status(400).json({ error: "Maximum 200 candidates per batch" });
    }

    const results: Array<{
      candidateId: string;
      name: string;
      email: string;
      token: string;
      inviteLink: string;
      expiresAt: string;
      status: "sent" | "error";
      error?: string;
    }> = [];

    const baseUrl = process.env.APP_BASE_URL ?? "https://app.lexy.ai";

    for (const candidateId of candidateIds) {
      try {
        const [candidate] = await db
          .select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId, firstName: candidatesTable.firstName, lastName: candidatesTable.lastName, email: candidatesTable.email })
          .from(candidatesTable)
          .where(eq(candidatesTable.id, candidateId))
          .limit(1);

        if (!candidate) {
          results.push({ candidateId, name: "", email: "", token: "", inviteLink: "", expiresAt: "", status: "error", error: "Candidate not found" });
          continue;
        }

        /* Cross-tenant guard: skip candidates outside the caller's subtree.
         * Report as "not found" to avoid leaking existence across tenants. */
        if (allowedTenantIds && !allowedTenantIds.includes(candidate.tenantId ?? "")) {
          results.push({ candidateId, name: "", email: "", token: "", inviteLink: "", expiresAt: "", status: "error", error: "Candidate not found" });
          continue;
        }

        /* Plain-recruiter ownership ceiling: skip candidates not reachable via a
           requisition ASSIGNED to the caller. Reported as "not found" too. */
        if (!(await recruiterOwnsResource(caller, { kind: "candidateId", value: candidateId }))) {
          results.push({ candidateId, name: "", email: "", token: "", inviteLink: "", expiresAt: "", status: "error", error: "Candidate not found" });
          continue;
        }

        const userId = await ensureCandidateUser(candidateId, candidate.tenantId);
        if (!userId) {
          results.push({ candidateId, name: `${candidate.firstName} ${candidate.lastName}`, email: candidate.email, token: "", inviteLink: "", expiresAt: "", status: "error", error: "Failed to create portal account" });
          continue;
        }

        const token = await generateInviteToken(candidateId, userId, candidate.tenantId);
        const inviteLink = `${baseUrl}/accept-invite?token=${token}&redirect=/portal/career/interview`;
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        results.push({
          candidateId,
          name: `${candidate.firstName} ${candidate.lastName}`,
          email: candidate.email,
          token,
          inviteLink,
          expiresAt,
          status: "sent",
        });
      } catch (err: any) {
        results.push({ candidateId, name: "", email: "", token: "", inviteLink: "", expiresAt: "", status: "error", error: err.message });
      }
    }

    const sent  = results.filter(r => r.status === "sent").length;
    const errors = results.filter(r => r.status === "error").length;

    logger.info({ sent, errors }, "Bulk career invite generated");

    res.json({ results, summary: { total: candidateIds.length, sent, errors } });
  } catch (err: any) {
    logger.error({ err }, "Failed to bulk generate career invites");
    res.status(500).json({ error: "Failed to generate invites" });
  }
});

export default router;
