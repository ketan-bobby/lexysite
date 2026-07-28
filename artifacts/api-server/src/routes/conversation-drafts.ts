/**
 * routes/conversation-drafts.ts — AI Conversation Draft Review Queue
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for the recruiter inbox's "AI drafts to review" panel. When the
 * Outreach Conversation Agent drafts a reply but its verdict is "needs_review",
 * the draft lands here until a recruiter approves, edits, or discards it.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /conversation-drafts/pending      List all pending drafts visible to
 *                                          the caller (tenant-scoped;
 *                                          platform_admin sees all)
 *   GET  /conversation-drafts/:id          Get one draft (with full body + context)
 *   POST /conversation-drafts/:id/approve  Approve + send the draft via SES.
 *                                          Uses conditional UPDATE (pending →
 *                                          auto_sending) to prevent double-send.
 *   POST /conversation-drafts/:id/discard  Mark the draft as discarded (recruiter
 *                                          will reply manually).
 *   PUT  /conversation-drafts/:id          Edit the draft body before approving.
 *
 * ─── Approval flow ───────────────────────────────────────────────────────────
 * POST /approve calls approveAndSendDraft() from outreach-conversation.ts which:
 *   1. Validates the caller's tenant scope against the draft's tenantId (IDOR guard)
 *   2. Atomically claims the draft (pending → auto_sending)
 *   3. Sends via SES
 *   4. Stamps status="sent" and writes an audit row
 * The conditional claim means two simultaneous approvals can never double-send.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db, usersTable, outreachConversationDraftsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { approveAndSendDraft } from "../lib/agents/outreach-conversation";
import { recordAudit } from "../lib/audit";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { validate } from "../middlewares/validate";

const SendDraftBody = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
}).passthrough();

const RejectDraftBody = z.object({
  reason: z.string().optional(),
}).passthrough();

const ConversationSettingsBody = z.object({
  autoSendSafeReplies: z.boolean().optional(),
}).passthrough();

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u || null;
}

/* Subtree-aware tenant gate: own tenant + ALL descendants via the shared
   helper (null = platform_admin, no restriction). A null row tenantId is
   treated as accessible (legacy rows). */
async function canAccessTenant(
  user: { role: string; tenantId: string | null },
  tenantId: string | null | undefined,
): Promise<boolean> {
  const allowed = await getDataScopeTenantIds(user);
  if (allowed === null) return true;
  if (!tenantId) return true;
  return allowed.includes(tenantId);
}

/* Plain-recruiter ownership ceiling for a single draft: it must be tied to a
   requisition ASSIGNED to the caller (jobId), or to a candidate reachable via
   one. Returns true for every non-recruiter (already governed by tenant scope). */
async function recruiterOwnsDraft(
  user: { id: string; role: string; tenantId: string | null },
  draft: { jobId: string | null; candidateId: string | null },
): Promise<boolean> {
  if (user.role !== "recruiter") return true;
  if (draft.jobId && (await recruiterOwnsResource(user, { kind: "jobId", value: draft.jobId }))) return true;
  if (draft.candidateId && (await recruiterOwnsResource(user, { kind: "candidateId", value: draft.candidateId }))) return true;
  return false;
}

/**
 * GET /conversation-drafts/pending — list every draft awaiting recruiter
 * action visible to the caller. Tenant-scoped; platform_admin sees all.
 * The recruiter inbox uses this to show "AI drafts to review".
 */
router.get("/conversation-drafts/pending", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const conds: any[] = [eq(outreachConversationDraftsTable.status, "pending")];
  /* classb-scope [guard-invisible]: subtree scope (own tenant + all descendants;
     platform_admin → no filter). This inArray(...tenantId, allowed) push is the sole
     tenant seal for this Class-B (no-RLS) read; check-classb-read.mjs can't see
     conds-array pushes — do NOT remove without re-scoping (baseline-allowlisted). */
  const allowed = await getDataScopeTenantIds(user);
  if (allowed !== null) {
    conds.push(inArray(outreachConversationDraftsTable.tenantId, allowed.length ? allowed : ["__none__"]));
  }
  /* Plain-recruiter ceiling: only drafts tied to a requisition ASSIGNED to the
     caller. A recruiter with no reqs sees nothing. Drafts with a null jobId are
     excluded for recruiters (ownership cannot be proven for the inbox list). */
  if (user.role === "recruiter") {
    const jobIds = await getRecruiterAssignedJobIds(user);
    if (jobIds.length === 0) { res.json({ count: 0, needsReview: 0, safeToSend: 0, drafts: [] }); return; }
    conds.push(inArray(outreachConversationDraftsTable.jobId, jobIds));
  }
  const rows = await db.select().from(outreachConversationDraftsTable)
    .where(and(...conds))
    .orderBy(desc(outreachConversationDraftsTable.createdAt))
    .limit(200);

  res.json({
    count: rows.length,
    needsReview: rows.filter((r) => r.verdict === "needs_review").length,
    safeToSend: rows.filter((r) => r.verdict === "safe_to_send").length,
    drafts: rows,
  });
});

/**
 * POST /conversation-drafts/:id/send — recruiter approves and sends. Body
 * may include {subject, body} to override the AI's wording before sending.
 */
router.post("/conversation-drafts/:id/send", validate({ body: SendDraftBody }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = req.params.id;

  const [draft] = await db.select().from(outreachConversationDraftsTable)
    .where(eq(outreachConversationDraftsTable.id, id)).limit(1);
  if (!draft) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, draft.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (!(await recruiterOwnsDraft(user, draft))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (draft.status !== "pending") {
    res.status(409).json({ error: `Draft is ${draft.status}` }); return;
  }

  try {
    const out = await approveAndSendDraft(id, user.id, draft.tenantId, {
      subject: req.body?.subject,
      body: req.body?.body,
    });
    res.json({ ok: true, draftId: id, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * POST /conversation-drafts/:id/reject — recruiter dismisses the draft.
 * The candidate gets nothing automatically; the recruiter is expected to
 * follow up out-of-band.
 */
router.post("/conversation-drafts/:id/reject", validate({ body: RejectDraftBody }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = req.params.id;
  const reason = (req.body?.reason as string) || "no_reason_given";

  const [draft] = await db.select().from(outreachConversationDraftsTable)
    .where(eq(outreachConversationDraftsTable.id, id)).limit(1);
  if (!draft) { res.status(404).json({ error: "Not found" }); return; }
  if (!(await canAccessTenant(user, draft.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (!(await recruiterOwnsDraft(user, draft))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (draft.status !== "pending") {
    res.status(409).json({ error: `Draft is ${draft.status}` }); return;
  }

  await db.update(outreachConversationDraftsTable).set({
    status: "rejected",
    rejectedBy: user.id,
    rejectedAt: new Date(),
    rejectedReason: reason,
    updatedAt: new Date(),
  }).where(eq(outreachConversationDraftsTable.id, id));

  void recordAudit({
    tenantId: draft.tenantId,
    actorType: "user",
    actorId: user.id,
    actorLabel: user.name || user.email,
    subjectType: "candidate",
    subjectId: draft.candidateId ?? draft.sourcedId ?? null,
    subjectLabel: draft.candidateName || draft.candidateEmail,
    channel: "system",
    direction: "internal",
    action: "conversation.draft.rejected",
    title: "Recruiter rejected AI draft reply",
    metadata: { draftId: id, reason },
  });

  res.json({ ok: true, draftId: id, status: "rejected" });
});

/**
 * GET /tenants/:id/conversation-settings — fetch the auto-send-safe flag.
 * POST same path to flip it. Lets a tenant admin opt into auto-sending
 * informational replies once they've watched the AI's drafts for a while.
 */
router.get("/tenants/:id/conversation-settings", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const tenantId = req.params.id;
  if (!(await canAccessTenant(user, tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (!t) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ tenantId, autoSendSafeReplies: t.autoSendSafeReplies });
});

router.post("/tenants/:id/conversation-settings", validate({ body: ConversationSettingsBody }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const tenantId = req.params.id;
  if (!(await canAccessTenant(user, tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const enabled = !!req.body?.autoSendSafeReplies;
  await db.update(tenantsTable).set({ autoSendSafeReplies: enabled, updatedAt: new Date() } as any)
    .where(eq(tenantsTable.id, tenantId));

  void recordAudit({
    tenantId,
    actorType: "user",
    actorId: user.id,
    actorLabel: user.name || user.email,
    subjectType: "tenant",
    subjectId: tenantId,
    channel: "system",
    direction: "internal",
    action: "conversation.tenant_settings.updated",
    title: `auto_send_safe_replies set to ${enabled}`,
    metadata: { autoSendSafeReplies: enabled },
  });

  res.json({ ok: true, tenantId, autoSendSafeReplies: enabled });
});

export default router;
