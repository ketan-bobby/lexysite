/**
 * routes/disclosures.ts — Candidate-facing AI disclosures (T011)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The governance layer's seeded jurisdiction_disclosure_templates table was
 * useless until it had a route surface and an acknowledgement record. NYC LL144
 * § 5-301 requires pre-decision notice to candidates; CO SB24-205 and IL AIVI
 * have analogous requirements; the EU AI Act treats hiring as high-risk and
 * requires disclosure plus a record of it. This file is the API surface that
 * the candidate portal uses to:
 *
 *   1. GET /portal/disclosures/active — resolve the candidate's applicable
 *      jurisdictions (via classifyJurisdictions on candidate + job location)
 *      and return the active disclosure copy + policy versions in effect.
 *      A no-auth variant (?jobId=…) is supported for pre-application pages
 *      so a candidate can see the notice BEFORE creating a profile.
 *
 *   2. POST /portal/disclosures/ack — record an immutable acknowledgement
 *      with the exact template + policy version IDs the candidate saw, plus
 *      IP + UA for the auditor. Also writes a `disclosure_acknowledged`
 *      decision_event so the application-level audit trail is complete.
 *
 * ─── Role gating ─────────────────────────────────────────────────────────────
 * GET active is public — a prospective candidate can call it without logging
 * in (they pass the jobId or jurisdiction codes). POST ack requires a
 * resolved candidate session so we can attribute the ack to a real person.
 *
 * ─── Append-only ─────────────────────────────────────────────────────────────
 * candidate_disclosure_acks has BEFORE UPDATE/DELETE triggers. This route
 * therefore only ever INSERTs; it never tries to upsert or modify history.
 */
import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { controlDb, db } from "@workspace/db";
import {
  candidateDisclosureAcksTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../middlewares/validate.js";
import { getAuthUserId } from "../lib/auth-token.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { classifyJurisdictions } from "../lib/governance/jurisdictions.js";
import type { JurisdictionCode } from "../lib/governance/jurisdictions.js";
import {
  resolveActivePolicy,
  getActiveDisclosureTemplate,
} from "../lib/governance/policy-resolver.js";
import { recordDecisionEvent } from "../lib/governance/decision-events.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/* The disclosure surface flags we permit on POST. Constraining the set
 * makes the audit story crisper — every ack is attributable to one of
 * a small number of UI moments. */
const SURFACE_VALUES = [
  "portal_banner",
  "aedt_notice_page",
  "pre_interview",
  "application_start",
  "self_id_consent",
] as const;

/* Template keys we render to candidates. Disclosure rows in the
 * jurisdiction_disclosure_templates table are keyed by template_key;
 * the seeded default is `candidate_pre_decision`. */
const DEFAULT_TEMPLATE_KEY = "candidate_pre_decision";

/* ─── helpers ────────────────────────────────────────────────────────────── */

async function resolveCandidateForRequest(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  /* A candidate either has user.role='candidate' linked via candidates.userId,
   * or the request is from staff (recruiter previewing). Only the candidate
   * branch can POST an ack on their own behalf. */
  if (user.role !== "candidate") return null;
  const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.userId, user.id)).limit(1);
  if (!cand) return null;
  return { user, candidate: cand };
}

async function loadJob(jobId: string | undefined | null) {
  if (!jobId) return null;
  const [job] = await db
    .select({ id: jobsTable.id, location: jobsTable.location, tenantId: jobsTable.tenantId })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  return job ?? null;
}

/* Resolve the disclosure templates for a list of jurisdictions. Falls
 * back to logging a warning if none exists for a jurisdiction that's
 * supposed to require disclosure — legal needs to notice the gap.
 *
 * Returns templates keyed by jurisdiction code so the UI can render
 * them in a stable order. */
async function resolveTemplates(jurisdictions: JurisdictionCode[], requireDisclosure: boolean) {
  const out: Array<{
    jurisdictionCode: string;
    templateId: string;
    subject: string | null;
    bodyMarkdown: string;
  }> = [];
  for (const j of jurisdictions) {
    const tmpl = await getActiveDisclosureTemplate(j, DEFAULT_TEMPLATE_KEY, "en");
    if (tmpl) {
      out.push({
        jurisdictionCode: j,
        templateId: tmpl.id,
        subject: tmpl.subject ?? null,
        bodyMarkdown: tmpl.bodyMarkdown,
      });
    } else if (requireDisclosure) {
      logger.warn({ jurisdictionCode: j }, "[disclosures] no active disclosure template for jurisdiction that requires one");
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
 * GET /portal/disclosures/active
 *
 * Query params (all optional):
 *   - jurisdictions: comma-separated codes (skips classification)
 *   - candidateLocation: free-text (passed to classifyJurisdictions)
 *   - jobId: resolves job.location for classification
 *
 * Public — a candidate can hit this before signing up. Rate-limited
 * per-IP because it's unauthenticated and does a DB read.
 * ───────────────────────────────────────────────────────────────────────── */
router.get(
  "/portal/disclosures/active",
  rateLimit({ windowMs: 60_000, max: 30, keyFn: (r) => r.ip || "anon" }),
  async (req: any, res) => {
    const q = req.query as Record<string, string | undefined>;
    let jurisdictions: JurisdictionCode[];
    if (q.jurisdictions) {
      jurisdictions = q.jurisdictions
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as JurisdictionCode[];
    } else {
      const job = await loadJob(q.jobId);
      jurisdictions = classifyJurisdictions(q.candidateLocation ?? null, job?.location ?? null);
    }

    /* Resolve the active policy too so the UI can show "this disclosure
     * is required by NYC LL144 + EU AI Act" rather than just dumping
     * copy. Tenant id only known when jobId is supplied. */
    const job = await loadJob(q.jobId);
    const policy = await resolveActivePolicy(jurisdictions, job?.tenantId ?? null, new Date());
    const templates = await resolveTemplates(jurisdictions, policy.requireDisclosure);

    res.json({
      jurisdictions,
      requireDisclosure: policy.requireDisclosure,
      requireAppeal: policy.requireAppeal,
      requireAudit: policy.requireAudit,
      policyVersionIds: policy.policyVersionIds,
      contributingBasis: policy.contributingBasis,
      templates,
      /* The UI uses this to decide whether to even render the banner.
       * If false, no jurisdiction in scope requires disclosure and the
       * candidate sees nothing. */
      shouldDisplay: templates.length > 0 || policy.requireDisclosure,
    });
  },
);

/* ─────────────────────────────────────────────────────────────────────────
 * POST /portal/disclosures/ack
 *
 * Records that the authenticated candidate saw and acknowledged the
 * named disclosure templates + policy versions. Each surface (banner,
 * AEDT notice page, pre-interview) is its own ack row because the
 * regulator wants to see each moment of notice independently.
 *
 * Server-side idempotency (T011n hardening, Migration 0018):
 * A deterministic ack_key is computed from candidate_id + surface +
 * sorted template_ids + sorted policy_version_ids. The unique partial
 * index on (ack_key) means a double-click, multi-tab race, or
 * cross-device retry of the conceptually-same notice deduplicates at
 * the database. On conflict we look up the prior row and return its
 * id with deduplicated=true so the client sees the same outcome.
 * Different surfaces still produce distinct rows — they hash to
 * different keys.
 * ───────────────────────────────────────────────────────────────────────── */
const AckBody = z.object({
  jurisdictionCodes: z.array(z.string()).min(1).max(20),
  disclosureTemplateIds: z.array(z.string()).max(20).default([]),
  policyVersionIds: z.array(z.string()).max(20).default([]),
  surface: z.enum(SURFACE_VALUES),
  applicationId: z.string().optional(),
});

router.post(
  "/portal/disclosures/ack",
  rateLimit({ windowMs: 60_000, max: 30 }),
  validate({ body: AckBody }),
  async (req: any, res) => {
    const ctx = await resolveCandidateForRequest(req);
    if (!ctx) {
      res.status(401).json({ error: "Candidate authentication required" });
      return;
    }
    const { candidate } = ctx;

    /* If an applicationId is supplied, verify it actually belongs to
     * this candidate. Otherwise a candidate could ack arbitrary
     * applications for forensic-tampering purposes. */
    let applicationId: string | null = null;
    let tenantId = candidate.tenantId ?? "unknown";
    if (req.body.applicationId) {
      const [app] = await db
        .select()
        .from(applicationsTable)
        .where(
          and(
            eq(applicationsTable.id, req.body.applicationId),
            eq(applicationsTable.candidateId, candidate.id),
          ),
        )
        .limit(1);
      if (!app) {
        res.status(404).json({ error: "Application not found for this candidate" });
        return;
      }
      applicationId = app.id;
      tenantId = app.tenantId ?? tenantId;
    }

    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;

    /* Deterministic dedupe key — see file header. Sort the id arrays
     * so two equivalent payloads with different array order hash to
     * the same key. \x1f is the ASCII unit-separator; chosen because
     * it can't appear in any of the id formats we use. */
    const ackKey = crypto
      .createHash("sha256")
      .update([
        candidate.id,
        req.body.surface,
        [...req.body.disclosureTemplateIds].sort().join(","),
        [...req.body.policyVersionIds].sort().join(","),
      ].join("\x1f"))
      .digest("hex");

    const inserted = await db
      .insert(candidateDisclosureAcksTable)
      .values({
        tenantId,
        candidateId: candidate.id,
        applicationId,
        jurisdictionCodes: req.body.jurisdictionCodes,
        disclosureTemplateIds: req.body.disclosureTemplateIds,
        policyVersionIds: req.body.policyVersionIds,
        surface: req.body.surface,
        ackKey,
        ipAddress: ip,
        userAgent: ua,
      })
      .onConflictDoNothing({ target: candidateDisclosureAcksTable.ackKey })
      .returning({ id: candidateDisclosureAcksTable.id });

    let row = inserted[0] ?? null;
    let deduplicated = false;
    if (!row) {
      /* Conflict → an equivalent ack already exists. Return its id so
       * the client gets a stable reference. No decision_event is
       * written on this branch — it was already written when the
       * original ack landed. */
      const existing = await db
        .select({ id: candidateDisclosureAcksTable.id })
        .from(candidateDisclosureAcksTable)
        .where(eq(candidateDisclosureAcksTable.ackKey, ackKey))
        .limit(1);
      row = existing[0] ?? null;
      deduplicated = true;
      logger.info({ candidateId: candidate.id, surface: req.body.surface, ackId: row?.id }, "[disclosures] ack deduplicated by ack_key");
      res.status(200).json({ ok: true, ackId: row?.id ?? null, deduplicated: true });
      return;
    }

    /* Best-effort write of a decision_events row so the application-
     * level audit trail can be pulled with one query. Failure is
     * logged but does not poison the ack — the candidate already saw
     * the notice; the regulator can join on candidate_id either way. */
    try {
      await recordDecisionEvent({
        tenantId,
        applicationId,
        candidateId: candidate.id,
        jobId: null,
        eventType: "disclosure_shown",
        actorUserId: ctx.user.id,
        actorKind: "candidate",
        aiRecommendation: null,
        finalDecision: null,
        rationale: `Candidate acknowledged AI disclosure on surface=${req.body.surface}`,
        jurisdictions: req.body.jurisdictionCodes,
        disclosureVersionId: req.body.disclosureTemplateIds[0] ?? null,
        payload: {
          ackId: row?.id ?? null,
          surface: req.body.surface,
          allTemplateIds: req.body.disclosureTemplateIds,
          policyVersionIds: req.body.policyVersionIds,
        },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message, ackId: row?.id }, "[disclosures] decision_event write failed");
    }

    res.status(201).json({ ok: true, ackId: row?.id ?? null, deduplicated });
  },
);

export default router;
