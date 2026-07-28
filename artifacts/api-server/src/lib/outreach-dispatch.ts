/**
 * outreach-dispatch.ts — Shared first-touch outreach dispatch
 *
 * Sends a single `outreach_messages` row via Amazon SES with the official
 * 3-button quick-reply block appended, then updates the row's status to
 * "sent" (or "failed" with a reason). Extracted from the orchestrator's
 * `_runOutreach` so the recruiter approval endpoint can reuse the exact
 * same send path — there must be ONE way a first-touch email goes out.
 */
import { db } from "@workspace/db";
import { outreachMessagesTable, jobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendEmail, plainToHtml } from "./email";
import { buildMessageQuickReplyBlocks } from "./outreach-reply-tokens";
import { isRealEmail } from "./real-email";
import { logger } from "./logger";

export type DispatchResult =
  | { ok: true; simulated: boolean; suppressed?: boolean; messageId?: string }
  | { ok: false; error: string };

/**
 * Dispatch a single outreach message to the candidate's email and persist
 * the resulting status. Assumes the message body has already been generated
 * and guardrailed. The caller is responsible for any approval gating — by
 * the time this runs, the message is cleared to send.
 */
export async function dispatchOutreachMessage(
  msgId: string,
  body: string,
  subject: string,
  candidateEmail: string | undefined | null,
): Promise<DispatchResult> {
  /* Sink-level guardrail (defense in depth): no message goes out to an empty or
     synthetic placeholder (@unknown.local / @import.local) address. Upstream
     callers already gate on this, but centralising the refusal here means a
     legacy/handcrafted row or any future caller can never bypass it — every
     first-touch send funnels through this one dispatcher. Demo-domain addresses
     (@demo.lexy.example) ARE real here and continue through; they get suppressed
     at the transport (email.ts), not here. */
  if (!isRealEmail(candidateEmail)) {
    await db.update(outreachMessagesTable)
      .set({ status: "failed", failedReason: "Candidate has no email address on file" })
      .where(eq(outreachMessagesTable.id, msgId));
    logger.warn({ messageId: msgId }, "[outreach] no real email on candidate – cannot dispatch");
    return { ok: false, error: "Candidate has no email address on file" };
  }

  const baseUrl = process.env.PUBLIC_API_BASE_URL
    || process.env.APP_BASE_URL
    || `https://${process.env.REPLIT_DEV_DOMAIN || "app.l3xy.ai"}`;
  const baseAbs = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const quick = buildMessageQuickReplyBlocks(msgId, baseAbs);
  const fullText = body + quick.text;
  const fullHtml = plainToHtml(body) + quick.html;

  /* ── Send-router: a first-touch outreach email for a candidate owned by a
     recruiter goes from that recruiter's OWN Outlook mailbox (Graph) when
     connected; any failure falls back to SES inside sendEmail. This is the
     canonical first/approved-step dispatcher (approve, regenerate, and the
     orchestrator auto-send all flow through here), so the owner is the job's
     assigned recruiter. We look the row up to find its jobId + candidate +
     tenant (the function previously only ever UPDATEd this row). */
  const [msgRow] = await db
    .select({
      jobId: outreachMessagesTable.jobId,
      candidateId: outreachMessagesTable.candidateId,
      tenantId: outreachMessagesTable.tenantId,
    })
    .from(outreachMessagesTable)
    .where(eq(outreachMessagesTable.id, msgId))
    .limit(1);

  let senderUserId: string | undefined;
  if (msgRow?.jobId) {
    try {
      const [ownerJob] = await db
        .select({ rec: jobsTable.assignedRecruiterId })
        .from(jobsTable)
        .where(eq(jobsTable.id, msgRow.jobId))
        .limit(1);
      if (ownerJob?.rec) senderUserId = ownerJob.rec;
    } catch {
      /* non-fatal — fall back to SES */
    }
  }

  try {
    const sendResult = await sendEmail({
      to: candidateEmail,
      subject,
      html: fullHtml,
      text: fullText,
      senderUserId,
      useRecruiterMailbox: Boolean(senderUserId),
      audit: {
        tenantId: msgRow?.tenantId ?? null,
        actorLabel: "Outreach (first touch)",
        subjectType: "candidate",
        subjectId: msgRow?.candidateId ?? null,
        subjectLabel: candidateEmail,
        action: "outreach.message.sent",
        metadata: { messageId: msgId, jobId: msgRow?.jobId ?? null },
      },
    });
    if (sendResult.ok) {
      // Demo-domain sends are hard-refused at the transport (email.ts) and must
      // never be recorded as a real "sent" — mark them "suppressed" so they stay
      // out of sent/reply/failure metrics while the approve→send demo flow still
      // reports success to the recruiter.
      const status = sendResult.suppressed ? "suppressed" : sendResult.simulated ? "queued" : "sent";
      await db.update(outreachMessagesTable)
        .set({ status, sentAt: new Date() })
        .where(eq(outreachMessagesTable.id, msgId));
      logger.info({ to: candidateEmail, messageId: sendResult.messageId, simulated: !!sendResult.simulated, suppressed: !!sendResult.suppressed }, "[outreach] message dispatched");
      return { ok: true, simulated: !!sendResult.simulated, suppressed: !!sendResult.suppressed, messageId: sendResult.messageId };
    }
    await db.update(outreachMessagesTable)
      .set({ status: "failed", failedReason: sendResult.error || "SES send failed" })
      .where(eq(outreachMessagesTable.id, msgId));
    logger.error({ to: candidateEmail, err: sendResult.error }, "[outreach] SES send failed");
    return { ok: false, error: sendResult.error || "SES send failed" };
  } catch (err: any) {
    await db.update(outreachMessagesTable)
      .set({ status: "failed", failedReason: err?.message || "Dispatch error" })
      .where(eq(outreachMessagesTable.id, msgId));
    logger.error({ to: candidateEmail, err: err?.message }, "[outreach] dispatch threw");
    return { ok: false, error: err?.message || "Dispatch error" };
  }
}
