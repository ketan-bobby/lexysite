/**
 * routes/ai-messages.ts — AI message generation, review & unified queue (T006)
 *
 * Covers the eight NEW message types (follow_up, interview_invite, rejection,
 * nurture, hm_summary, submission_summary, talking_points, client_update) plus a
 * manual `outreach` draft. First-touch cold outreach still lives in
 * `outreach_messages`; GET /ai-messages/queue aggregates BOTH so recruiters have
 * ONE place to review/approve/reject.
 *
 * Governance:
 *   - Every row is tenant-scoped via getAllowedTenantIds (no cross-tenant reads).
 *   - The per-tenant kill switch is enforced before any generation.
 *   - Every action (generated/edited/approved/rejected/sent) is logged to
 *     ai_message_feedback AND the audit log.
 *   - Phase 1 = human approval only: generation NEVER auto-sends.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  aiMessageGenerationsTable,
  aiMessageFeedbackTable,
  approvedMessageExamplesTable,
  outreachMessagesTable,
  outreachStepMessagesTable,
  outreachEnrollmentsTable,
  candidatesTable,
  jobsTable,
} from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { z } from "zod";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { recordAudit } from "../lib/audit";
import { sendEmail } from "../lib/email";
import {
  generateAiMessage,
  MESSAGE_TYPE_SPECS,
  type AiMessageType,
} from "../lib/ai-message-generate";

const router: IRouter = Router();

const messageTypeValues = Object.keys(MESSAGE_TYPE_SPECS) as [AiMessageType, ...AiMessageType[]];
const toneValues = ["formal", "warm", "direct", "premium", "technical", "conversational"] as const;
// Candidate-facing types are the only ones that can be "sent" as an email.
const CANDIDATE_FACING: ReadonlySet<string> = new Set([
  "outreach",
  "follow_up",
  "interview_invite",
  "rejection",
  "nurture",
]);

/** Resolve the tenant scope once; null = platform_admin (all tenants). */
async function tenantScope(user: { role: string; tenantId: string | null }) {
  return getDataScopeTenantIds(user);
}

function scopedOk(allowed: string[] | null, tenantId: string): boolean {
  return allowed === null || allowed.includes(tenantId);
}

/** Load a generation the caller is allowed to see, else null. */
async function loadGeneration(
  user: { id: string; role: string; tenantId: string | null },
  id: string,
) {
  /* classb-scope [guard-invisible]: push the tenant predicate into the .where() so a
     foreign-tenant generation is never fetched, rather than fetch-by-id then drop
     post-read. The inArray(...tenantId, allowed) in the ternary below is the sole
     tenant seal and check-classb-read.mjs cannot see a ternary predicate — do NOT
     remove without re-scoping (baseline-allowlisted). platform-scoped callers
     (tenantScope → null) are unrestricted here. */
  const allowed = await tenantScope(user);
  const [row] = await db
    .select()
    .from(aiMessageGenerationsTable)
    .where(
      allowed === null
        ? eq(aiMessageGenerationsTable.id, id)
        : and(
            eq(aiMessageGenerationsTable.id, id),
            inArray(aiMessageGenerationsTable.tenantId, allowed.length ? allowed : ["__none__"]),
          ),
    )
    .limit(1);
  if (!row) return null;
  /* Plain-recruiter ownership ceiling: the generation must be tied to a
     requisition ASSIGNED to the caller, or to a candidate reachable via one.
     Non-recruiters are governed by the tenant scope above. Gating here covers
     every by-id route (GET/:id, PATCH, approve, reject, send, save-as-example). */
  if (user.role === "recruiter") {
    const okJob = row.jobId
      ? await recruiterOwnsResource(user, { kind: "jobId", value: row.jobId })
      : false;
    const okCand = !okJob && row.candidateId
      ? await recruiterOwnsResource(user, { kind: "candidateId", value: row.candidateId })
      : okJob;
    if (!(okJob || okCand)) return null;
  }
  return row;
}

async function logFeedback(input: {
  tenantId: string;
  generationId: string;
  action: "generated" | "edited" | "approved" | "rejected" | "sent";
  userId?: string | null;
  notes?: string | null;
}) {
  await db.insert(aiMessageFeedbackTable).values({
    tenantId: input.tenantId,
    generationId: input.generationId,
    action: input.action,
    userId: input.userId ?? null,
    notes: input.notes ?? null,
  });
}

// ── Generate ──────────────────────────────────────────────────────────────────
const GenerateBody = z.object({
  messageType: z.enum(messageTypeValues),
  tenantId: z.string().min(1).optional(),
  jobId: z.string().min(1).nullish(),
  candidateId: z.string().min(1).nullish(),
  tone: z.enum(toneValues).nullish(),
  extraInstructions: z.string().max(2000).nullish(),
});

router.post(
  "/ai-messages/generate",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  validate({ body: GenerateBody }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const body = req.body as z.infer<typeof GenerateBody>;

    // Resolve the owning tenant. Prefer the job's tenant when a job is given so
    // the context + scope can never be spoofed via the body.
    let tenantId = body.tenantId ?? user.tenantId ?? "";
    let language = "en";
    if (body.jobId) {
      const [job] = await db
        .select({ tenantId: jobsTable.tenantId, language: jobsTable.language })
        .from(jobsTable)
        .where(eq(jobsTable.id, body.jobId))
        .limit(1);
      if (!job) return res.status(404).json({ error: "Job not found" });
      tenantId = job.tenantId;
      language = job.language ?? "en";
    }
    if (!tenantId) return res.status(400).json({ error: "tenantId or jobId required" });

    const allowed = await tenantScope(user);
    if (!scopedOk(allowed, tenantId)) return res.status(403).json({ error: "Forbidden" });

    // A candidate may only be referenced if it belongs to the resolved tenant,
    // so a foreign candidateId can never be pulled into a generation.
    if (body.candidateId) {
      const [cand] = await db
        .select({ tenantId: candidatesTable.tenantId })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, body.candidateId))
        .limit(1);
      if (!cand) return res.status(404).json({ error: "Candidate not found" });
      if (cand.tenantId !== tenantId) return res.status(403).json({ error: "Forbidden" });
    }

    /* Plain-recruiter ownership ceiling: a recruiter may only generate against a
       requisition ASSIGNED to them (and a candidate reachable via one). Tenant
       scope alone would let a recruiter draft for a peer's req in the same tenant. */
    if (user.role === "recruiter") {
      if (body.jobId && !(await recruiterOwnsResource(user, { kind: "jobId", value: body.jobId }))) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (body.candidateId && !(await recruiterOwnsResource(user, { kind: "candidateId", value: body.candidateId }))) {
        return res.status(404).json({ error: "Candidate not found" });
      }
    }

    const draft = await generateAiMessage({
      tenantId,
      messageType: body.messageType,
      jobId: body.jobId ?? null,
      candidateId: body.candidateId ?? null,
      tone: body.tone ?? null,
      language,
      extraInstructions: body.extraInstructions ?? null,
    });

    if (draft.blocked) {
      return res
        .status(409)
        .json({ error: "AI messaging is disabled for this tenant", code: "ai_disabled" });
    }

    const [saved] = await db
      .insert(aiMessageGenerationsTable)
      .values({
        tenantId,
        jobId: body.jobId ?? null,
        candidateId: body.candidateId ?? null,
        messageType: body.messageType,
        tone: draft.tone as (typeof toneValues)[number] | null,
        subject: draft.subject,
        body: draft.body,
        status: "generated",
        sourceContext: draft.sourceContext,
        contextSummary: draft.contextSummary,
        model: draft.model,
        promptVersion: draft.promptVersion,
        createdById: user.id,
      })
      .returning();

    await logFeedback({
      tenantId,
      generationId: saved.id,
      action: "generated",
      userId: user.id,
    });
    await recordAudit({
      tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "ai_message.generated",
      title: `AI ${body.messageType} draft generated`,
      metadata: { generationId: saved.id, contextSummary: draft.contextSummary },
    });

    return res.json({ generation: saved });
  },
);

// ── Unified pending queue (outreach_messages + ai_message_generations) ─────────
router.get(
  "/ai-messages/queue",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const allowed = await tenantScope(user);

    /* Plain-recruiter ceiling: the review queue shows only messages tied to a
       requisition ASSIGNED to the caller. A recruiter with no reqs sees nothing. */
    let assignedJobIds: string[] | null = null;
    if (user.role === "recruiter") {
      assignedJobIds = await getRecruiterAssignedJobIds(user);
      if (assignedJobIds.length === 0) return res.json({ items: [] });
    }

    /* classb-scope [guard-invisible]: the three `inArray(...tenantId, allowed)` pushes
       below (generations, outreach, step-enrollments) are the sole tenant seals for
       these Class-B (no-RLS) reads; check-classb-read.mjs can't see conds-array pushes
       — do NOT remove without re-scoping (baseline-allowlisted). */
    const genConds: any[] = [inArray(aiMessageGenerationsTable.status, ["generated", "edited"])];
    if (allowed !== null) genConds.push(inArray(aiMessageGenerationsTable.tenantId, allowed));
    if (assignedJobIds) genConds.push(inArray(aiMessageGenerationsTable.jobId, assignedJobIds));
    const generations = await db
      .select()
      .from(aiMessageGenerationsTable)
      .where(and(...genConds))
      .orderBy(desc(aiMessageGenerationsTable.createdAt))
      .limit(200);

    const outreachConds: any[] = [eq(outreachMessagesTable.status, "pending_approval")];
    if (allowed !== null) outreachConds.push(inArray(outreachMessagesTable.tenantId, allowed));
    if (assignedJobIds) outreachConds.push(inArray(outreachMessagesTable.jobId, assignedJobIds));
    const outreach = await db
      .select()
      .from(outreachMessagesTable)
      .where(and(...outreachConds))
      .orderBy(desc(outreachMessagesTable.createdAt))
      .limit(200);

    // Campaign drip step-1 drafts awaiting approval. Step messages have no
    // tenantId of their own, so we join the parent enrollment to both scope by
    // tenant and surface the candidate/job for the queue card.
    const stepConds: any[] = [
      eq(outreachStepMessagesTable.status, "pending_approval"),
      eq(outreachStepMessagesTable.stepNumber, 1),
    ];
    if (allowed !== null) stepConds.push(inArray(outreachEnrollmentsTable.tenantId, allowed));
    if (assignedJobIds) stepConds.push(inArray(outreachEnrollmentsTable.jobId, assignedJobIds));
    const stepRows = await db
      .select({
        id: outreachStepMessagesTable.id,
        subject: outreachStepMessagesTable.subject,
        body: outreachStepMessagesTable.body,
        status: outreachStepMessagesTable.status,
        createdAt: outreachStepMessagesTable.createdAt,
        tenantId: outreachEnrollmentsTable.tenantId,
        jobId: outreachEnrollmentsTable.jobId,
        candidateId: outreachEnrollmentsTable.candidateId,
      })
      .from(outreachStepMessagesTable)
      .innerJoin(
        outreachEnrollmentsTable,
        eq(outreachStepMessagesTable.enrollmentId, outreachEnrollmentsTable.id),
      )
      .where(and(...stepConds))
      .orderBy(desc(outreachStepMessagesTable.createdAt))
      .limit(200);

    const items = [
      ...outreach.map((o) => ({
        source: "outreach_messages" as const,
        id: o.id,
        tenantId: o.tenantId,
        jobId: o.jobId,
        candidateId: o.candidateId,
        messageType: "outreach",
        subject: o.subject,
        body: o.body,
        status: o.status,
        contextSummary: null as string | null,
        createdAt: o.createdAt,
      })),
      ...stepRows.map((s) => ({
        source: "outreach_step_messages" as const,
        id: s.id,
        tenantId: s.tenantId,
        jobId: s.jobId,
        candidateId: s.candidateId,
        messageType: "outreach",
        subject: s.subject,
        body: s.body ?? "",
        status: s.status,
        contextSummary: "First message of an outreach campaign — approve to begin the sequence." as string | null,
        createdAt: s.createdAt,
      })),
      ...generations.map((g) => ({
        source: "ai_message_generations" as const,
        id: g.id,
        tenantId: g.tenantId,
        jobId: g.jobId,
        candidateId: g.candidateId,
        messageType: g.messageType,
        subject: g.subject,
        body: g.body,
        status: g.status,
        contextSummary: g.contextSummary,
        createdAt: g.createdAt,
      })),
    ].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

    return res.json({ items });
  },
);

// ── List generations (filterable) ─────────────────────────────────────────────
const ListQuery = z.object({
  status: z.enum(["generated", "edited", "approved", "rejected", "sent"]).optional(),
  messageType: z.enum(messageTypeValues).optional(),
  jobId: z.string().optional(),
  candidateId: z.string().optional(),
});

router.get(
  "/ai-messages",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  validate({ query: ListQuery }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const q = req.query as z.infer<typeof ListQuery>;
    const allowed = await tenantScope(user);

    const conds = [] as any[];
    /* classb-scope [guard-invisible]: this inArray(...tenantId, allowed) push is the
       sole tenant seal for this Class-B (no-RLS) read; check-classb-read.mjs can't see
       conds-array pushes — do NOT remove without re-scoping (baseline-allowlisted). */
    if (allowed !== null) conds.push(inArray(aiMessageGenerationsTable.tenantId, allowed));
    /* Plain-recruiter ceiling: only generations tied to an assigned req. */
    if (user.role === "recruiter") {
      const jobIds = await getRecruiterAssignedJobIds(user);
      if (jobIds.length === 0) return res.json({ generations: [] });
      conds.push(inArray(aiMessageGenerationsTable.jobId, jobIds));
    }
    if (q.status) conds.push(eq(aiMessageGenerationsTable.status, q.status));
    if (q.messageType) conds.push(eq(aiMessageGenerationsTable.messageType, q.messageType));
    if (q.jobId) conds.push(eq(aiMessageGenerationsTable.jobId, q.jobId));
    if (q.candidateId) conds.push(eq(aiMessageGenerationsTable.candidateId, q.candidateId));

    const rows = await db
      .select()
      .from(aiMessageGenerationsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(aiMessageGenerationsTable.createdAt))
      .limit(200);
    return res.json({ generations: rows });
  },
);

// ── Single generation (tenant-scoped; 404 if outside caller's tenants) ────────
router.get(
  "/ai-messages/:id",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ generation: row });
  },
);

// ── Edit ──────────────────────────────────────────────────────────────────────
const EditBody = z.object({
  subject: z.string().max(500).nullish(),
  body: z.string().min(1).max(20000).optional(),
  tone: z.enum(toneValues).nullish(),
});

router.patch(
  "/ai-messages/:id",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  validate({ body: EditBody }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status === "sent") {
      return res.status(409).json({ error: "Cannot edit a sent message" });
    }
    const body = req.body as z.infer<typeof EditBody>;
    const [updated] = await db
      .update(aiMessageGenerationsTable)
      .set({
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.tone !== undefined ? { tone: body.tone } : {}),
        status: "edited",
        updatedAt: new Date(),
      })
      .where(eq(aiMessageGenerationsTable.id, row.id))
      .returning();
    await logFeedback({ tenantId: row.tenantId, generationId: row.id, action: "edited", userId: user.id });
    return res.json({ generation: updated });
  },
);

// ── Approve (human sign-off; does NOT send) ───────────────────────────────────
router.post(
  "/ai-messages/:id/approve",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    // Only a draft awaiting review may be approved; never resurrect a sent/rejected row.
    const [updated] = await db
      .update(aiMessageGenerationsTable)
      .set({ status: "approved", approvedBy: user.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(aiMessageGenerationsTable.id, row.id),
        inArray(aiMessageGenerationsTable.status, ["generated", "edited"]),
      ))
      .returning();
    if (!updated) return res.status(409).json({ error: "Only a draft awaiting review can be approved" });
    await logFeedback({ tenantId: row.tenantId, generationId: row.id, action: "approved", userId: user.id });
    await recordAudit({
      tenantId: row.tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "ai_message.approved",
      title: `AI ${row.messageType} draft approved`,
      metadata: { generationId: row.id },
    });
    return res.json({ generation: updated });
  },
);

// ── Reject ────────────────────────────────────────────────────────────────────
const RejectBody = z.object({ reason: z.string().max(2000).optional() });

router.post(
  "/ai-messages/:id/reject",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  validate({ body: RejectBody }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const reason = (req.body as z.infer<typeof RejectBody>).reason ?? null;
    const [updated] = await db
      .update(aiMessageGenerationsTable)
      .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiMessageGenerationsTable.id, row.id))
      .returning();
    await logFeedback({ tenantId: row.tenantId, generationId: row.id, action: "rejected", userId: user.id, notes: reason });
    await recordAudit({
      tenantId: row.tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "ai_message.rejected",
      title: `AI ${row.messageType} draft rejected`,
      body: reason,
      metadata: { generationId: row.id },
    });
    return res.json({ generation: updated });
  },
);

// ── Send (candidate-facing types only; requires prior approval) ───────────────
router.post(
  "/ai-messages/:id/send",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!CANDIDATE_FACING.has(row.messageType)) {
      return res.status(400).json({ error: "This message type is an internal artifact and is not sent by email" });
    }
    if (row.status !== "approved") {
      return res.status(409).json({ error: "Message must be approved before sending" });
    }
    if (!row.candidateId) {
      return res.status(400).json({ error: "No candidate linked to this message" });
    }
    const [cand] = await db
      .select({ email: candidatesTable.email, doNotContact: candidatesTable.doNotContact })
      .from(candidatesTable)
      .where(and(eq(candidatesTable.id, row.candidateId), eq(candidatesTable.tenantId, row.tenantId)))
      .limit(1);
    if (!cand?.email) return res.status(400).json({ error: "Candidate has no email on file" });
    if (cand.doNotContact) return res.status(409).json({ error: "Candidate is on the do-not-contact list" });

    // Atomically claim the send: only one request can flip approved → sent.
    // Concurrent callers that lose the race get 0 rows and abort, preventing
    // a duplicate email dispatch.
    const claimed = await db
      .update(aiMessageGenerationsTable)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(aiMessageGenerationsTable.id, row.id), eq(aiMessageGenerationsTable.status, "approved")))
      .returning();
    if (!claimed.length) {
      return res.status(409).json({ error: "Message is no longer awaiting send" });
    }

    const result = await sendEmail({
      to: cand.email,
      subject: row.subject ?? "A message regarding your application",
      text: row.body,
    });
    if (!result.ok) {
      // Roll the claim back so the message can be retried.
      await db
        .update(aiMessageGenerationsTable)
        .set({ status: "approved", sentAt: null, updatedAt: new Date() })
        .where(eq(aiMessageGenerationsTable.id, row.id));
      return res.status(502).json({ error: result.error ?? "Email send failed" });
    }
    const updated = claimed[0];
    await logFeedback({ tenantId: row.tenantId, generationId: row.id, action: "sent", userId: user.id });
    await recordAudit({
      tenantId: row.tenantId,
      actorType: "user",
      actorId: user.id,
      subjectType: "candidate",
      subjectId: row.candidateId,
      channel: "email",
      direction: "outbound",
      action: "ai_message.sent",
      title: `AI ${row.messageType} sent`,
      metadata: { generationId: row.id },
    });
    return res.json({ generation: updated });
  },
);

// ── Save as example (few-shot learning) ───────────────────────────────────────
router.post(
  "/ai-messages/:id/save-as-example",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const row = await loadGeneration(user, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const [example] = await db
      .insert(approvedMessageExamplesTable)
      .values({
        tenantId: row.tenantId,
        messageType: row.messageType,
        tone: row.tone,
        subject: row.subject,
        body: row.body,
        sourceGenerationId: row.id,
        createdById: user.id,
      })
      .returning();
    await recordAudit({
      tenantId: row.tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "ai_message.saved_as_example",
      title: `AI ${row.messageType} saved as example`,
      metadata: { generationId: row.id, exampleId: example.id },
    });
    return res.json({ example });
  },
);

export default router;
