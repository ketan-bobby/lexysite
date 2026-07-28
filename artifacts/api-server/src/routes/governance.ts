/**
 * routes/governance.ts — AI Governance Layer HTTP surface.
 *
 * Endpoints:
 *   POST /applications/:applicationId/human-decision  — record a
 *     human-attested final_decision (writes through applyHumanDecision).
 *   GET  /applications/pending-human-review            — recruiter queue
 *     of applications that have an AI recommendation awaiting human
 *     confirmation. Tenant-scoped.
 *   GET  /governance/jurisdiction-policies/active      — public read-
 *     only view of currently-active policy rules. Used by the UI and
 *     by tenant_admins evaluating procurement compliance.
 *   POST /appeals/:applicationId                       — STUB. Records
 *     an appeals_requests row and an `appeal_requested` decision event,
 *     returns 202. Full operational flow ships in T+1.
 *   GET  /appeals                                      — admin queue.
 *     Returns open appeals, tenant-scoped. Stub list view.
 *
 * Role gating
 * -----------
 * Per design: recruiter, hiring_manager, tenant_admin, platform_admin
 * may record final_decision. API tokens (no user) are explicitly
 * rejected — the law calls for a named natural-person reviewer.
 */
import { Router, type IRouter } from "express";
import { controlDb, db } from "@workspace/db";
import {
  applicationsTable,
  candidatesTable,
  jobsTable,
  jurisdictionAiPolicyRulesTable,
  appealsRequestsTable,
  decisionEventsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, lte, or, gt, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../middlewares/validate.js";
import { getAuthUserId } from "../lib/auth-token.js";
import { getAllowedTenantIds, getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils.js";
import { applyHumanDecision } from "../lib/governance/decision-enforcement.js";
import { restrictToCompliantCandidates } from "../lib/compliance-scope.js";
import { recordDecisionEvent } from "../lib/governance/decision-events.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { sendEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";

/* T011 — appeal SLA, configurable via env in case a jurisdiction
 * starts demanding a tighter clock. 10 business days ≈ 14 calendar
 * days is the conservative default per CO SB24-205 guidance. */
const APPEAL_SLA_DAYS = Number(process.env.APPEAL_SLA_DAYS ?? "14");
function computeSlaDueAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + APPEAL_SLA_DAYS * 24 * 60 * 60 * 1000);
}

/* Closed set of appeal outcomes. Mirrors the CHECK constraint added
 * by migration 0017 — if you add a value here, add it there too. */
const APPEAL_OUTCOMES = ["upheld", "reversed", "withdrawn", "duplicate", "out_of_scope"] as const;

const router: IRouter = Router();

/* The set of human roles permitted to attest a final_decision. API
 * tokens (no user resolved on the request) are blocked further down. */
const HUMAN_DECIDER_ROLES = new Set([
  "recruiter",
  "hiring_manager",
  "tenant_admin",
  "platform_admin",
]);

/* Roles permitted to VIEW the governance queues (pending-human-review, appeals).
 * This deliberately ADDS recruiter_admin — an agency lead triaging their
 * clients' queues — to the decision-maker set, WITHOUT granting decision or
 * appeal-resolve rights (those stay gated by HUMAN_DECIDER_ROLES). A plain
 * recruiter is allowed in but is narrowed to their assigned requisitions by
 * resolveQueueScope() below, so peers never see each other's items. */
const QUEUE_VIEW_ROLES = new Set([...HUMAN_DECIDER_ROLES, "recruiter_admin"]);

/* Resolve a queue viewer's visibility scope.
 *   { jobIds }   — a plain recruiter: only their assigned requisitions (empty
 *                  ⇒ they see nothing).
 *   { tenantIds }— everyone else, filtered by tenant. `null` ⇒ no restriction
 *                  (platform_admin). recruiter_admin is narrowed to their
 *                  assigned client sub-tenants; tenant_admin / hiring_manager
 *                  keep their full subtree. */
async function resolveQueueScope(
  user: { id: string; role: string; tenantId: string | null },
): Promise<{ jobIds: string[] } | { tenantIds: string[] | null }> {
  if (user.role === "recruiter") return { jobIds: await getRecruiterAssignedJobIds(user) };
  if (user.role === "recruiter_admin") return { tenantIds: await getDataScopeTenantIds(user) };
  return { tenantIds: await getAllowedTenantIds(user) };
}

/* Structured rationale dropdown the recruiter UI surfaces. Keeping
 * this enforced server-side improves litigation posture — every
 * adverse decision has a categorisable reason. Free-text is also
 * accepted via final_decision_reason. */
const REASON_CODES = [
  "insufficient_experience",
  "role_mismatch",
  "compensation_mismatch",
  "location_mismatch",
  "no_response",
  "duplicate_candidate",
  "failed_assessment",
  "withdrew",
  "stronger_candidate_selected",
  "other",
] as const;

const HumanDecisionBody = z.object({
  finalDecision: z.enum([
    "human_advance",
    "human_reject",
    "human_hold",
    "human_lapsed",
    "human_hired",
    "human_offer",
    "candidate_withdrawn",
  ]),
  attestation: z.string().min(8).max(1000),
  reasonCode: z.enum(REASON_CODES).optional(),
  reasonNotes: z.string().max(2000).optional(),
});

/* Resolve caller user + role + allowed tenant ids. Returns null on
 * unauthenticated or unresolvable user. Mirrors the helper pattern
 * used in routes/applications.ts to avoid drift. */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return user ?? null;
}

/* ─────────────────────────────────────────────────────────────────────────
 * POST /applications/:applicationId/human-decision
 * ───────────────────────────────────────────────────────────────────────── */
router.post(
  "/applications/:applicationId/human-decision",
  validate({ body: HumanDecisionBody }),
  async (req: any, res) => {
    const user = await getCallerUser(req);
    if (!user) {
      /* API tokens cannot attest — the law requires a named human. */
      res.status(401).json({ error: "Unauthorized (a named user must attest the decision)" });
      return;
    }
    if (!HUMAN_DECIDER_ROLES.has(user.role)) {
      res.status(403).json({ error: "Forbidden (role cannot record final decisions)" });
      return;
    }

    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, req.params.applicationId))
      .limit(1);
    if (!app) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    if (user.role !== "platform_admin") {
      const allowed = await getAllowedTenantIds(user);
      if (!allowed || !allowed.includes(app.tenantId ?? "")) {
        res.status(404).json({ error: "Application not found" });
        return;
      }
    }

    const { finalDecision, attestation, reasonCode, reasonNotes } = req.body as z.infer<typeof HumanDecisionBody>;
    const reason = [reasonCode, reasonNotes].filter(Boolean).join(" — ") || null;

    const result = await applyHumanDecision({
      applicationId: app.id,
      finalDecision,
      decidedByUserId: user.id,
      decidedByRole: user.role as any,
      attestation,
      reason,
      priorAiRecommendation: app.aiRecommendation ?? null,
    });

    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "human_decision_failed" });
      return;
    }
    res.json({
      ok: true,
      applicationId: result.applicationId,
      finalDecision,
      wasOverride: result.wasOverride,
    });
  },
);

/* ─────────────────────────────────────────────────────────────────────────
 * GET /applications/pending-human-review
 *   Lists applications with ai_recommendation set and final_decision
 *   still NULL. Tenant-scoped. Joins candidate + job for the UI.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/applications/pending-human-review", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!QUEUE_VIEW_ROLES.has(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const baseConds = [
    isNotNull(applicationsTable.aiRecommendation),
    isNull(applicationsTable.finalDecision),
    /* Compliance seal: an erased/DNC candidate must never be surfaced for a
     * hiring decision. Null/orphan-safe. Keeps this queue reconcilable with the
     * morning-report awaiting_decision count, which applies the same seal. */
    restrictToCompliantCandidates(applicationsTable.candidateId),
  ];
  /* Queue visibility: admins see the whole in-scope queue; a plain recruiter
   * is narrowed to their assigned requisitions so peers never see each other's
   * items. */
  const scope = await resolveQueueScope(user as any);
  if ("jobIds" in scope) {
    if (scope.jobIds.length === 0) { res.json([]); return; }
    baseConds.push(inArray(applicationsTable.jobId, scope.jobIds));
  } else if (scope.tenantIds !== null) {
    if (scope.tenantIds.length === 0) { res.json([]); return; }
    /* classb-scope [guard-invisible]: sole tenant seal for this Class-B (no-RLS) read;
       check-classb-read.mjs can't see conds-array pushes — do NOT remove without
       re-scoping (baseline-allowlisted). */
    baseConds.push(inArray(applicationsTable.tenantId, scope.tenantIds));
  }

  const rows = await db
    .select({
      application: applicationsTable,
      candidateFirstName: candidatesTable.firstName,
      candidateLastName: candidatesTable.lastName,
      candidateEmail: candidatesTable.email,
      candidateLocation: candidatesTable.location,
      jobTitle: jobsTable.title,
      jobLocation: jobsTable.location,
    })
    .from(applicationsTable)
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .leftJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
    .where(and(...baseConds))
    .orderBy(desc(applicationsTable.aiRecommendationAt))
    .limit(200);

  res.json(rows.map((r) => ({
    applicationId: r.application.id,
    tenantId: r.application.tenantId,
    aiRecommendation: r.application.aiRecommendation,
    aiRecommendationAt: r.application.aiRecommendationAt?.toISOString() ?? null,
    aiRecommendationModel: r.application.aiRecommendationModel,
    aiRecommendationScore: r.application.aiRecommendationScore,
    gatedByJurisdiction: r.application.gatedByJurisdiction ?? [],
    policyVersionId: r.application.policyVersionId,
    stage: r.application.stage,
    candidate: {
      firstName: r.candidateFirstName,
      lastName: r.candidateLastName,
      email: r.candidateEmail,
      location: r.candidateLocation,
    },
    job: {
      id: r.application.jobId,
      title: r.jobTitle,
      location: r.jobLocation,
    },
  })));
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /governance/jurisdiction-policies/active
 *   Read-only listing of currently-effective platform-floor + tenant-
 *   extension policies. Useful for the UI badge ("This action was
 *   gated by NYC LL144 + EU AI Act") and procurement reviews.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/governance/jurisdiction-policies/active", async (_req, res) => {
  const now = new Date();
  const rows = await db
    .select()
    .from(jurisdictionAiPolicyRulesTable)
    .where(
      and(
        lte(jurisdictionAiPolicyRulesTable.effectiveFrom, now),
        or(
          isNull(jurisdictionAiPolicyRulesTable.effectiveTo),
          gt(jurisdictionAiPolicyRulesTable.effectiveTo, now),
        ),
      ),
    )
    .orderBy(jurisdictionAiPolicyRulesTable.jurisdictionCode);

  res.json(rows.map((r) => ({
    id: r.id,
    jurisdictionCode: r.jurisdictionCode,
    jurisdictionLabel: r.jurisdictionLabel,
    scope: r.scope,
    tenantId: r.tenantId,
    gateRejects: r.gateRejects,
    gateLapsed: r.gateLapsed,
    gateHolds: r.gateHolds,
    requireDisclosure: r.requireDisclosure,
    requireAppeal: r.requireAppeal,
    requireAudit: r.requireAudit,
    basis: r.basis,
    effectiveFrom: r.effectiveFrom?.toISOString() ?? null,
  })));
});

/* ─────────────────────────────────────────────────────────────────────────
 * POST /appeals/:applicationId — STUB.
 *
 * Records an appeals_requests row and an `appeal_requested`
 * decision_event so the audit trail is complete from day one. Returns
 * HTTP 202 to make explicit that this is acknowledged-but-not-yet-
 * processed. Full operational flow (assignment, SLAs, candidate
 * communications, outcome propagation) ships in T+1 per
 * docs/RUNBOOK_APPEAL_HANDLING.md.
 *
 * Public endpoint by design — a rejected candidate may file without a
 * staff login. Auth is OPTIONAL; we capture requestedBy as 'candidate'
 * when no user is present.
 * ───────────────────────────────────────────────────────────────────────── */
const AppealBody = z.object({
  reason: z.string().min(8).max(4000),
  contactEmail: z.string().email().optional(),
});

router.post(
  "/appeals/:applicationId",
  rateLimit({ windowMs: 60_000, max: 5, keyFn: (r) => r.ip || "anon" }),
  validate({ body: AppealBody }),
  async (req: any, res) => {
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, req.params.applicationId))
      .limit(1);
    if (!app) { res.status(404).json({ error: "Application not found" }); return; }

    const user = await getCallerUser(req);
    const requestedBy = user?.id ?? "candidate";

    /* T011 — record the SLA target up front so the queue UI can sort
     * by it and so we have an unambiguous breach line for the auditor. */
    const slaDueAt = computeSlaDueAt();

    /* Fail-closed insert (T011n hardening): the previous version
     * swallowed insert errors and still emitted a decision_event +
     * receipt email, leaving the candidate believing an appeal was
     * filed when no row existed. If the row cannot be created we
     * surface a 500 so the candidate can retry and so monitoring sees
     * the failure. No best-effort fall-through. */
    const [row] = await db
      .insert(appealsRequestsTable)
      .values({
        tenantId: app.tenantId,
        applicationId: app.id,
        candidateId: app.candidateId,
        requestedBy,
        reason: req.body.reason,
        status: "received",
        slaDueAt,
      })
      .returning({ id: appealsRequestsTable.id });
    const appealId: string | null = row?.id ?? null;
    if (!appealId) {
      logger.error({ applicationId: app.id }, "[governance] appeal insert returned no row");
      res.status(500).json({ error: "APPEAL_INSERT_FAILED" });
      return;
    }

    /* Best-effort candidate confirmation email. Failure does NOT block
     * the 202 — the appeal IS recorded; we just won't have sent the
     * receipt. The appeal queue UI surfaces "candidate_notified_at IS
     * NULL" so the reviewer can re-issue if needed. */
    if (req.body.contactEmail) {
      try {
        const r = await sendEmail({
          to: req.body.contactEmail,
          subject: "We received your appeal",
          text:
            "Thank you for filing an appeal regarding the AI-assisted screening decision " +
            "on your application.\n\n" +
            "A human reviewer will examine the underlying record and respond within " +
            `${APPEAL_SLA_DAYS} calendar days. You will receive a follow-up email with the outcome.\n\n` +
            `Reference: appeal #${appealId}\n`,
          audit: {
            tenantId: app.tenantId,
            actorLabel: "Appeals — receipt",
            subjectType: "candidate",
            subjectId: app.candidateId,
            action: "appeal.received_notification",
            metadata: { appealId },
          },
        });
        if (r.ok) {
          await db
            .update(appealsRequestsTable)
            .set({ candidateNotifiedAt: new Date() })
            .where(eq(appealsRequestsTable.id, appealId));
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, appealId }, "[governance] appeal-receipt email failed");
      }
    }

    await recordDecisionEvent({
      tenantId: app.tenantId,
      applicationId: app.id,
      candidateId: app.candidateId,
      jobId: app.jobId,
      eventType: "appeal_requested",
      actorUserId: user?.id ?? null,
      actorKind: user ? (user.role as any) : "candidate",
      aiRecommendation: app.aiRecommendation ?? null,
      finalDecision: app.finalDecision ?? null,
      rationale: req.body.reason,
      policyVersionId: app.policyVersionId ?? null,
      jurisdictions: app.gatedByJurisdiction ?? [],
      payload: {
        appealId,
        contactEmail: req.body.contactEmail ?? null,
      },
    });

    res.status(202).json({
      ok: true,
      appealId,
      status: "received",
      slaDueAt: slaDueAt.toISOString(),
      message:
        "Appeal received. A human reviewer will examine the underlying record and respond within " +
        `${APPEAL_SLA_DAYS} calendar days. A confirmation has been sent to the contact email if provided.`,
    });
  },
);

/* GET /appeals — admin queue. Tenant-scoped. Returns SLA-enriched rows. */
router.get("/appeals", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!QUEUE_VIEW_ROLES.has(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  /* By default show only open appeals; ?include=all returns recently-
   * resolved ones too so admins can audit their queue. */
  const includeResolved = String(req.query?.include ?? "open") === "all";
  const statusFilter = includeResolved
    ? inArray(appealsRequestsTable.status, ["received", "in_review", "upheld", "reversed", "withdrawn"])
    : inArray(appealsRequestsTable.status, ["received", "in_review"]);
  const conds = [statusFilter];
  /* Queue visibility: admins see the whole in-scope queue; a plain recruiter
   * is narrowed to appeals on their assigned requisitions (resolved via the
   * appeal's application → job), so peers never see each other's items. */
  const scope = await resolveQueueScope(user as any);
  if ("jobIds" in scope) {
    if (scope.jobIds.length === 0) { res.json([]); return; }
    conds.push(inArray(
      appealsRequestsTable.applicationId,
      db.select({ id: applicationsTable.id })
        .from(applicationsTable)
        .where(inArray(applicationsTable.jobId, scope.jobIds)),
    ));
  } else if (scope.tenantIds !== null) {
    if (scope.tenantIds.length === 0) { res.json([]); return; }
    /* classb-scope [guard-invisible]: sole tenant seal for this Class-B (no-RLS) read;
       check-classb-read.mjs can't see conds-array pushes — do NOT remove without
       re-scoping (baseline-allowlisted). */
    conds.push(inArray(appealsRequestsTable.tenantId, scope.tenantIds));
  }
  const rows = await db
    .select()
    .from(appealsRequestsTable)
    .where(and(...conds))
    .orderBy(desc(appealsRequestsTable.createdAt))
    .limit(200);
  const now = Date.now();
  res.json(rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    slaDueAt: r.slaDueAt?.toISOString() ?? null,
    candidateNotifiedAt: r.candidateNotifiedAt?.toISOString() ?? null,
    /* Computed for the UI badge. `null` means a pre-T011 appeal with
     * no SLA recorded — surface explicitly. */
    slaStatus: r.slaDueAt
      ? (r.resolvedAt
        ? "resolved"
        : r.slaDueAt.getTime() < now
          ? "breached"
          : (r.slaDueAt.getTime() - now < 48 * 60 * 60 * 1000 ? "warning" : "on_track"))
      : "no_sla_recorded",
  })));
});

/* ─────────────────────────────────────────────────────────────────────────
 * POST /appeals/:appealId/resolve
 *   Reviewer (recruiter / hiring_manager / tenant_admin / platform_admin)
 *   closes an appeal. If outcome='reversed', also writes the
 *   final_decision through applyHumanDecision so the decision-events
 *   trail stays consistent. Reviewer attestation is mandatory and is
 *   enforced both here and at the DB CHECK level (migration 0017).
 * ───────────────────────────────────────────────────────────────────────── */
const ResolveBody = z.object({
  outcome: z.enum(APPEAL_OUTCOMES),
  attestation: z.string().min(8).max(2000),
  notes: z.string().max(4000).optional(),
  /* When outcome='reversed', the reviewer flips the final_decision on
   * the underlying application. We default to 'human_advance' but
   * accept any valid finalDecision so the reviewer can pick
   * 'human_hold' (re-route to interview) instead. */
  reverseToFinalDecision: z.enum([
    "human_advance", "human_hold", "human_hired", "human_offer",
  ]).optional(),
});

router.post(
  "/appeals/:appealId/resolve",
  validate({ body: ResolveBody }),
  async (req: any, res) => {
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!HUMAN_DECIDER_ROLES.has(user.role)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const [appeal] = await db
      .select()
      .from(appealsRequestsTable)
      .where(eq(appealsRequestsTable.id, req.params.appealId))
      .limit(1);
    if (!appeal) { res.status(404).json({ error: "Appeal not found" }); return; }

    if (user.role !== "platform_admin") {
      const allowed = await getAllowedTenantIds(user as any);
      if (!allowed || !allowed.includes(appeal.tenantId ?? "")) {
        res.status(404).json({ error: "Appeal not found" });
        return;
      }
    }
    if (appeal.resolvedAt) {
      res.status(409).json({ error: "Appeal already resolved", outcome: appeal.outcome });
      return;
    }

    const { outcome, attestation, notes } = req.body as z.infer<typeof ResolveBody>;
    const now = new Date();

    /* Map outcome to appeal.status. 'upheld' / 'reversed' /
     * 'withdrawn' are terminal statuses recognised by the CHECK
     * constraint; 'duplicate' / 'out_of_scope' close the appeal too
     * but we map them to 'withdrawn' for status filtering since the
     * constraint set is intentionally narrow. */
    const terminalStatus =
      outcome === "upheld" ? "upheld" :
      outcome === "reversed" ? "reversed" :
      "withdrawn";

    /* Atomic claim (T011n re-review fix): two reviewers can race the
     * resolve endpoint. The conditional UPDATE…WHERE resolved_at IS
     * NULL is serialised by the primary key — exactly one wins. We
     * MUST do this BEFORE any side effect (applyHumanDecision,
     * decision_event, candidate email) so the loser produces no
     * audit-visible artifacts. The prior ordering called
     * applyHumanDecision first, which would have let two concurrent
     * reversers both flip the application's final_decision and emit
     * duplicate decision_events before one lost the claim. Migration
     * 0018 also installs a BEFORE-UPDATE trigger that prevents post-
     * resolution column edits as a belt-and-braces guard. */
    const claimed = await db
      .update(appealsRequestsTable)
      .set({
        status: terminalStatus,
        outcome,
        outcomeNotes: notes ?? null,
        reviewerUserId: user.id,
        reviewerAttestation: attestation,
        resolvedAt: now,
      })
      .where(and(
        eq(appealsRequestsTable.id, appeal.id),
        isNull(appealsRequestsTable.resolvedAt),
      ))
      .returning({ id: appealsRequestsTable.id });

    if (claimed.length === 0) {
      logger.warn({ appealId: appeal.id, reviewerUserId: user.id }, "[governance] appeal resolve lost the atomic claim race — already resolved");
      res.status(409).json({ error: "ALREADY_RESOLVED" });
      return;
    }

    /* Winner of the claim. NOW it is safe to run side effects.
     *
     * On reversal, flip the final_decision via the governance service.
     * Compensation note: if applyHumanDecision fails the appeal row is
     * already marked resolved. We return 500 with a precise error code
     * and log loudly. We deliberately do NOT auto-revert resolved_at:
     * (a) the post-resolution trigger from migration 0018 blocks it
     *     by design, and
     * (b) auto-reverting would race with any other concurrent write
     *     and could silently re-open an appeal a reviewer believes is
     *     closed.
     * The on-call procedure for this residual is documented in
     * docs/RUNBOOK_PROD_MIGRATIONS.md. In practice applyHumanDecision
     * fails only when the underlying application is missing or has a
     * stale final_decision attestation, both of which the manual
     * repair path handles explicitly. */
    let reversedToFinalDecision: string | null = null;
    if (outcome === "reversed") {
      const target = req.body.reverseToFinalDecision ?? "human_advance";
      const result = await applyHumanDecision({
        applicationId: appeal.applicationId,
        finalDecision: target as any,
        decidedByUserId: user.id,
        decidedByRole: user.role as any,
        attestation:
          "I reviewed the AI recommendations and role-relevant candidate information before confirming this action " +
          `(appeal reversal — appeal #${appeal.id}: ${attestation}).`,
        reason: `appeal_reversed: ${notes ?? ""}`.trim(),
      });
      if (!result.ok) {
        logger.error({
          appealId: appeal.id,
          applicationId: appeal.applicationId,
          reviewerUserId: user.id,
          err: result.error,
        }, "[governance] CRITICAL: appeal marked resolved but reversal failed — manual repair required");
        res.status(500).json({
          error: "REVERSAL_FAILED_POST_CLAIM",
          message: result.error ?? "reversal_failed",
          appealId: appeal.id,
        });
        return;
      }
      reversedToFinalDecision = target;
    }

    /* Audit trail. The decision_event lives forever; the appeal row
     * may be queried by reviewers but the event is the regulator-
     * facing record. */
    await recordDecisionEvent({
      tenantId: appeal.tenantId,
      applicationId: appeal.applicationId,
      candidateId: appeal.candidateId,
      jobId: null,
      eventType: "appeal_completed",
      actorUserId: user.id,
      actorKind: user.role as any,
      aiRecommendation: null,
      finalDecision: null,
      rationale: notes ?? null,
      attestation,
      jurisdictions: [],
      payload: {
        appealId: appeal.id,
        outcome,
        reversedToFinalDecision,
        slaDueAt: appeal.slaDueAt?.toISOString() ?? null,
        breached: appeal.slaDueAt ? appeal.slaDueAt.getTime() < now.getTime() : null,
      },
    });

    /* Notify the candidate. Best-effort; failure is logged. We try to
     * use the candidate's email from the candidates table since the
     * original contact_email at appeal time may not have been kept. */
    try {
      if (appeal.candidateId) {
        const [cand] = await db
          .select({ email: candidatesTable.email, firstName: candidatesTable.firstName })
          .from(candidatesTable)
          .where(eq(candidatesTable.id, appeal.candidateId))
          .limit(1);
        if (cand?.email && !cand.email.endsWith("@deleted.invalid")) {
          const outcomeBlurb =
            outcome === "upheld"
              ? "After review, the original decision has been upheld."
              : outcome === "reversed"
                ? "After review, the original decision has been reversed and your application has been moved forward."
                : "Your appeal has been closed.";
          await sendEmail({
            to: cand.email,
            subject: "Update on your appeal",
            text:
              `Hello${cand.firstName ? ` ${cand.firstName}` : ""},\n\n` +
              `${outcomeBlurb}\n\n` +
              (notes ? `Additional notes from the reviewer:\n${notes}\n\n` : "") +
              `Reference: appeal #${appeal.id}\n`,
            audit: {
              tenantId: appeal.tenantId,
              actorLabel: "Appeals — outcome",
              subjectType: "candidate",
              subjectId: appeal.candidateId,
              action: "appeal.outcome_notification",
              metadata: { appealId: appeal.id, outcome },
            },
          });
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, appealId: appeal.id }, "[governance] appeal-outcome email failed");
    }

    res.json({
      ok: true,
      appealId: appeal.id,
      outcome,
      reversedToFinalDecision,
      resolvedAt: now.toISOString(),
    });
  },
);

/* ─────────────────────────────────────────────────────────────────────────
 * GET /governance/oversight-metrics — human-oversight effectiveness panel.
 *
 * EU AI Act Art. 14 requires that human oversight be EFFECTIVE, not a
 * rubber stamp. This endpoint aggregates the append-only decision_events
 * log over a window (default 90 days, cap 365) and reports:
 *   reviewed / overridden counts, deviationRate, appeal counts, and a
 *   rubberStampAlert flag when the sample is large enough (≥25 human
 *   decisions) but the deviation rate is suspiciously low (<2%) —
 *   i.e. humans are approving virtually everything the AI recommends.
 *
 * Visibility mirrors the appeals queue: QUEUE_VIEW_ROLES only, tenant-
 * scoped via resolveQueueScope (recruiters narrowed to assigned reqs are
 * given tenant-level aggregates of their own tenant scope — aggregates
 * contain no candidate-identifiable data).
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/governance/oversight-metrics", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!QUEUE_VIEW_ROLES.has(user.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  const days = Math.min(Math.max(Math.trunc(Number(req.query?.days ?? 90)) || 90, 7), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /* decision_events is Class-B (no RLS) — the explicit tenant predicate inside
   * the .where() below is the seal for this read. Platform admin (null scope)
   * sees all tenants. */
  const tenantIds = await getDataScopeTenantIds(user as any);
  if (tenantIds !== null && tenantIds.length === 0) {
    res.json({ days, since: since.toISOString(), reviewed: 0, overridden: 0, humanDecisions: 0, deviationRate: null, appealsRequested: 0, appealsCompleted: 0, rubberStampAlert: false });
    return;
  }

  const rows = await db
    .select({
      eventType: decisionEventsTable.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(decisionEventsTable)
    .where(and(
      gte(decisionEventsTable.createdAt, since),
      tenantIds !== null ? inArray(decisionEventsTable.tenantId, tenantIds) : undefined,
    ))
    .groupBy(decisionEventsTable.eventType);

  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.eventType] = Number(r.count);

  const reviewed = byType["decision_reviewed"] ?? 0;
  const overridden = byType["decision_overridden"] ?? 0;
  const humanDecisions = reviewed + overridden;
  const deviationRate = humanDecisions > 0 ? overridden / humanDecisions : null;

  /* Rubber-stamp heuristic: meaningful sample, near-zero disagreement. */
  const RUBBER_STAMP_MIN_SAMPLE = 25;
  const RUBBER_STAMP_MAX_RATE = 0.02;
  const rubberStampAlert =
    humanDecisions >= RUBBER_STAMP_MIN_SAMPLE &&
    deviationRate !== null &&
    deviationRate < RUBBER_STAMP_MAX_RATE;

  res.json({
    days,
    since: since.toISOString(),
    reviewed,
    overridden,
    humanDecisions,
    deviationRate,
    appealsRequested: byType["appeal_requested"] ?? 0,
    appealsCompleted: byType["appeal_completed"] ?? 0,
    rubberStampAlert,
    thresholds: { minSample: RUBBER_STAMP_MIN_SAMPLE, maxRate: RUBBER_STAMP_MAX_RATE },
  });
});

export default router;
