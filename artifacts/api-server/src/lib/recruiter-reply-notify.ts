/**
 * recruiter-reply-notify.ts — Recruiter Reply Notification Helper
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Notifies the assigned recruiter whenever a candidate replies to an outreach
 * email. Both reply paths (campaign-driven classifyReply in outreach-engine.ts
 * and the no-campaign path in webhooks.ts) previously moved declines to
 * "rejected" without writing to the inbox or sending an email alert. This
 * helper consolidates inbox + email notification for ALL classified replies so
 * both paths behave consistently.
 *
 * ─── Routing rules ───────────────────────────────────────────────────────────
 * • Always insert a recruiter_inbox_items row (in-app notification surface).
 * • If the recruiter's notification_frequency is "realtime" → send an email immediately.
 * • Other frequencies → in-app only; the digest scheduler handles batching.
 *
 * ─── Reply classifications handled ──────────────────────────────────────────
 *   interested · question · referral · not_interested · unsubscribe
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   lib/outreach-engine.ts  — classifyReply() on every inbound candidate reply
 *   routes/webhooks.ts      — no-campaign reply path
 *
 * ─── Side effects ────────────────────────────────────────────────────────────
 * • Writes recruiter_inbox_items (always)
 * • Sends SES email (realtime frequency only)
 * • Never throws — errors are caught and logged so the caller's reply flow
 *   always continues even if notification delivery fails.
 * • If "digest" → queue an entry on recruiter_digest_queue stamped with
 *   the *recruiter's* tenantId (matches the screening-batch fix from
 *   commit 0c546b3).
 * • If "off" → skip email but still write the inbox row (the inbox is
 *   the in-app surface; "off" controls email noise only).
 */
import { and, eq } from "drizzle-orm";
import {
  db,
  jobsTable,
  usersTable,
  candidatesTable,
  recruiterInboxTable,
  recruiterDigestQueueTable,
} from "@workspace/db";
import { sendEmail, plainToHtml } from "./email.js";
import { logger } from "./logger.js";

export type ReplyClassification =
  | "interested"
  | "not_interested"
  | "referral"
  | "question"
  | "reengagement"
  | "out_of_office"
  | "unsubscribe";

/**
 * Inline-image attachment metadata persisted on the inbox row. The shape
 * mirrors `InboxAttachment` in routes/webhooks.ts; we duplicate it here
 * instead of importing to avoid a circular dependency between the route
 * module and this helper.
 */
export interface ReplyAttachment {
  cid: string;
  filename: string;
  contentType: string;
  url: string;
}

export interface NotifyRecruiterOfReplyInput {
  tenantId: string | null | undefined;
  jobId: string | null | undefined;
  candidateId: string;
  candidateName?: string | null;
  candidateEmail: string;
  classification: ReplyClassification;
  body: string;
  /** Optional: pass through if you have one (campaign-driven flow). */
  campaignId?: string | null;
  /**
   * Inline image attachments referenced by `[cid:xxx]` tokens in `body`.
   * Persisted on `recruiter_inbox_items.attachments` (JSONB). The inbox
   * dialog substitutes tokens with `<img src={url}>`.
   */
  attachments?: ReplyAttachment[];
}

interface InboxMapping {
  type: "positive_reply" | "question" | "negative_reply" | "unsubscribe" | "needs_followup";
  priority: "high" | "normal" | "low";
  subjectVerb: string;
}

/** Map AI classification → inbox row shape. OOO is a no-op. */
function mapClassification(c: ReplyClassification): InboxMapping | null {
  switch (c) {
    case "interested":
      return { type: "positive_reply", priority: "high", subjectVerb: "is interested" };
    case "question":
      return { type: "question", priority: "normal", subjectVerb: "asked a question" };
    case "referral":
      return { type: "needs_followup", priority: "normal", subjectVerb: "suggested a referral" };
    case "not_interested":
      return { type: "negative_reply", priority: "normal", subjectVerb: "declined" };
    case "unsubscribe":
      return { type: "unsubscribe", priority: "normal", subjectVerb: "asked to stop emails (DNC)" };
    case "reengagement":
      return { type: "needs_followup", priority: "high", subjectVerb: "is re-engaging — asking what roles we have for them" };
    case "out_of_office":
      return null;
  }
}

export async function notifyRecruiterOfReply(
  input: NotifyRecruiterOfReplyInput,
): Promise<{ inboxRowId: string | null; emailed: boolean; queuedForDigest: boolean }> {
  const { jobId, candidateId, candidateName, candidateEmail, classification, body, attachments } = input;
  const mapping = mapClassification(classification);
  if (!mapping) {
    return { inboxRowId: null, emailed: false, queuedForDigest: false };
  }
  if (!jobId) {
    logger.info({ candidateId, classification }, "[reply-notify] no jobId — skipping recruiter notification");
    return { inboxRowId: null, emailed: false, queuedForDigest: false };
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) {
    logger.info({ jobId, classification }, "[reply-notify] job not found — skipping");
    return { inboxRowId: null, emailed: false, queuedForDigest: false };
  }

  // The in-app inbox row is tenant-scoped, so it must ALWAYS be written — even
  // when the job has no assigned recruiter — otherwise candidate replies
  // silently vanish from the recruiter inbox (the symptom: an empty inbox even
  // though candidates replied). The assigned recruiter is only required for the
  // *direct* email / digest notification further below.
  let recruiter: typeof usersTable.$inferSelect | null = null;
  if (job.assignedRecruiterId) {
    const [r] = await db.select().from(usersTable)
      .where(eq(usersTable.id, job.assignedRecruiterId)).limit(1);
    recruiter = r ?? null;
  }

  const recruiterTenantId = (recruiter as any)?.tenantId || (job as any).tenantId || input.tenantId || null;
  const displayName = (candidateName && candidateName.trim()) || candidateEmail;
  const subject = `${displayName} ${mapping.subjectVerb} — ${job.title}`;
  const preview = body.slice(0, 200);

  // 1) Always write the in-app inbox row.
  let inboxRowId: string | null = null;
  try {
    const safeAttachments = (attachments ?? []).filter(
      (a) =>
        a &&
        typeof a.cid === "string" && a.cid &&
        typeof a.url === "string" && a.url &&
        typeof a.contentType === "string" &&
        typeof a.filename === "string",
    );
    const [row] = await db.insert(recruiterInboxTable).values({
      // recruiter_inbox_items.tenant_id is logically the recruiter's tenant
      // (so tenant-scoped queries surface it correctly), mirroring the
      // recruiter_digest_queue convention.
      tenantId: recruiterTenantId ?? (job as any).tenantId,
      type: mapping.type as any,
      candidateId,
      // campaign_id is NOT NULL but has no FK — fall back to jobId for
      // non-campaign replies so we never lose the row to a constraint.
      campaignId: input.campaignId || jobId,
      subject,
      preview,
      body,
      priority: mapping.priority,
      attachments: safeAttachments.length > 0 ? safeAttachments : null,
    } as any).returning();
    inboxRowId = row?.id ?? null;
  } catch (err: any) {
    logger.error({ err: err?.message, candidateId, jobId }, "[reply-notify] inbox insert failed");
  }

  // 2) Email routing based on recruiter preference. Only fires when the job
  //    has an assigned recruiter with an email; otherwise the tenant-scoped
  //    inbox row written above is the sole notification surface.
  const pref = (recruiter as any)?.notificationFrequency || "digest";
  let emailed = false;
  let queuedForDigest = false;

  if (recruiter?.email && pref === "realtime") {
    const text =
      `Candidate reply on "${job.title}":\n\n` +
      `${displayName} (${candidateEmail}) ${mapping.subjectVerb}.\n\n` +
      `--- Their message ---\n${body.slice(0, 2000)}\n`;
    try {
      await sendEmail({
        to: recruiter.email,
        subject: `[Lexy] ${subject}`,
        text,
        html: plainToHtml(text),
        audit: {
          tenantId: recruiterTenantId,
          actorLabel: "Reply Notifier",
          subjectType: "user",
          subjectId: recruiter.id,
          subjectLabel: recruiter.name || recruiter.email,
          action: `reply.notify.${classification}`,
          metadata: { jobId, candidateId, classification },
        },
      });
      emailed = true;
    } catch (err: any) {
      logger.error({ err: err?.message, recruiterId: recruiter.id }, "[reply-notify] realtime email failed");
    }
  } else if (recruiter?.email && pref === "digest") {
    try {
      await db.insert(recruiterDigestQueueTable).values({
        tenantId: recruiterTenantId ?? (job as any).tenantId,
        recruiterId: recruiter.id,
        jobId,
        eventType: `reply.${classification}`,
        payload: {
          jobTitle: job.title,
          jobTenantId: (job as any).tenantId,
          candidateId,
          candidateName: displayName,
          candidateEmail,
          classification,
          body: body.slice(0, 1000),
        },
      });
      queuedForDigest = true;
    } catch (err: any) {
      logger.error({ err: err?.message, recruiterId: recruiter.id }, "[reply-notify] digest queue failed");
    }
  } // pref === "off" → inbox only, no email

  logger.info(
    { candidateId, jobId, classification, recruiterId: recruiter?.id ?? null, pref, inboxRowId, emailed, queuedForDigest },
    "[reply-notify] notified recruiter",
  );
  return { inboxRowId, emailed, queuedForDigest };
}

/* ─── High-intent stage-move notifications ──────────────────────────────────
 * When a candidate is manually advanced into a high-intent stage (e.g. a hiring
 * manager drags someone to "assessment" or "offer"), the assigned recruiter
 * previously got no signal — they could miss that the role is progressing
 * without them. This helper mirrors the reply-notify routing (always write the
 * tenant-scoped inbox row; email/digest only when there's an assigned
 * recruiter) so high-intent moves surface the same way replies do. */
export interface NotifyStageMoveInput {
  tenantId: string | null | undefined;
  jobId: string | null | undefined;
  candidateId: string;
  toStage: string;
  /** The user who performed the move — suppressed from being notified about
   *  their own action (e.g. the recruiter dragging the card themselves). */
  movedByUserId?: string | null;
}

/** Human-readable label for the stages we alert on. */
const HIGH_INTENT_STAGE_LABELS: Record<string, string> = {
  assessment: "Assessment",
  offer: "Offer",
};

export async function notifyRecruiterOfStageMove(
  input: NotifyStageMoveInput,
): Promise<{ inboxRowId: string | null; emailed: boolean; queuedForDigest: boolean }> {
  const noop = { inboxRowId: null, emailed: false, queuedForDigest: false };
  const { jobId, candidateId, toStage, movedByUserId } = input;
  const stageLabel = HIGH_INTENT_STAGE_LABELS[toStage];
  if (!stageLabel) return noop; // only high-intent stages are alerted
  if (!jobId) {
    logger.info({ candidateId, toStage }, "[stage-move-notify] no jobId — skipping");
    return noop;
  }

  try {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) return noop;

    // Don't notify the recruiter about a move they performed themselves.
    if (job.assignedRecruiterId && movedByUserId && job.assignedRecruiterId === movedByUserId) {
      logger.info({ jobId, candidateId, toStage }, "[stage-move-notify] mover is the assignee — skipping");
      return noop;
    }

    let recruiter: typeof usersTable.$inferSelect | null = null;
    if (job.assignedRecruiterId) {
      const [r] = await db.select().from(usersTable)
        .where(eq(usersTable.id, job.assignedRecruiterId)).limit(1);
      recruiter = r ?? null;
    }

    const [cand] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    const displayName = cand
      ? (`${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() || cand.email || "A candidate")
      : "A candidate";

    const recruiterTenantId = (recruiter as any)?.tenantId || (job as any).tenantId || input.tenantId || null;
    const subject = `${displayName} moved to ${stageLabel} — ${job.title}`;
    const preview = `${displayName} was advanced to the ${stageLabel} stage for ${job.title}.`;

    // 1) Always write the in-app inbox row (tenant-scoped surface).
    let inboxRowId: string | null = null;
    try {
      const [row] = await db.insert(recruiterInboxTable).values({
        tenantId: recruiterTenantId ?? (job as any).tenantId,
        type: "needs_followup" as any,
        candidateId,
        campaignId: jobId, // campaign_id NOT NULL, no FK — fall back to jobId
        subject,
        preview,
        body: preview,
        priority: "high",
      } as any).returning();
      inboxRowId = row?.id ?? null;
    } catch (err: any) {
      logger.error({ err: err?.message, candidateId, jobId }, "[stage-move-notify] inbox insert failed");
    }

    // 2) Email / digest only when there's an assigned recruiter.
    const pref = (recruiter as any)?.notificationFrequency || "digest";
    let emailed = false;
    let queuedForDigest = false;

    if (recruiter?.email && pref === "realtime") {
      const text =
        `High-intent stage move on "${job.title}":\n\n` +
        `${displayName} was advanced to ${stageLabel}.\n`;
      try {
        await sendEmail({
          to: recruiter.email,
          subject: `[Lexy] ${subject}`,
          text,
          html: plainToHtml(text),
          audit: {
            tenantId: recruiterTenantId,
            actorLabel: "Stage Move Notifier",
            subjectType: "user",
            subjectId: recruiter.id,
            subjectLabel: recruiter.name || recruiter.email,
            action: `stage_move.notify.${toStage}`,
            metadata: { jobId, candidateId, toStage },
          },
        });
        emailed = true;
      } catch (err: any) {
        logger.error({ err: err?.message, recruiterId: recruiter.id }, "[stage-move-notify] realtime email failed");
      }
    } else if (recruiter?.email && pref === "digest") {
      try {
        await db.insert(recruiterDigestQueueTable).values({
          tenantId: recruiterTenantId ?? (job as any).tenantId,
          recruiterId: recruiter.id,
          jobId,
          eventType: `stage_move.${toStage}`,
          payload: {
            jobTitle: job.title,
            jobTenantId: (job as any).tenantId,
            candidateId,
            candidateName: displayName,
            toStage,
          },
        });
        queuedForDigest = true;
      } catch (err: any) {
        logger.error({ err: err?.message, recruiterId: recruiter.id }, "[stage-move-notify] digest queue failed");
      }
    }

    logger.info(
      { candidateId, jobId, toStage, recruiterId: recruiter?.id ?? null, pref, inboxRowId, emailed, queuedForDigest },
      "[stage-move-notify] notified recruiter",
    );
    return { inboxRowId, emailed, queuedForDigest };
  } catch (err: any) {
    logger.error({ err: err?.message, candidateId, jobId, toStage }, "[stage-move-notify] failed (non-fatal)");
    return noop;
  }
}
