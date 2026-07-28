/**
 * routes/outreach.ts — Outreach Campaign Management & Candidate Inbox
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for recruiters to create and manage outreach campaigns, view the
 * candidate reply inbox, manually trigger campaign autopilot phases, and log
 * inbound replies for AI classification.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /outreach/campaigns                  List all campaigns (tenant-scoped)
 *   POST   /outreach/campaigns                  Create a new campaign + default steps
 *   GET    /outreach/campaigns/:id              Get campaign + enrollments + step msgs
 *   PUT    /outreach/campaigns/:id              Update campaign (name, status, config)
 *   DELETE /outreach/campaigns/:id              Archive a campaign
 *   POST   /outreach/campaigns/:id/enroll       Enroll a candidate in the sequence
 *   POST   /outreach/campaigns/:id/run          Run autopilot: generate + send
 *   POST   /outreach/campaigns/:id/generate     Phase 2 only: generate pending drafts
 *   POST   /outreach/campaigns/:id/send         Phase 3 only: send ready messages
 *   GET    /outreach/messages                   List outreach messages (any source)
 *   GET    /outreach/messages/:id               Get one message with enriched candidate
 *   POST   /outreach/messages/:id/log-reply     Log an inbound reply → AI classify
 *   POST   /outreach/messages/:id/send-followup Manually send a follow-up step
 *   GET    /outreach/inbox                      Recruiter inbox (unanswered replies)
 *   POST   /outreach/inbox/:id/reply            Send a recruiter reply to a candidate
 *   GET    /outreach/reply/:token               One-click reply URL (email button)
 *   GET    /outreach/nurture-pool               View nurture pool for a tenant
 *   POST   /outreach/nurture-pool               Add candidate to nurture pool
 *
 * ─── enrichMessage() ─────────────────────────────────────────────────────────
 * Joins an outreach_messages row with its candidate (candidates OR
 * sourced_candidates — whichever the message was sent to) and the associated
 * job. Also computes follow-up status (pending / due / sent) per step in the
 * followUpSchedule array so the UI can show a timeline without additional calls.
 *
 * ─── Reply classification ────────────────────────────────────────────────────
 * POST /messages/:id/log-reply calls classifyReply() (outreach-engine.ts) which
 * uses GPT-4o to decide: interested / not_interested / needs_more_info / dnc.
 * The result is applied atomically: DNC → doNotContact flag + rejection record;
 * interested → interview invite via sendInterviewInviteFromReply().
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import {
  outreachCampaignsTable, recruiterInboxTable, candidatesTable,
  outreachMessagesTable, jobsTable, applicationsTable, sourcedCandidatesTable,
  outreachEnrollmentsTable, outreachSequenceStepsTable, outreachStepMessagesTable,
  outreachRepliesTable, outreachAutopilotRunsTable, nurturePoolTable,
} from "@workspace/db";
import { eq, desc, and, inArray, isNotNull, isNull } from "drizzle-orm";
import { getAllowedTenantIds, getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { logger } from "../lib/logger";
import { assertJobApproved } from "../lib/job-approval-gate";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { resolveUser } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";

const CreateCampaignBody = z.object({
  jobId: z.string().min(1),
  name: z.string().min(1),
  targetPositiveReplies: z.number().optional().nullable(),
  enrollmentThresholdScore: z.number().optional().nullable(),
}).passthrough();

const SendAllMessagesBody = z.object({
  jobId: z.string().min(1),
});

const SendFollowupBody = z.object({
  dayOffset: z.number(),
});

const RejectMessageBody = z.object({
  reason: z.string().max(2000).optional(),
});

const EditMessageBody = z.object({
  subject: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20000).optional(),
}).refine((d) => d.subject !== undefined || d.body !== undefined, {
  message: "Provide a subject or body to update",
});

const MessageReplyBody = z.object({
  sentiment: z.enum(["positive", "negative", "do_not_contact"]),
});

const EnrollCampaignBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
});

const CampaignReplyBody = z.object({
  enrollmentId: z.string().min(1),
  messageId: z.string().optional(),
  body: z.string().min(1),
});

const InboxReplyBody = z.object({
  subject: z.string().optional(),
  body: z.string().min(1),
});
import { sendEmail } from "../lib/email";
import { dispatchOutreachMessage } from "../lib/outreach-dispatch";
import { realEmailOrEmpty } from "../lib/real-email";
import { generateFirstTouchDraft } from "../lib/outreach-generate";
import { buildMessageContext, renderContextBlock } from "../lib/ai-message-context";
import { recordAudit } from "../lib/audit";
import {
  enrollCandidate, ensureDefaultSteps, runAutopilot, classifyReply,
  generateMessages, sendScheduledMessages,
} from "../lib/outreach-engine";

const router: IRouter = Router();

function mapCampaign(c: any) {
  return { ...c, createdAt: c.createdAt.toISOString() };
}

async function enrichMessage(m: any) {
  // candidateId may be a real candidates.id OR a sourced_candidates.id
  let candidateInfo: any = null;
  const [directCand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, m.candidateId)).limit(1);
  if (directCand) {
    candidateInfo = {
      id: directCand.id,
      firstName: directCand.firstName,
      lastName: directCand.lastName,
      email: directCand.email,
      currentTitle: directCand.currentTitle,
      currentCompany: directCand.currentCompany,
      doNotContact: (directCand as any).doNotContact ?? false,
    };
  } else {
    // Fall back: look up sourced_candidates by id
    const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, m.candidateId)).limit(1);
    if (sc) {
      const raw = sc.rawData as any;
      // Also check the actual candidates table via normalizedCandidateId. The
      // real, deliverable email frequently lives on the canonical candidates
      // row (added at normalization/merge time) while the sourced rawData has
      // none or a placeholder — fall back to it, otherwise a linked candidate
      // with a valid email is wrongly reported as "no email on file" at dispatch.
      let doNotContact = false;
      let canonicalEmail = "";
      if (sc.normalizedCandidateId) {
        const [nc] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, sc.normalizedCandidateId)).limit(1);
        if (nc) {
          doNotContact = (nc as any).doNotContact ?? false;
          canonicalEmail = realEmailOrEmpty(nc.email);
        }
      }
      candidateInfo = {
        id: sc.id,
        normalizedCandidateId: sc.normalizedCandidateId,
        firstName: raw?.firstName || raw?.name?.split(" ")[0] || "Candidate",
        lastName: raw?.lastName || raw?.name?.split(" ").slice(1).join(" ") || "",
        email: realEmailOrEmpty(raw?.email) || realEmailOrEmpty(raw?.contactInfo?.email) || canonicalEmail,
        currentTitle: raw?.currentTitle || raw?.title || "",
        currentCompany: raw?.currentCompany || raw?.company || "",
        doNotContact,
      };
    }
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, m.jobId)).limit(1);

  const followUps: any[] = m.followUpSchedule || [];
  const dispatched: any[] = m.followUpsDispatched || [];
  const sentAt = m.sentAt ? new Date(m.sentAt) : null;
  const now = new Date();

  const followUpStatus = followUps.map((fu: any, idx: number) => {
    const disp = dispatched.find((d: any) => d.dayOffset === fu.dayOffset);
    if (disp) return { ...fu, idx, status: "sent", sentAt: disp.sentAt };
    if (!sentAt) return { ...fu, idx, status: "pending" };
    const dueAt = new Date(sentAt.getTime() + fu.dayOffset * 24 * 60 * 60 * 1000);
    const overdue = now >= dueAt;
    const daysUntil = Math.ceil((dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return { ...fu, idx, status: overdue ? "due" : "pending", dueAt: dueAt.toISOString(), daysUntil: Math.max(0, daysUntil) };
  });

  return {
    ...m,
    createdAt: m.createdAt?.toISOString?.() ?? m.createdAt,
    sentAt: m.sentAt?.toISOString?.() ?? null,
    openedAt: m.openedAt?.toISOString?.() ?? null,
    repliedAt: m.repliedAt?.toISOString?.() ?? null,
    followUpStatus,
    candidate: candidateInfo,
    job: job ? { id: job.id, title: job.title } : null,
  };
}

/* Resolve a candidate's generation context (name/title/company/skills) from
   either the real candidates row or the sourced_candidates fallback — the same
   dual lookup enrichMessage uses, but returning the shape generateFirstTouchDraft
   expects. Used to regenerate a draft after a rejection. */
async function resolveCandidateCtx(candidateId: string): Promise<
  { name: string; currentTitle?: string | null; currentCompany?: string | null; skills?: string[] | null } | null
> {
  const [direct] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (direct) {
    const name = `${direct.firstName ?? ""} ${direct.lastName ?? ""}`.trim() || "Candidate";
    return { name, currentTitle: direct.currentTitle, currentCompany: direct.currentCompany, skills: (direct as any).skills ?? null };
  }
  const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, candidateId)).limit(1);
  if (sc) {
    const raw = sc.rawData as any;
    const name = raw?.name || `${raw?.firstName ?? ""} ${raw?.lastName ?? ""}`.trim() || "Candidate";
    return {
      name,
      currentTitle: raw?.currentTitle || raw?.title || null,
      currentCompany: raw?.currentCompany || raw?.company || null,
      skills: raw?.skills ?? null,
    };
  }
  return null;
}

/* All outreach routes require an authenticated user. The previous version
   left several handlers unprotected — anyone with a campaign or message URL
   could read or mutate cross-tenant outreach data. Mounting resolveUser at
   the router level makes every handler below auth-checked by default.
   ─── IMPORTANT ──────────────────────────────────────────────────────────
   This router is mounted UNPREFIXED in routes/index.ts (`router.use(outreachRouter)`),
   so an unscoped `router.use(resolveUser)` would fire for EVERY `/api/*`
   request, swallowing requests destined for sibling routers mounted AFTER
   this one (e.g. `/api/staff-invites/:token`, `/api/invites/:token`).
   We therefore scope the middleware to the `/outreach` path so it only
   guards routes defined in this file.
   ─── Public sibling routes ─────────────────────────────────────────────
   `/outreach/reply/:token` and `/outreach/reply-msg/:token` live in the
   sibling `outreach-reply.ts` router (mounted after this one). They are
   the one-click "Yes/No/DNC" buttons in candidate emails and are
   authenticated by an HMAC-signed token in the URL, NOT a bearer.
   They share the `/outreach` prefix with this router, so without this
   skip the candidate's tokenless click would hit resolveUser first and
   get a JSON 401 instead of the confirm page. */
router.use("/outreach", (req, res, next) => {
  if (req.path.startsWith("/reply/") || req.path.startsWith("/reply-msg/")) {
    return next();
  }
  return resolveUser(req, res, next);
});

/* Helpers: respond 404 (never 403) on cross-tenant access to avoid leaking
   the existence of resources owned by other tenants. */
/* Data-scope tenant gate (TEN-03 + recruiter_admin ceiling). platform_admin sees
   everything; a recruiter_admin is narrowed to its ASSIGNED client sub-tenants
   (getDataScopeTenantIds), NOT the whole agency subtree; every other role gets
   its own tenant + the ENTIRE descendant subtree. A null/absent row tenantId is
   treated as accessible (legacy rows predating tenant scoping). Returns true when
   allowed. */
async function canAccessTenant(
  user: { role: string; tenantId: string | null },
  tenantId: string | null | undefined,
): Promise<boolean> {
  const allowed = await getDataScopeTenantIds(user);
  if (allowed === null) return true;       // platform_admin
  if (!tenantId) return true;              // legacy untenanted row
  return allowed.includes(tenantId);
}

/* Plain-recruiter ownership ceiling for an outreach row: its requisition must be
   ASSIGNED to the caller. Outreach message.candidateId is a sourced_candidates
   PK (NOT a normalized candidate id), so jobId is the reliable gate here. Returns
   true for every non-recruiter (already ceilinged by tenant scope upstream). */
async function recruiterOwnsOutreachJob(
  user: { id: string; role: string; tenantId: string | null },
  jobId: string | null | undefined,
): Promise<boolean> {
  if (user.role !== "recruiter") return true;
  if (!jobId) return false;
  return recruiterOwnsResource(user, { kind: "jobId", value: jobId });
}

async function assertCampaignOwnership(req: any, res: any, campaignId: string) {
  const user = req.resolvedUser!;
  const [c] = await db.select({ tenantId: outreachCampaignsTable.tenantId })
    .from(outreachCampaignsTable).where(eq(outreachCampaignsTable.id, campaignId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return false; }
  if (!(await canAccessTenant(user, c.tenantId))) {
    res.status(404).json({ error: "Not found" }); return false;
  }
  /* Plain-recruiter ceiling: campaign's requisition must be assigned to caller. */
  if (!(await recruiterOwnsResource(user, { kind: "campaignId", value: campaignId }))) {
    res.status(404).json({ error: "Not found" }); return false;
  }
  return true;
}
async function assertEnrollmentOwnership(req: any, res: any, enrollmentId: string) {
  const user = req.resolvedUser!;
  const [e] = await db.select({ campaignId: outreachEnrollmentsTable.campaignId, tenantId: outreachEnrollmentsTable.tenantId })
    .from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.id, enrollmentId)).limit(1);
  if (!e) { res.status(404).json({ error: "Not found" }); return false; }
  if (!(await canAccessTenant(user, (e as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return false;
  }
  /* Plain-recruiter ceiling: parent campaign's requisition must be assigned. */
  if (e.campaignId && !(await recruiterOwnsResource(user, { kind: "campaignId", value: e.campaignId }))) {
    res.status(404).json({ error: "Not found" }); return false;
  }
  return true;
}

// ── Campaigns ──────────────────────────────────────────────────────────────

router.get("/outreach/campaigns", async (req, res) => {
  const user = req.resolvedUser!;
  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL so a
     small tenant doesn't get a zero-row slice from a global top-1000 cap. */
  let scoped;
  if (user.role === "platform_admin") {
    scoped = await db.select().from(outreachCampaignsTable).orderBy(desc(outreachCampaignsTable.createdAt)).limit(MAX_PAGE_SIZE);
  } else {
    // Data scope: own tenant + descendants, but recruiter_admin → assigned clients only.
    const allowed = (await getDataScopeTenantIds(user)) ?? [];
    const conds: any[] = [inArray(outreachCampaignsTable.tenantId, allowed)];
    /* Plain-recruiter ceiling: only campaigns for an ASSIGNED requisition. */
    let recruiterEmpty = allowed.length === 0;
    if (user.role === "recruiter") {
      const jobIds = await getRecruiterAssignedJobIds(user);
      if (jobIds.length === 0) recruiterEmpty = true;
      else conds.push(inArray(outreachCampaignsTable.jobId, jobIds));
    }
    scoped = recruiterEmpty
      ? []
      : await db.select().from(outreachCampaignsTable)
          .where(and(...conds))
          .orderBy(desc(outreachCampaignsTable.createdAt))
          .limit(MAX_PAGE_SIZE);
  }
  res.json(scoped.map(mapCampaign));
});

router.post("/outreach/campaigns", validate({ body: CreateCampaignBody }), async (req, res) => {
  const user = req.resolvedUser;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!user.tenantId) { res.status(403).json({ error: "Forbidden: no tenant context" }); return; }
  const { jobId, name, targetPositiveReplies, enrollmentThresholdScore } = req.body;
  // A campaign targets a requisition — verify the caller owns it and it has
  // cleared approval before any outreach can be set up against it.
  if (jobId) {
    const [job] = await db.select({ tenantId: jobsTable.tenantId, status: jobsTable.status })
      .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!(await canAccessTenant(user, job.tenantId))) {
      res.status(404).json({ error: "Job not found" }); return;
    }
    if (!(await recruiterOwnsOutreachJob(user, jobId))) {
      res.status(404).json({ error: "Job not found" }); return;
    }
    if (!assertJobApproved(res, job.status)) return;
  }
  const [campaign] = await db.insert(outreachCampaignsTable).values({
    tenantId: user.tenantId,
    jobId, name, targetPositiveReplies, enrollmentThresholdScore,
    status: "draft",
    autopilotEnabled: false,
    enrolledCount: 0, repliedCount: 0, positiveRepliesCount: 0, sentCount: 0, openRate: 0, replyRate: 0,
  }).returning();
  res.status(201).json(mapCampaign(campaign));
});

router.get("/outreach/campaigns/:campaignId", async (req, res) => {
  const user = req.resolvedUser;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [c] = await db.select().from(outreachCampaignsTable).where(eq(outreachCampaignsTable.id, req.params.campaignId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return; }
  /* Cross-tenant access returns 404 (not 403) to prevent ID enumeration. */
  if (!(await canAccessTenant(user, c.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  /* Plain-recruiter ceiling: campaign's requisition must be assigned to caller. */
  if (!(await recruiterOwnsResource(user, { kind: "campaignId", value: req.params.campaignId }))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  res.json(mapCampaign(c));
});

// (Handled by enrollment engine routes below — see ENROLLMENT ENGINE section)

// ── Messages ───────────────────────────────────────────────────────────────

router.get("/outreach/messages", async (req, res) => {
  const user = req.resolvedUser!;
  const { jobId, status } = req.query as Record<string, string>;
  /* Push jobId/status into the SQL WHERE so a single job's messages can't fall
     outside a global "latest 200" window when tenant activity is high — the
     per-job Outreach tab and pipeline drafts rely on these always being found. */
  const conds = [];
  if (jobId) conds.push(eq(outreachMessagesTable.jobId, jobId));
  if (status) conds.push(eq(outreachMessagesTable.status, status));
  let msgs = await db.select().from(outreachMessagesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(outreachMessagesTable.createdAt))
    .limit(200);
  /* Tenant scope — keep only messages in the caller's subtree (own tenant +
     descendants) before any other filter. */
  if (user.role !== "platform_admin") {
    const allowed = (await getDataScopeTenantIds(user)) ?? [];
    msgs = msgs.filter(m => (m as any).tenantId && allowed.includes((m as any).tenantId));
  }
  /* Plain-recruiter ceiling: only messages for an ASSIGNED requisition. */
  if (user.role === "recruiter") {
    const jobIds = new Set(await getRecruiterAssignedJobIds(user));
    msgs = jobIds.size === 0 ? [] : msgs.filter(m => (m as any).jobId && jobIds.has((m as any).jobId));
  }

  // Deduplicate: one message per candidate per job (keep latest)
  const seen = new Set<string>();
  const deduped = msgs.filter(m => {
    const key = `${m.candidateId}:${m.jobId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const enriched = await Promise.all(deduped.map(enrichMessage));
  res.json(enriched);
});

router.get("/outreach/messages/:id", async (req, res) => {
  const user = req.resolvedUser;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  res.json(await enrichMessage(m));
});

// Send (dispatch) a single message
router.post("/outreach/messages/:id/send", async (req, res) => {
  const user = req.resolvedUser!;
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (m.status === "sent") { res.json(await enrichMessage(m)); return; }
  /* Approval gate: a first-touch email held for recruiter sign-off (or one the
     recruiter rejected) must NOT be sendable through the generic send path —
     it goes out only via the explicit approve endpoint below. */
  if (m.status === "pending_approval" || m.status === "rejected") {
    res.status(409).json({ error: "This message is awaiting recruiter approval. Use the approve action to send it." });
    return;
  }

  /* Contact-email guardrail (NON-overridable) + single canonical send path: a
     message only goes out through dispatchOutreachMessage — the ONE dispatcher
     that applies demo-domain suppression and refuses placeholder addresses. Refuse
     up front so the row is never flipped to "sent" for an unmessageable candidate,
     replacing the old direct status write that bypassed both. */
  const enriched = await enrichMessage(m);
  const email = realEmailOrEmpty(enriched.candidate?.email);
  if (!email) {
    res.status(422).json({
      error: "This candidate has no email address on file. Add or enrich an email first.",
      code: "NO_CONTACT_EMAIL",
      recoverable: true,
    });
    return;
  }
  const dispatch = await dispatchOutreachMessage(m.id, m.body, m.subject, email);
  if (!dispatch.ok) {
    res.status(502).json({ error: dispatch.error || "Send failed" });
    return;
  }

  logger.info({ messageId: m.id, candidateId: m.candidateId }, "Outreach message dispatched");
  void logCandidateEvent({
    candidateId: m.candidateId,
    jobId: (m as any).jobId ?? null,
    tenantId: (m as any).tenantId ?? "",
    eventType: "OUTREACH_SENT",
    actorType: "system",
    source: "lexy_app",
    metadata: { messageId: m.id, subject: m.subject },
  });
  const [fresh] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  res.json(await enrichMessage(fresh));
});

// ── Approval gate: approve / reject / edit a pending first-touch email ───────

/* Approve a message that is awaiting recruiter sign-off → dispatch it via the
   shared dispatcher (same send path the orchestrator uses for auto-send). */
router.post("/outreach/messages/:id/approve", async (req, res) => {
  const user = req.resolvedUser!;
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  // Idempotent: already on its way out → just return current state.
  if (m.status === "sent" || m.status === "queued") { res.json(await enrichMessage(m)); return; }
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: `Cannot approve a message in status "${m.status}".` }); return;
  }

  const enriched = await enrichMessage(m);
  const email = enriched.candidate?.email as string | undefined;

  // Atomic claim: only the request that actually claims the row gets to
  // dispatch. The `approvedAt IS NULL` predicate makes this exclusive — under
  // Postgres row locking a second concurrent approve waits for the first to
  // commit, then fails to match (approvedAt is now set) and dispatches nothing.
  const claimed = await db.update(outreachMessagesTable)
    .set({ approvedAt: new Date(), approvedBy: user.id })
    .where(and(
      eq(outreachMessagesTable.id, m.id),
      eq(outreachMessagesTable.status, "pending_approval"),
      isNull(outreachMessagesTable.approvedAt),
    ))
    .returning();
  if (claimed.length === 0) {
    // Lost the race to a concurrent approve/send — return current state idempotently.
    const [cur] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, m.id)).limit(1);
    res.json(await enrichMessage(cur)); return;
  }

  const dispatch = await dispatchOutreachMessage(m.id, m.body, m.subject, email);

  // Mirror the orchestrator's post-send bookkeeping: advance the sourced
  // candidate to shortlisted and flip drafted→sent so it isn't re-queued.
  if (dispatch.ok) {
    const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, m.candidateId)).limit(1);
    if (sc) {
      const raw = sc.rawData as any;
      if (sc.normalizedCandidateId && (m as any).jobId) {
        await changeCandidateStage({
          tenantId: (m as any).tenantId ?? sc.tenantId ?? "",
          candidateId: sc.normalizedCandidateId,
          jobId: (m as any).jobId,
          to: "shortlisted",
          actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
          source: "recruiter_action",
          sourcedId: sc.id,
          sourcedRawDataPatch: { jobId: (m as any).jobId, outreachSent: true, outreachDrafted: false, outreachMessageId: m.id },
          metadata: { action: "approve_outreach", messageId: m.id },
        });
      } else {
        // stage-write-exempt: sourced row has no canonical candidateId (or jobId) to key the STAGE_CHANGED event/audit rows
        await db.update(sourcedCandidatesTable)
          .set({ rawData: { ...raw, outreachSent: true, outreachDrafted: false, outreachMessageId: m.id, stage: "shortlisted" } })
          .where(eq(sourcedCandidatesTable.id, sc.id));
      }
    }
  }

  const [fresh] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, m.id)).limit(1);
  if (dispatch.ok) {
    void logCandidateEvent({
      candidateId: m.candidateId,
      jobId: (m as any).jobId ?? null,
      tenantId: (m as any).tenantId ?? "",
      eventType: "OUTREACH_SENT",
      actorType: actorTypeFromRole(user.role),
      actorId: user.id,
      source: "recruiter_action",
      metadata: { messageId: m.id, subject: m.subject, approvedBy: user.id },
    });
  }
  logger.info({ messageId: m.id, candidateId: m.candidateId, approvedBy: user.id, dispatched: dispatch.ok }, "Outreach message approved");
  res.json({ ...(await enrichMessage(fresh)), dispatched: dispatch.ok, dispatchError: dispatch.ok ? undefined : dispatch.error });
});

/* Reject a pending message → it will never be sent. */
router.post("/outreach/messages/:id/reject", validate({ body: RejectMessageBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { reason } = req.body as { reason?: string };
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (m.status === "sent") { res.status(409).json({ error: "Message already sent; cannot reject." }); return; }
  // The reject→regenerate flow is for first-touch drafts awaiting sign-off only.
  // Don't let it touch queued campaign steps or already-rejected rows.
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: `Cannot reject a message in status "${m.status}".` }); return;
  }

  // Atomic claim: only the request that actually flips pending_approval →
  // rejected proceeds to regenerate. Two concurrent rejects would otherwise both
  // pass the status check above and each regenerate (and, when the gate is open,
  // each auto-dispatch) a draft — sending duplicates.
  const rejectedRows = await db.update(outreachMessagesTable)
    .set({ status: "rejected", rejectedAt: new Date(), rejectedReason: reason ?? null })
    .where(and(
      eq(outreachMessagesTable.id, m.id),
      eq(outreachMessagesTable.status, "pending_approval"),
      // `approvedAt IS NULL` keeps approve and reject mutually exclusive: approve
      // claims by setting approvedAt (status stays pending_approval until dispatch),
      // so this predicate stops a concurrent reject from also claiming the same row.
      isNull(outreachMessagesTable.approvedAt),
    ))
    .returning();
  if (rejectedRows.length === 0) {
    // Lost the race to a concurrent reject/approve — return current state idempotently.
    const [cur] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, m.id)).limit(1);
    res.json({ ...(await enrichMessage(cur)), regenerated: null }); return;
  }
  const updated = rejectedRows[0];
  logger.info({ messageId: m.id, candidateId: m.candidateId, rejectedBy: user.id }, "Outreach message rejected");

  // Per product decision: rejecting captures the recruiter's reason and then
  // auto-regenerates a fresh first-touch draft that directly addresses that
  // feedback, held again for approval. The candidate is never silently dropped.
  // Regeneration failures are non-fatal — the reject itself still succeeds.
  let regenerated: any = null;
  try {
    const candidateCtx = await resolveCandidateCtx(m.candidateId);
    if (candidateCtx) {
      const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, m.jobId)).limit(1);
      // Same tenant brand + role context the orchestrator uses, so the
      // regenerated draft stays on-brand and on-role (real company name, not
      // the old "our company" stub).
      const ctx = await buildMessageContext({ tenantId: (m as any).tenantId ?? job?.tenantId ?? "", jobId: m.jobId });
      // Honor the tenant kill switch: when AI messaging is off we still record
      // the rejection but never invoke the model to regenerate.
      if (!ctx.aiMessagingEnabled) {
        res.json({ ...(await enrichMessage(updated)), regenerated: null });
        return;
      }
      const draft = await generateFirstTouchDraft({
        candidate: candidateCtx,
        job: {
          title: job?.title,
          location: job?.location,
          workType: job?.workType,
          company: ctx.companyName ?? "our company",
          language: job?.language ?? "en",
          description: job?.description,
        },
        contextBlock: renderContextBlock(ctx),
        // Brand voice (profile) and/or COMPANY docs only — not role docs — so a
        // tenant with no brand material gets the role-only persuasion fallback.
        hasBrandContext: !!ctx.brandBrief || ctx.sourceContext.tenantDocs > 0,
        feedback: reason,
        logCtx: { rejectedId: m.id, candidateId: m.candidateId },
      });
      // "Approve once per work order": if the recruiter has already approved
      // any outreach for this job, the regenerated draft follows the same
      // auto-send policy instead of waiting for another approval.
      const [priorApproved] = await db
        .select({ id: outreachMessagesTable.id })
        .from(outreachMessagesTable)
        .where(and(
          eq(outreachMessagesTable.jobId, m.jobId),
          isNotNull(outreachMessagesTable.approvedAt),
        ))
        .limit(1);
      const gateOpen = !!priorApproved;

      const [newMsg] = await db.insert(outreachMessagesTable).values({
        jobId: m.jobId,
        candidateId: m.candidateId,
        tenantId: (m as any).tenantId,
        subject: draft.subject,
        body: draft.body,
        status: gateOpen ? "queued" : "pending_approval",
        tone: draft.tone,
        callToAction: draft.callToAction,
        followUpSchedule: draft.followUpSchedule,
        estimatedOpenRate: draft.estimatedOpenRate?.toString(),
      }).returning();

      // When the gate is open, send the regenerated draft immediately via the
      // shared dispatcher (same path as orchestrator/approve). The candidate
      // email is resolved through enrichMessage (resolveCandidateCtx has no email).
      const enrichedNew = await enrichMessage(newMsg);
      const dispatch = gateOpen
        ? await dispatchOutreachMessage(newMsg.id, draft.body, draft.subject, enrichedNew.candidate?.email as string | undefined)
        : null;
      const sent = !!dispatch?.ok;

      // Repoint the sourced candidate at the fresh draft. If it was sent, mark
      // it sent + advance to shortlisted; otherwise keep it in "drafted" state
      // (held for approval) linked to the new pending row.
      const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, m.candidateId)).limit(1);
      if (sc) {
        const raw = sc.rawData as any;
        if (sent && sc.normalizedCandidateId && (m as any).jobId) {
          // Auto-sent on regeneration → advance to shortlisted through the choke-point.
          await changeCandidateStage({
            tenantId: (m as any).tenantId ?? sc.tenantId ?? "",
            candidateId: sc.normalizedCandidateId,
            jobId: (m as any).jobId,
            to: "shortlisted",
            actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
            source: "recruiter_action",
            sourcedId: sc.id,
            sourcedRawDataPatch: { jobId: (m as any).jobId, outreachDrafted: false, outreachSent: true, outreachMessageId: newMsg.id },
            metadata: { action: "regenerate_outreach", messageId: newMsg.id },
          });
        } else if (sent) {
          // stage-write-exempt: sourced row has no canonical candidateId (or jobId) to key the STAGE_CHANGED event/audit rows
          await db.update(sourcedCandidatesTable)
            .set({ rawData: { ...raw, outreachDrafted: false, outreachSent: true, outreachMessageId: newMsg.id, stage: "shortlisted" } })
            .where(eq(sourcedCandidatesTable.id, sc.id));
        } else {
          // Not sent — held for approval. No stage transition; only repoint at the fresh draft.
          await db.update(sourcedCandidatesTable)
            .set({ rawData: { ...raw, outreachDrafted: true, outreachSent: false, outreachMessageId: newMsg.id } })
            .where(eq(sourcedCandidatesTable.id, sc.id));
        }
      }

      const [freshNew] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, newMsg.id)).limit(1);
      regenerated = await enrichMessage(freshNew);
      logger.info({ rejectedId: m.id, newMessageId: newMsg.id, candidateId: m.candidateId, autoSent: sent }, "Regenerated outreach draft after rejection");
    } else {
      logger.warn({ rejectedId: m.id, candidateId: m.candidateId }, "Could not resolve candidate context — skipping regeneration after rejection");
    }
  } catch (err) {
    logger.error({ err, rejectedId: m.id, candidateId: m.candidateId }, "Failed to regenerate outreach draft after rejection");
  }

  res.json({ ...(await enrichMessage(updated)), regenerated });
});

// ── Campaign step-1 approval gate (first outreach of a drip sequence) ────────
/* The FIRST message of a campaign sequence never auto-sends: the engine inserts
   it as "pending_approval" and sendScheduledMessages skips it. Approving flips
   it to "scheduled" so the next autopilot tick dispatches it; follow-up steps
   (≥2) are unaffected and keep auto-sending. Step messages carry no tenantId of
   their own, so tenant isolation is enforced via the parent enrollment. */
router.post("/outreach/step-messages/:id/approve", async (req, res) => {
  const user = req.resolvedUser!;
  const [m] = await db.select().from(outreachStepMessagesTable).where(eq(outreachStepMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  const [enr] = await db.select().from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.id, m.enrollmentId)).limit(1);
  if (!enr) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, enr.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (enr.campaignId && !(await recruiterOwnsResource(user, { kind: "campaignId", value: enr.campaignId }))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  // Idempotent: already authorized or sent → return current state.
  if (m.status === "scheduled" || m.status === "sent") { res.json(m); return; }
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: `Cannot approve a message in status "${m.status}".` }); return;
  }
  // Atomic claim: only flip if still pending_approval (guards double-approve).
  const [updated] = await db.update(outreachStepMessagesTable)
    .set({ status: "scheduled", scheduledFor: new Date() })
    .where(and(eq(outreachStepMessagesTable.id, m.id), eq(outreachStepMessagesTable.status, "pending_approval")))
    .returning();
  if (!updated) { res.status(409).json({ error: "Message was already processed." }); return; }
  await recordAudit({
    tenantId: enr.tenantId,
    actorType: "user",
    actorId: user.id,
    channel: "system",
    direction: "internal",
    action: "outreach.step_message.approved",
    title: `Campaign step-${m.stepNumber} outreach approved`,
    metadata: { messageId: m.id, campaignId: m.campaignId, enrollmentId: m.enrollmentId, stepNumber: m.stepNumber },
  });
  logger.info({ messageId: m.id, enrollmentId: m.enrollmentId, approvedBy: user.id }, "Campaign step-1 message approved → scheduled");
  res.json({ ...updated, queuedForSend: true });
});

/* Reject a pending campaign step-1 draft → cancelled, never sent. */
router.post("/outreach/step-messages/:id/reject", validate({ body: RejectMessageBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { reason } = req.body as { reason?: string };
  const [m] = await db.select().from(outreachStepMessagesTable).where(eq(outreachStepMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  const [enr] = await db.select().from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.id, m.enrollmentId)).limit(1);
  if (!enr) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, enr.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (enr.campaignId && !(await recruiterOwnsResource(user, { kind: "campaignId", value: enr.campaignId }))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (m.status === "sent") { res.status(409).json({ error: "Message already sent; cannot reject." }); return; }
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: `Cannot reject a message in status "${m.status}".` }); return;
  }
  const [updated] = await db.update(outreachStepMessagesTable)
    .set({ status: "cancelled", failedReason: reason ?? "Rejected by recruiter" })
    .where(and(eq(outreachStepMessagesTable.id, m.id), eq(outreachStepMessagesTable.status, "pending_approval")))
    .returning();
  if (!updated) { res.status(409).json({ error: "Message was already processed." }); return; }
  // Terminate the enrollment so it doesn't become a zombie: the generator skips
  // any step that already has a message row, so a cancelled step-1 would
  // otherwise leave the candidate stuck at currentStep=0 forever. Rejecting the
  // first outreach means "don't contact this candidate in this campaign".
  await db.update(outreachEnrollmentsTable)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(outreachEnrollmentsTable.id, enr.id));
  await recordAudit({
    tenantId: enr.tenantId,
    actorType: "user",
    actorId: user.id,
    channel: "system",
    direction: "internal",
    action: "outreach.step_message.rejected",
    title: `Campaign step-${m.stepNumber} outreach rejected`,
    metadata: { messageId: m.id, campaignId: m.campaignId, enrollmentId: m.enrollmentId, stepNumber: m.stepNumber, reason: reason ?? null },
  });
  logger.info({ messageId: m.id, enrollmentId: m.enrollmentId, rejectedBy: user.id }, "Campaign step-1 message rejected → cancelled");
  res.json(updated);
});

/* Edit a pending campaign step-1 draft's subject/body before approval. Step
   messages carry no tenantId of their own, so isolation is enforced via the
   parent enrollment (same pattern as the approve/reject routes above). Only
   pending_approval drafts are editable so an already-scheduled/sent email can't
   be rewritten out from under the autopilot. */
router.patch("/outreach/step-messages/:id", validate({ body: EditMessageBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { subject, body } = req.body as { subject?: string; body?: string };
  const [m] = await db.select().from(outreachStepMessagesTable).where(eq(outreachStepMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  const [enr] = await db.select().from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.id, m.enrollmentId)).limit(1);
  if (!enr) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, enr.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (enr.campaignId && !(await recruiterOwnsResource(user, { kind: "campaignId", value: enr.campaignId }))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: "Only messages awaiting approval can be edited." }); return;
  }

  const patch: Record<string, any> = {};
  if (subject !== undefined) patch.subject = subject;
  if (body !== undefined) patch.body = body;

  const [updated] = await db.update(outreachStepMessagesTable)
    .set(patch)
    .where(and(eq(outreachStepMessagesTable.id, m.id), eq(outreachStepMessagesTable.status, "pending_approval")))
    .returning();
  if (!updated) { res.status(409).json({ error: "Message was already processed." }); return; }
  logger.info({ messageId: m.id, enrollmentId: m.enrollmentId, editedBy: user.id }, "Campaign step-1 message edited");
  res.json(updated);
});

/* Edit the subject/body of a message while it's awaiting approval. */
router.patch("/outreach/messages/:id", validate({ body: EditMessageBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { subject, body } = req.body as { subject?: string; body?: string };
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (m.status !== "pending_approval") {
    res.status(409).json({ error: "Only messages awaiting approval can be edited." }); return;
  }

  const patch: Record<string, any> = {};
  if (subject !== undefined) patch.subject = subject;
  if (body !== undefined) patch.body = body;

  // Re-check status inside the UPDATE predicate so a concurrent approve/send
  // can't be overwritten by a stale edit that passed the pre-check above.
  const [updated] = await db.update(outreachMessagesTable)
    .set(patch)
    .where(and(eq(outreachMessagesTable.id, m.id), eq(outreachMessagesTable.status, "pending_approval")))
    .returning();
  if (!updated) { res.status(409).json({ error: "Message was already processed." }); return; }
  logger.info({ messageId: m.id, candidateId: m.candidateId, editedBy: user.id }, "Outreach message edited");
  res.json(await enrichMessage(updated));
});

// Send all queued messages for a job
router.post("/outreach/messages/send-all", validate({ body: SendAllMessagesBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { jobId } = req.body;
  if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }
  /* Confirm the job belongs to the caller's tenant before bulk-dispatching. */
  const [job] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, job.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }

  const queued = await db.select().from(outreachMessagesTable)
    .where(and(eq(outreachMessagesTable.jobId, jobId), eq(outreachMessagesTable.status, "queued")));

  if (queued.length === 0) {
    res.json({ dispatched: 0, message: "No queued messages to send" });
    return;
  }

  /* Send each queued message through the ONE canonical dispatcher so demo-domain
     suppression and the placeholder-email refusal apply to the bulk path too — a
     direct status flip here would let unmessageable rows be marked "sent". */
  let dispatched = 0;
  let skipped = 0;
  for (const m of queued) {
    const enriched = await enrichMessage(m);
    const email = realEmailOrEmpty(enriched.candidate?.email);
    if (!email) { skipped++; continue; }
    const r = await dispatchOutreachMessage(m.id, m.body, m.subject, email);
    if (r.ok) dispatched++; else skipped++;
  }

  logger.info({ jobId, dispatched, skipped }, "Bulk outreach dispatched");
  res.json({
    dispatched,
    skipped,
    message: skipped > 0
      ? `Dispatched ${dispatched} message${dispatched === 1 ? "" : "s"}; skipped ${skipped} with no email on file`
      : `Dispatched ${dispatched} outreach messages`,
  });
});

// Send a follow-up for a message
router.post("/outreach/messages/:id/send-followup", validate({ body: SendFollowupBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { dayOffset } = req.body;
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }

  const dispatched: any[] = (m.followUpsDispatched as any[]) || [];
  if (dispatched.find((d: any) => d.dayOffset === dayOffset)) {
    res.json({ success: false, message: "Follow-up already sent" });
    return;
  }

  dispatched.push({ dayOffset, sentAt: new Date().toISOString() });
  const [updated] = await db.update(outreachMessagesTable)
    .set({ followUpsDispatched: dispatched })
    .where(eq(outreachMessagesTable.id, req.params.id))
    .returning();

  logger.info({ messageId: m.id, candidateId: m.candidateId, dayOffset }, "Follow-up dispatched");
  res.json(await enrichMessage(updated));
});

// Record a reply (positive / negative / do_not_contact)
router.post("/outreach/messages/:id/reply", validate({ body: MessageReplyBody }), async (req, res) => {
  const { sentiment } = req.body; // "positive" | "negative" | "do_not_contact"
  if (!["positive", "negative", "do_not_contact"].includes(sentiment)) {
    res.status(400).json({ error: "sentiment must be positive, negative, or do_not_contact" });
    return;
  }

  const user = req.resolvedUser!;
  const [m] = await db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.id, req.params.id)).limit(1);
  if (!m) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, (m as any).tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, (m as any).jobId))) {
    res.status(404).json({ error: "Not found" }); return;
  }

  const [updated] = await db.update(outreachMessagesTable)
    .set({ status: "replied", repliedAt: new Date(), replySentiment: sentiment })
    .where(eq(outreachMessagesTable.id, req.params.id))
    .returning();

  void logCandidateEvent({
    candidateId: m.candidateId,
    jobId: (m as any).jobId ?? null,
    tenantId: (m as any).tenantId ?? "",
    eventType: "OUTREACH_REPLIED",
    actorType: "candidate",
    source: "email",
    metadata: { messageId: m.id, sentiment },
  });

  // Resolve real candidateId — the outreach message may store sourced_candidates.id
  let realCandidateId = m.candidateId;
  const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, m.candidateId)).limit(1);
  if (sc) {
    // It's a sourced candidate — update rawData stage and resolve normalizedCandidateId.
    // The /reply route is authenticated-recruiter-only (req.resolvedUser), so the
    // recruiter operating it is the actor for the reply-driven stage move.
    const stageMap: Record<string, string> = { positive: "interview", negative: "rejected", do_not_contact: "rejected" };
    const raw = sc.rawData as any;
    if (sc.normalizedCandidateId && (m as any).jobId) {
      await changeCandidateStage({
        tenantId: (m as any).tenantId ?? sc.tenantId ?? "",
        candidateId: sc.normalizedCandidateId,
        jobId: (m as any).jobId,
        to: stageMap[sentiment],
        actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
        source: "recruiter_action",
        sourcedId: sc.id,
        sourcedRawDataPatch: { jobId: (m as any).jobId, replyStatus: sentiment },
        metadata: { action: "record_reply", sentiment, messageId: m.id },
      });
    } else {
      // stage-write-exempt: sourced row has no canonical candidateId (or jobId) to key the STAGE_CHANGED event/audit rows
      await db.update(sourcedCandidatesTable)
        .set({ rawData: { ...raw, stage: stageMap[sentiment], replyStatus: sentiment } })
        .where(eq(sourcedCandidatesTable.id, sc.id));
    }
    if (sc.normalizedCandidateId) realCandidateId = sc.normalizedCandidateId;
  }

  if (sentiment === "do_not_contact") {
    const now = new Date();
    const userId = (req as any).user?.id ?? null;
    // Mark the candidate as DNC with full audit trail
    await db.update(candidatesTable)
      .set({ doNotContact: true, dncAt: now, dncReason: "reply_sentiment", dncSetBy: userId, updatedAt: now } as any)
      .where(eq(candidatesTable.id, realCandidateId));

    // Stop all active nurture pool entries
    await db.update(nurturePoolTable)
      .set({ status: "stopped" })
      .where(and(eq(nurturePoolTable.candidateId, realCandidateId), eq(nurturePoolTable.status, "active")));

    const apps = await db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, realCandidateId));
    for (const app of apps) {
      /* Governance gate (T010 / migration 0016): a DNC-classified
       * reply is an AI-classified adverse outcome. We route it through
       * evaluateAndApplyAi so the platform records ai_recommendation
       * = 'reject' and the audit event but DOES NOT write
       * final_decision (DB CHECK enforces this anyway). In gated
       * jurisdictions, the recruiter sees the candidate in
       * /portal/pending-human-review and must attest before
       * applications.final_decision is set. In non-gated cases the
       * legacy stage write is preserved so existing dashboards keep
       * working. */
      try {
        const { evaluateAndApplyAi } = await import("../lib/governance/decision-enforcement.js");
        const result = await evaluateAndApplyAi({
          applicationId: app.id,
          intendedAction: "reject",
          aiRecommendation: "reject",
          modelId: "reply_classifier",
          modelVersion: "outreach.reply_sentiment.v1",
          rationale: "Candidate opted out via reply (do_not_contact sentiment).",
        });
        if (result.blockLegacyStageWrite) {
          /* Gated jurisdiction → leave applications.stage as-is. Note
           * lives in the audit event payload; recruiter UI will read
           * ai_recommendation. */
          continue;
        }
      } catch (err) {
        logger.warn({ err }, "[governance] evaluateAndApplyAi failed (proceeding with legacy reject)");
      }
      if (app.candidateId && app.jobId) {
        await changeCandidateStage({
          tenantId: app.tenantId ?? (m as any).tenantId ?? "",
          candidateId: app.candidateId,
          jobId: app.jobId,
          to: "rejected",
          actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
          source: "recruiter_action",
          reason: "Do Not Contact – candidate opted out",
          applicationId: app.id,
          applicationPatch: { notes: "Do Not Contact – candidate opted out" },
          metadata: { action: "record_reply", sentiment },
        });
      } else {
        // stage-write-exempt: application missing candidateId/jobId cannot key STAGE_CHANGED
        await db.update(applicationsTable)
          .set({ stage: "rejected" as any, notes: "Do Not Contact – candidate opted out", updatedAt: now })
          .where(eq(applicationsTable.id, app.id));
      }
    }
    logger.info({ candidateId: realCandidateId }, "Candidate flagged as Do Not Contact");

  } else if (sentiment === "negative") {
    const apps = await db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, realCandidateId));
    for (const app of apps) {
      /* Governance gate (T010 / migration 0016): negative-sentiment
       * auto-reject is AI-classified. Same pattern as the DNC branch
       * above — route through enforcement; in gated jurisdictions the
       * recruiter must attest before applications.final_decision is
       * written, and applications.stage stays in its prior column. */
      try {
        const { evaluateAndApplyAi } = await import("../lib/governance/decision-enforcement.js");
        const result = await evaluateAndApplyAi({
          applicationId: app.id,
          intendedAction: "reject",
          aiRecommendation: "reject",
          modelId: "reply_classifier",
          modelVersion: "outreach.reply_sentiment.v1",
          rationale: "Candidate declined via reply (negative sentiment).",
        });
        if (result.blockLegacyStageWrite) continue;
      } catch (err) {
        logger.warn({ err }, "[governance] evaluateAndApplyAi failed (proceeding with legacy reject)");
      }
      if (app.candidateId && app.jobId) {
        await changeCandidateStage({
          tenantId: app.tenantId ?? (m as any).tenantId ?? "",
          candidateId: app.candidateId,
          jobId: app.jobId,
          to: "rejected",
          actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
          source: "recruiter_action",
          reason: "Candidate declined – not interested",
          applicationId: app.id,
          applicationPatch: { notes: "Candidate declined – not interested" },
          metadata: { action: "record_reply", sentiment },
        });
      } else {
        // stage-write-exempt: application missing candidateId/jobId cannot key STAGE_CHANGED
        await db.update(applicationsTable)
          .set({ stage: "rejected" as any, notes: "Candidate declined – not interested", updatedAt: new Date() })
          .where(eq(applicationsTable.id, app.id));
      }
    }
    logger.info({ candidateId: realCandidateId }, "Candidate marked as declined");

  } else if (sentiment === "positive") {
    const apps = await db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, realCandidateId));
    for (const app of apps) {
      if (app.candidateId && app.jobId) {
        await changeCandidateStage({
          tenantId: app.tenantId ?? (m as any).tenantId ?? "",
          candidateId: app.candidateId,
          jobId: app.jobId,
          to: "interview",
          actor: { type: "user", role: (user as any)?.role ?? null, id: user.id },
          source: "recruiter_action",
          reason: "Candidate replied positively to outreach",
          applicationId: app.id,
          applicationPatch: { notes: "Candidate replied positively to outreach" },
          metadata: { action: "record_reply", sentiment },
        });
      } else {
        // stage-write-exempt: application missing candidateId/jobId cannot key STAGE_CHANGED
        await db.update(applicationsTable)
          .set({ stage: "interview" as any, notes: "Candidate replied positively to outreach", updatedAt: new Date() })
          .where(eq(applicationsTable.id, app.id));
      }
    }
    logger.info({ candidateId: realCandidateId }, "Candidate replied positively – advanced to interview");
  }

  res.json(await enrichMessage(updated));
});

// ═══════════════════════════════════════════════════════════════════════════
// ── ENROLLMENT ENGINE (multi-step drip) ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Get campaign sequence steps (seed defaults if none)
router.get("/outreach/campaigns/:id/steps", async (req, res) => {
  if (!(await assertCampaignOwnership(req, res, req.params.id))) return;
  const steps = await ensureDefaultSteps(req.params.id);
  res.json(steps);
});

// Get campaign enrollments (with latest message per enrollment)
router.get("/outreach/campaigns/:id/enrollments", async (req, res) => {
  if (!(await assertCampaignOwnership(req, res, req.params.id))) return;
  const enrollments = await db.select()
    .from(outreachEnrollmentsTable)
    .where(eq(outreachEnrollmentsTable.campaignId, req.params.id))
    .orderBy(desc(outreachEnrollmentsTable.enrolledAt));

  const enriched = await Promise.all(enrollments.map(async (e) => {
    const messages = await db.select()
      .from(outreachStepMessagesTable)
      .where(eq(outreachStepMessagesTable.enrollmentId, e.id))
      .orderBy(outreachStepMessagesTable.stepNumber);

    const [sc] = await db.select().from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, e.candidateId)).limit(1);

    const raw = (sc?.rawData as any) || {};
    const candidateInfo = sc ? {
      id: sc.id,
      name: raw.name || `${raw.firstName || ""} ${raw.lastName || ""}`.trim() || e.recipientName,
      title: raw.title || raw.currentTitle || "",
      company: raw.company || raw.currentCompany || "",
      email: raw.email || raw.contactInfo?.email || e.recipientEmail,
    } : { id: e.candidateId, name: e.recipientName, title: "", company: "", email: e.recipientEmail };

    return {
      ...e,
      enrolledAt: e.enrolledAt.toISOString(),
      lastSentAt: e.lastSentAt?.toISOString() ?? null,
      repliedAt: e.repliedAt?.toISOString() ?? null,
      updatedAt: e.updatedAt.toISOString(),
      messages: messages.map(m => ({
        ...m,
        scheduledFor: m.scheduledFor?.toISOString() ?? null,
        sentAt: m.sentAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
      candidate: candidateInfo,
    };
  }));

  res.json(enriched);
});

// Enroll a single candidate into a campaign
router.post("/outreach/campaigns/:id/enroll", validate({ body: EnrollCampaignBody }), async (req, res) => {
  const user = req.resolvedUser!;
  const { candidateId, jobId } = req.body;
  if (!candidateId || !jobId) {
    res.status(400).json({ error: "candidateId and jobId required" });
    return;
  }
  /* Tenant must come from the verified caller — never the request body, and
     never a hard-coded "acme" fallback. Confirm the campaign + job belong to
     the caller before enrolling. */
  const [campaign] = await db.select().from(outreachCampaignsTable)
    .where(eq(outreachCampaignsTable.id, req.params.id)).limit(1);
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, campaign.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  /* Plain-recruiter ceiling: both the campaign and the supplied jobId must map
     to a requisition ASSIGNED to the caller. */
  if (!(await recruiterOwnsResource(user, { kind: "campaignId", value: req.params.id }))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsOutreachJob(user, jobId))) {
    res.status(404).json({ error: "Job not found" }); return;
  }
  const tenantId = campaign.tenantId;
  if (!tenantId) { res.status(400).json({ error: "Campaign has no tenant" }); return; }
  /* Validate the supplied jobId — it must belong to the same tenant as the
     campaign. Without this check, a recruiter could enroll a candidate
     against another tenant's job and pollute their pipeline. */
  const [job] = await db.select({ tenantId: jobsTable.tenantId, status: jobsTable.status })
    .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (job.tenantId !== tenantId) {
    res.status(404).json({ error: "Job not found" }); return;
  }
  if (!assertJobApproved(res, job.status)) return;
  /* Validate the supplied candidateId — must also belong to the same tenant.
     candidateId may reference candidates OR sourced_candidates (both used by
     the outreach pipeline), so probe both before refusing. */
  const [normCand] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  let candTenant: string | null = normCand?.tenantId ?? null;
  if (!normCand) {
    const [sc] = await db.select({ tenantId: sourcedCandidatesTable.tenantId })
      .from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, candidateId)).limit(1);
    if (!sc) { res.status(404).json({ error: "Candidate not found" }); return; }
    candTenant = sc.tenantId;
  }
  if (user.role !== "platform_admin" && candTenant !== tenantId) {
    res.status(404).json({ error: "Candidate not found" }); return;
  }
  try {
    const enrollment = await enrollCandidate({
      campaignId: req.params.id,
      candidateId,
      jobId,
      tenantId,
    });
    res.json(enrollment);
  } catch (e) {
    if ((e as { code?: string })?.code === "DNC_BLOCKED") {
      res.status(409).json({
        error: "Candidate is on the Do-Not-Contact list and cannot be enrolled in outreach.",
        reason: "do_not_contact",
      });
      return;
    }
    if ((e as { code?: string })?.code === "NO_CONTACT_EMAIL") {
      res.status(409).json({
        error: "Candidate has no contact email on file and cannot be enrolled in outreach.",
        reason: "no_contact_email",
      });
      return;
    }
    throw e;
  }
});

// Manually trigger autopilot for a campaign
router.post("/outreach/campaigns/:id/autopilot", async (req, res) => {
  if (!(await assertCampaignOwnership(req, res, req.params.id))) return;
  const result = await runAutopilot(req.params.id);
  res.json(result);
});

// Get messages for a specific enrollment
router.get("/outreach/enrollments/:id/messages", async (req, res) => {
  if (!(await assertEnrollmentOwnership(req, res, req.params.id))) return;
  const messages = await db.select()
    .from(outreachStepMessagesTable)
    .where(eq(outreachStepMessagesTable.enrollmentId, req.params.id))
    .orderBy(outreachStepMessagesTable.stepNumber);
  res.json(messages.map(m => ({
    ...m,
    scheduledFor: m.scheduledFor?.toISOString() ?? null,
    sentAt: m.sentAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  })));
});

// Process an incoming reply (AI-classify it)
router.post("/outreach/campaigns/:id/replies", validate({ body: CampaignReplyBody }), async (req, res) => {
  if (!(await assertCampaignOwnership(req, res, req.params.id))) return;
  const { enrollmentId, messageId, body } = req.body;
  if (!enrollmentId || !body) {
    res.status(400).json({ error: "enrollmentId and body required" });
    return;
  }
  /* Belt-and-suspenders: confirm the supplied enrollmentId actually belongs
     to *this* campaign AND to the caller's tenant. Without this, anyone with
     a campaign in their tenant could classify replies into someone else's
     enrollment by guessing an ID. */
  if (!(await assertEnrollmentOwnership(req, res, enrollmentId))) return;
  const [enrollment] = await db.select({ campaignId: outreachEnrollmentsTable.campaignId })
    .from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.id, enrollmentId)).limit(1);
  if (!enrollment || enrollment.campaignId !== req.params.id) {
    res.status(404).json({ error: "Enrollment does not belong to this campaign" });
    return;
  }
  try {
    const result = await classifyReply({
      campaignId: req.params.id,
      enrollmentId,
      messageId,
      replyBody: body,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Force-advance an enrollment to its next step (demo/testing only — bypasses delay)
router.post("/outreach/enrollments/:id/simulate-next", async (req, res) => {
  if (!(await assertEnrollmentOwnership(req, res, req.params.id))) return;
  const { id } = req.params;
  try {
    const [enrollment] = await db.select().from(outreachEnrollmentsTable)
      .where(eq(outreachEnrollmentsTable.id, id)).limit(1);
    if (!enrollment) { res.status(404).json({ error: "Enrollment not found" }); return; }
    if (enrollment.status === "stopped" || enrollment.status === "replied") {
      res.status(400).json({ error: "Enrollment is stopped or already replied — cannot advance" });
      return;
    }
    const nextStep = enrollment.currentStep + 1;
    if (nextStep > 4) { res.status(400).json({ error: "Already at final step" }); return; }

    // Reset lastSentAt to 20 days ago so delay check passes for ALL steps
    await db.update(outreachEnrollmentsTable)
      .set({ lastSentAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), updatedAt: new Date() })
      .where(eq(outreachEnrollmentsTable.id, id));

    // Remove any existing scheduled/failed message for the next step so it regenerates cleanly
    const existing = await db.select().from(outreachStepMessagesTable)
      .where(and(
        eq(outreachStepMessagesTable.enrollmentId, id),
        eq(outreachStepMessagesTable.stepNumber, nextStep),
      ));
    for (const m of existing) {
      if (m.status === "scheduled" || m.status === "failed") {
        await db.delete(outreachStepMessagesTable)
          .where(eq(outreachStepMessagesTable.id, m.id));
      }
    }

    // Generate + send for the campaign (will pick up this enrollment due to reset lastSentAt)
    const generated = await generateMessages(enrollment.campaignId);
    const sendResult = await sendScheduledMessages(enrollment.campaignId);

    const [updated] = await db.select().from(outreachEnrollmentsTable)
      .where(eq(outreachEnrollmentsTable.id, id)).limit(1);

    logger.info({ enrollmentId: id, nextStep, generated: generated.length, sent: sendResult.sent }, "Simulated next step");
    res.json({ ok: true, step: updated?.currentStep ?? nextStep, generated: generated.length, sent: sendResult.sent });
  } catch (err: any) {
    logger.error({ err: err.message }, "simulate-next failed");
    res.status(500).json({ error: err.message });
  }
});

// Get autopilot run history
router.get("/outreach/campaigns/:id/autopilot-runs", async (req, res) => {
  if (!(await assertCampaignOwnership(req, res, req.params.id))) return;
  const runs = await db.select()
    .from(outreachAutopilotRunsTable)
    .where(eq(outreachAutopilotRunsTable.campaignId, req.params.id))
    .orderBy(desc(outreachAutopilotRunsTable.ranAt))
    .limit(20);
  res.json(runs.map(r => ({ ...r, ranAt: r.ranAt.toISOString() })));
});

// ── Inbox ──────────────────────────────────────────────────────────────────

router.get("/outreach/inbox", async (req, res) => {
  const user = req.resolvedUser!;
  const allItems = await db.select().from(recruiterInboxTable).orderBy(desc(recruiterInboxTable.receivedAt));
  /* Tenant scope — only items whose campaign belongs to the caller. */
  const allowedInbox = await getDataScopeTenantIds(user);
  const items = allowedInbox === null
    ? allItems
    : allItems.filter(i => (i as any).tenantId && allowedInbox.includes((i as any).tenantId));
  const withDetails = await Promise.all(items.map(async (item) => {
    const [candidate] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, item.candidateId)).limit(1);

    // Resolve job via campaign → job
    let job: { id: string; title: string } | null = null;
    if (item.campaignId) {
      const [campaign] = await db.select().from(outreachCampaignsTable).where(eq(outreachCampaignsTable.id, item.campaignId)).limit(1);
      if (campaign?.jobId) {
        const [j] = await db.select({ id: jobsTable.id, title: jobsTable.title }).from(jobsTable).where(eq(jobsTable.id, campaign.jobId)).limit(1);
        if (j) job = j;
      }
    }

    return {
      ...item,
      receivedAt: item.receivedAt.toISOString(),
      candidate: candidate ? {
        id: candidate.id,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        email: candidate.email,
        currentTitle: candidate.currentTitle,
        currentCompany: candidate.currentCompany,
      } : null,
      job,
    };
  }));
  res.json(withDetails);
});

// Recruiter sends an email reply to a candidate from an inbox item.
// Marks the inbox row as read on success so it stops nagging the recruiter.
router.post("/outreach/inbox/:id/reply", validate({ body: InboxReplyBody }), async (req, res) => {
  const { subject: subjectOverride, body } = (req.body ?? {}) as {
    subject?: string;
    body?: string;
  };
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }

  const user = req.resolvedUser!;
  const [item] = await db.select().from(recruiterInboxTable)
    .where(eq(recruiterInboxTable.id, req.params.id)).limit(1);
  if (!item) {
    res.status(404).json({ error: "Inbox item not found" });
    return;
  }
  if (!(await canAccessTenant(user, (item as any).tenantId))) {
    res.status(404).json({ error: "Inbox item not found" });
    return;
  }

  // Resolve candidate. inbox.candidateId can point at either a normalized
  // candidate row or a sourced row, mirroring the rest of the outreach
  // pipeline. Try the normalized table first; fall back to sourced.
  let candEmail: string | null = null;
  let candName: string | null = null;
  let candIdForAudit: string = item.candidateId;
  const [cand] = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.id, item.candidateId)).limit(1);
  if (cand) {
    candEmail = cand.email ?? null;
    candName = `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || null;
  }
  // Always also probe sourced_candidates — either as primary lookup
  // (when inbox.candidateId points at a sourced row) or as fallback
  // when the normalized row exists but is missing email/name.
  if (!candEmail || !candName) {
    const [sc] = await db.select().from(sourcedCandidatesTable)
      .where(eq(sourcedCandidatesTable.id, item.candidateId)).limit(1);
    if (sc) {
      const raw = (sc.rawData as any) ?? {};
      candName = candName ?? raw.name ?? null;
      if (!candEmail) {
        // Prefer a real rawData email; otherwise fall back to the canonical
        // candidate row linked via normalizedCandidateId, where the
        // deliverable address lives after normalization/merge. Mirrors the
        // resolution used by enrichMessage so the inbox-reply path never
        // reports "no email on file" for a candidate who actually has one.
        candEmail = realEmailOrEmpty(raw.email) || realEmailOrEmpty(raw?.contactInfo?.email) || null;
        if (!candEmail && sc.normalizedCandidateId) {
          const [nc] = await db.select().from(candidatesTable)
            .where(eq(candidatesTable.id, sc.normalizedCandidateId)).limit(1);
          if (nc) {
            candEmail = realEmailOrEmpty(nc.email) || null;
            candName = candName ?? (`${nc.firstName ?? ""} ${nc.lastName ?? ""}`.trim() || null);
          }
        }
      }
      if (!cand) candIdForAudit = sc.normalizedCandidateId ?? sc.id;
    }
  }

  if (!candEmail) {
    res.status(400).json({ error: "Candidate has no email on file" });
    return;
  }

  const subject = (subjectOverride && subjectOverride.trim())
    || (item.subject.toLowerCase().startsWith("re:") ? item.subject : `Re: ${item.subject}`);

  // Manual 1:1 reply: send from the recruiter's OWN Outlook mailbox (Graph)
  // when connected; falls back to SES automatically inside sendEmail.
  const replierUserId = getAuthUserId(req) ?? undefined;

  const result = await sendEmail({
    to: candEmail,
    subject,
    text: body,
    senderUserId: replierUserId,
    useRecruiterMailbox: Boolean(replierUserId),
    audit: {
      tenantId: item.tenantId,
      actorLabel: "Recruiter (inbox reply)",
      subjectType: "candidate" as any,
      subjectId: candIdForAudit,
      subjectLabel: candName ?? candEmail,
      action: "outreach.inbox_reply.sent",
      metadata: { inboxItemId: item.id, candidateId: candIdForAudit },
    },
  });

  if (!result.ok) {
    logger.error({ inboxItemId: item.id, error: result.error },
      "[inbox-reply] sendEmail failed");
    res.status(500).json({ ok: false, error: result.error ?? "Failed to send email" });
    return;
  }

  // Mark as read so the inbox count drops immediately.
  try {
    await db.update(recruiterInboxTable)
      .set({ isRead: true })
      .where(eq(recruiterInboxTable.id, item.id));
  } catch (err: any) {
    logger.warn({ err: err?.message, inboxItemId: item.id },
      "[inbox-reply] mark-read failed (non-fatal)");
  }

  // Audit row already written by sendEmail's audit hook above; no need
  // to double-record.
  void recordAudit;

  res.json({
    ok: true,
    simulated: result.simulated ?? false,
    messageId: result.messageId ?? null,
  });
});

export default router;
