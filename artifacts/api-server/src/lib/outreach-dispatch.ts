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
import { outreachMessagesTable, jobsTable, candidatesTable } from "@workspace/db";
import { and, eq, sql, isNull } from "drizzle-orm";
import {guardedOutreachMail,isUncertainMailReason,heldMailError} from "./outreach-mail-attempt";
import { sendEmail, plainToHtml } from "./email";
import { buildMessageQuickReplyBlocks } from "./outreach-reply-tokens";
import { isRealEmail } from "./real-email";
import { logger } from "./logger";
import { isCandidateErased } from "./candidate-erasure-barrier";
import {
  executeWorkflowAction,
  type WorkflowActionContext,
} from "./workflow-execution";
import { fingerprint, WorkflowConflict } from "./recruiting-workflows";
import { storedOutreachWorkflow } from "./workflow-outreach";

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
  workflow?: WorkflowActionContext,
): Promise<DispatchResult> {
  const stored = await storedOutreachWorkflow(msgId, { body, subject, candidateEmail });
  if (
    stored &&
    workflow &&
    (stored.input.workflowId !== workflow.input.workflowId ||
      stored.input.candidateId !== workflow.input.candidateId ||
      stored.input.journeyId !== workflow.input.journeyId ||
      stored.input.journeyVersion !== workflow.input.journeyVersion)
  )
    throw new WorkflowConflict("Stored outreach binding cannot be overridden.", 409);
  workflow = stored ?? workflow;
  if (workflow) {
    const context = workflow;
    if (
      workflow.input.stepKey !== "engagement" ||
      workflow.input.actionKind !== "outreach_send" ||
      workflow.input.payloadHash !== fingerprint({ msgId, body, subject, candidateEmail })
    )
      throw new WorkflowConflict("Outreach does not match the bound workflow action.", 409);
    const result = await executeWorkflowAction(workflow, {
      mode: "live",
      isSuccessful: (output) => output.ok && !output.simulated && !output.suppressed,
      invoke: async () => {
        const [message] = await db
          .select()
          .from(outreachMessagesTable)
          .where(
            and(
              eq(outreachMessagesTable.id, msgId),
              eq(outreachMessagesTable.tenantId, workflow.scope.tenantId),
              eq(outreachMessagesTable.jobId, workflow.scope.jobId),
            ),
          );
        if (
          !message ||
          message.body !== body ||
          message.subject !== subject ||
          ["sent", "replied", "opened"].includes(message.status)
        )
          throw new WorkflowConflict("Outreach source needs human reconciliation.", 409);
        const [candidate] = await db
          .select()
          .from(candidatesTable)
          .where(eq(candidatesTable.id, workflow.input.candidateId));
        if (
          !candidate ||
          candidate.dataErasedAt ||
          candidate.doNotContact ||
          !candidate.email ||
          candidate.email.trim().toLowerCase() !== candidateEmail?.trim().toLowerCase()
        )
          throw new WorkflowConflict("Outreach recipient needs human reconciliation.", 409);
        // Ownership of canonical OR sourced IDs is checked when the binding
        // is persisted; resolve the row again to catch subsequent tampering.
        if (message.candidateId !== context.input.candidateId) {
          const { sourcedCandidatesTable } = await import("@workspace/db");
          const [source] = await db.select().from(sourcedCandidatesTable).where(and(
            eq(sourcedCandidatesTable.id, message.candidateId),
            sql`EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=${sourcedCandidatesTable.normalizedCandidateId} AND a.job_id=${context.scope.jobId})`,
            eq(sourcedCandidatesTable.tenantId, context.scope.tenantId),
            eq(sourcedCandidatesTable.normalizedCandidateId, context.input.candidateId),
          ));
          if (!source) throw new WorkflowConflict("Outreach candidate binding changed.", 409);
        }
        return sendFirstTouch(msgId, body, subject, candidateEmail);
      },
    });
    if (result.state === "succeeded") return result.output;
    return {
      ok: false,
      error:
        result.state === "already_claimed"
          ? "Workflow action was already claimed; reconcile its outcome before retrying."
          : "Workflow action outcome is uncertain; do not resend automatically.",
    };
  }
  return sendFirstTouch(msgId, body, subject, candidateEmail);
}

/** Private transport boundary: workflow checks cannot recursively bypass themselves. */
async function sendFirstTouch(
  msgId: string,
  body: string,
  subject: string,
  candidateEmail: string | undefined | null,
): Promise<DispatchResult> {
  const [msgRow] = await db.select({
    jobId:outreachMessagesTable.jobId,candidateId:outreachMessagesTable.candidateId,
    tenantId:outreachMessagesTable.tenantId,failedReason:outreachMessagesTable.failedReason,
    status:outreachMessagesTable.status,
  }).from(outreachMessagesTable).where(eq(outreachMessagesTable.id,msgId)).limit(1);
  if(!msgRow)return {ok:false,error:"Outreach message no longer exists."};
  if(isUncertainMailReason(msgRow.failedReason))return {ok:false,error:heldMailError};
  if(["sent","replied","opened","suppressed"].includes(msgRow.status))
    return {ok:false,error:"Outreach was already processed; no new send was attempted."};
  const unchanged=and(eq(outreachMessagesTable.id,msgId),
    eq(outreachMessagesTable.tenantId,msgRow.tenantId),eq(outreachMessagesTable.jobId,msgRow.jobId),
    eq(outreachMessagesTable.status,msgRow.status),
    msgRow.failedReason===null?isNull(outreachMessagesTable.failedReason):eq(outreachMessagesTable.failedReason,msgRow.failedReason));
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
      .where(unchanged);
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
     connected; only known non-attempts/rejections permit SES fallback. This is the
     canonical first/approved-step dispatcher (approve, regenerate, and the
     orchestrator auto-send all flow through here), so the owner is the job's
     assigned recruiter. We look the row up to find its jobId + candidate +
     tenant (the function previously only ever UPDATEd this row). */
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

    // The content and recipient may have been assembled before erasure.
    // Re-read at the provider boundary; never send from a deleted message.
    if (!msgRow || await isCandidateErased(msgRow.candidateId)) {
      return { ok: false, error: "candidate_erased" };
    }
    const sendResult=await guardedOutreachMail({
      claim:async marker=>(await db.update(outreachMessagesTable).set({failedReason:marker})
        .where(unchanged).returning({id:outreachMessagesTable.id})).length===1,
      invoke:async()=>{
    const sendResult = await sendEmail({
      singleAttempt:true,
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
      return sendResult;
    }
    return sendResult;
      },
      finish:async(result,marker,held)=>(await db.update(outreachMessagesTable).set({
        failedReason:held?marker:result.ok?null:result.error??"Provider rejected the send",
        ...(!result.ok?{status:"failed"}:{}),
      }).where(and(eq(outreachMessagesTable.id,msgId),eq(outreachMessagesTable.tenantId,msgRow.tenantId),
        eq(outreachMessagesTable.failedReason,marker))).returning({id:outreachMessagesTable.id})).length===1,
    });
    return sendResult.ok?{ok:true,simulated:!!sendResult.simulated,suppressed:!!sendResult.suppressed,messageId:sendResult.messageId}:
      {ok:false,error:sendResult.error??heldMailError};
}
