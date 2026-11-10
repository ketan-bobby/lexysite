import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  recruitingWorkflowReceiptsTable as receipts,
  recruitingWorkflowEventsTable as events,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  tenantAiBrandProfilesTable as brands,
} from "@workspace/db";
import type { AtsInterviewInvitationInput, AtsInterviewInvitationState } from "@workspace/api-zod";
import { applicantInterviewContext, applicantInterviewRevision } from "./ats-applicant-interviews";
import { lock } from "./ats-imports";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { hasBoundInvitationWorkflow } from "./workflow-contact-gates";
import { buildMessageContext } from "./ai-message-context";
import { interviewRoomUrl } from "./interview-link-url";
import { inviteEmailHtml, withInviteTips } from "./interview-invite-copy";
import { sendEmail, type SendEmailInput, type SendEmailResult } from "./email";
import {
  greenhouseGateway,
  boundedAtsRead,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";
import { previewApplications, previewJob } from "./ats-connectors/preview";
import { candidateProfile } from "./ats-connectors/profile";

type Tx = Parameters<typeof applicantInterviewContext>[0];
type Visible = Parameters<typeof applicantInterviewContext>[4];
type Outcome = AtsInterviewInvitationState["status"];

/** A transport error can follow provider acceptance. Never infer safe-to-retry. */
export function invitationOutcome(result: SendEmailResult): Outcome {
  if (result.simulated || result.suppressed) return "simulated";
  return result.ok && !!result.messageId ? "provider_accepted" : "review_required";
}

export async function reviewGreenhouseInvitation(
  h: Tx,
  s: WorkflowScope,
  w: string,
  r: string,
  visible: Visible,
) {
  const c = await applicantInterviewContext(h, s, w, r, visible);
  const session = c.existing;
  if (!session || session.applicationId !== `greenhouse-import:${r}`)
    throw new WorkflowConflict("Prepare this imported applicant's interview first.");
  // Lock against concurrent native invitation updates and session completion.
  const [currentSession] = await h
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, session.id), eq(sessions.tenantId, s.tenantId)))
    .for("share");
  if (!currentSession) throw new WorkflowConflict("Interview unavailable.", 404);
  const [plan] = await h
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, currentSession.planId),
        eq(plans.tenantId, s.tenantId),
        eq(plans.jobId, s.jobId),
      ),
    )
    .for("share");
  if (!plan) throw new WorkflowConflict("Interview plan unavailable.");
  const [brand] = await h.select().from(brands).where(eq(brands.tenantId, s.tenantId)).for("share");
  const ctx = await buildMessageContext({ tenantId: s.tenantId, jobId: s.jobId });
  const employer = ctx.companyName || "the hiring team";
  const recipient = c.person.email.trim().toLowerCase();
  const subject = `Interview invitation — ${c.job.title}`;
  const text = withInviteTips(
    `Hi ${c.person.firstName || "there"},\n\n${employer} invites you to an AI interview with Lexy for the ${c.job.title} role you applied for.\n\nStart your interview:\n${interviewRoomUrl(session.id)}\n\nThis link is personal to you. Please do not share it. Your interview will be assessed for this role; the employer makes the hiring decision.\n\n— Lexy AI Hiring Platform\nOn behalf of ${employer}`,
    plan.estimatedDurationMinutes,
  );
  const reviewHash = fingerprint({
    source: applicantInterviewRevision(c),
    sessionId: session.id,
    plan,
    recipient,
    subject,
    text,
    messagingEnabled: brand?.aiMessagingEnabled !== false,
  });
  // A session-wide receipt also prevents another workflow/import sending it.
  const key = `gh-interview-invitation:${session.id}`;
  const [receipt] = await h
    .select()
    .from(receipts)
    .where(
      and(eq(receipts.tenantId, s.tenantId), eq(receipts.jobId, s.jobId), eq(receipts.key, key)),
    );
  const [event] = receipt
    ? await h
        .select()
        .from(events)
        .where(
          and(
            eq(events.id, receipt.resultId),
            eq(events.tenantId, s.tenantId),
            eq(events.jobId, s.jobId),
          ),
        )
    : [];
  // Unknown, interrupted and in-flight claims are all held, never retryable.
  const status: Outcome = receipt
    ? [
        "ats.interview.invitation.provider_accepted",
        "ats.interview.invitation.reconciled",
      ].includes(event?.action ?? "")
      ? "provider_accepted"
      : event?.action === "ats.interview.invitation.simulated"
        ? "simulated"
        : "review_required"
    : currentSession.inviteSentAt
      ? "previously_sent"
      : "not_sent";
  const bound = await hasBoundInvitationWorkflow(s.jobId, s.tenantId, c.person.id);
  const canSend =
    status === "not_sent" &&
    currentSession.status === "scheduled" &&
    brand?.aiMessagingEnabled !== false &&
    !bound;
  const state: AtsInterviewInvitationState = {
    sessionId: session.id,
    recipient,
    subject,
    text,
    reviewHash,
    status,
    canSend,
  };
  return { c, state, key, receipt };
}

export function greenhouseInterviewInvitations(
  gateway: GreenhouseGateway = greenhouseGateway(),
  deliver: (input: SendEmailInput) => Promise<SendEmailResult> = sendEmail,
  authorize?: (
    h: Tx,
    s: WorkflowScope,
    w: string,
    r: string,
    state: AtsInterviewInvitationState,
  ) => Promise<void>,
) {
  async function review(h: Tx, s: WorkflowScope, w: string, r: string, visible: Visible) {
    const result = await reviewGreenhouseInvitation(h, s, w, r, visible);
    await authorize?.(h, s, w, r, result.state);
    return result;
  }
  async function current(s: WorkflowScope, w: string, r: string, visible: Visible) {
    return dbAdmin.transaction(async (tx) => {
      await lock(tx, s, w);
      return review(tx, s, w, r, visible);
    });
  }
  return {
    async read(s: WorkflowScope, w: string, r: string, visible: Visible) {
      return (await current(s, w, r, visible)).state;
    },
    async send(
      s: WorkflowScope,
      w: string,
      r: string,
      input: AtsInterviewInvitationInput,
      visible: Visible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict("Explicit invitation approval is required.", 400);
      const before = await current(s, w, r, visible);
      // Safe request replay returns the saved state, never another transport call.
      if (before.receipt) return before.state;
      if (input.reviewHash !== before.state.reviewHash || !before.state.canSend)
        throw new WorkflowConflict(
          "Invitation review changed or sending is unavailable. Review again.",
        );
      try {
        const remote = async (path: string) => {
          const fresh = await current(s, w, r, visible);
          if (fresh.state.reviewHash !== input.reviewHash || !fresh.state.canSend)
            throw new WorkflowConflict("Invitation authority changed. Review again.");
          return boundedAtsRead(gateway.read(before.c.a.binding.connectionId, path));
        };
        const job = previewJob(
          await remote(`/v3/jobs?ids=${before.c.r.externalJobId}`),
          before.c.r.externalJobId,
        );
        const applications = previewApplications(
          await remote(`/v3/applications?ids=${before.c.r.externalApplicationId}`),
          job.id,
        );
        const person = candidateProfile(
          await remote(`/v3/candidates?ids=${before.c.snapshot.application.candidateId}`),
          before.c.snapshot.application.candidateId,
          false,
        );
        if (
          fingerprint(job) !== fingerprint(before.c.snapshot.job) ||
          applications.length !== 1 ||
          fingerprint(applications[0]) !== fingerprint(before.c.snapshot.application) ||
          !person.emails.includes(before.state.recipient)
        )
          throw new WorkflowConflict(
            "Greenhouse applicant changed. Refresh and review before sending.",
          );
      } catch (error) {
        if (error instanceof WorkflowConflict) throw error;
        throw new WorkflowConflict(
          "Fresh Greenhouse verification failed. No invitation was sent.",
          503,
        );
      }
      const claim = await dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        const fresh = await review(tx, s, w, r, visible);
        if (fresh.receipt) return { id: null, state: fresh.state };
        if (fresh.state.reviewHash !== input.reviewHash || !fresh.state.canSend)
          throw new WorkflowConflict("Invitation review changed. Nothing was sent.");
        const id = randomUUID();
        await tx.insert(events).values({
          id,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: "ats.interview.invitation.claimed",
          note: JSON.stringify({
            sessionId: fresh.state.sessionId,
            recordId: r,
            reviewHash: input.reviewHash,
            recipientHash: fingerprint(fresh.state.recipient),
          }),
        });
        await tx.insert(receipts).values({
          tenantId: s.tenantId,
          jobId: s.jobId,
          key: fresh.key,
          requestHash: input.reviewHash,
          resultId: id,
        });
        return { id, state: fresh.state };
      });
      if (!claim.id) return claim.state;
      // Claim is durable BEFORE the irreversible provider call. Re-authorize while
      // holding current source locks; a rollback cannot erase that earlier claim.
      await dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        const fresh = await review(tx, s, w, r, visible);
        if (
          fresh.state.reviewHash !== input.reviewHash ||
          fresh.receipt?.resultId !== claim.id ||
          fresh.c.existing?.status !== "scheduled"
        )
          throw new WorkflowConflict("Claim held: applicant or invitation authority changed.");
        // Recheck eligibility independently of the receipt's intentional canSend=false.
        const [brand] = await tx
          .select()
          .from(brands)
          .where(eq(brands.tenantId, s.tenantId))
          .for("share");
        if (
          brand?.aiMessagingEnabled === false ||
          fresh.c.existing.inviteSentAt ||
          (await hasBoundInvitationWorkflow(s.jobId, s.tenantId, fresh.c.person.id))
        )
          throw new WorkflowConflict("Claim held: invitation sending is unavailable.");
        let result: SendEmailResult;
        try {
          result = await deliver({
            to: fresh.state.recipient,
            subject: fresh.state.subject,
            text: fresh.state.text,
            html: inviteEmailHtml(fresh.state.text),
            singleAttempt: true,
            audit: {
              tenantId: s.tenantId,
              actorLabel: "Employer-approved Greenhouse invitation",
              subjectType: "candidate",
              subjectId: fresh.c.person.id,
              action: "interview.greenhouse.invite",
              metadata: {
                attemptId: claim.id,
                sessionId: fresh.state.sessionId,
                jobId: s.jobId,
                workflowId: w,
              },
            },
          });
        } catch {
          result = { ok: false };
        }
        const outcome = invitationOutcome(result);
        const outcomeId = randomUUID();
        await tx.insert(events).values({
          id: outcomeId,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: `ats.interview.invitation.${outcome}`,
          note: JSON.stringify({
            attemptId: claim.id,
            sessionId: fresh.state.sessionId,
            recordId: r,
            reviewHash: input.reviewHash,
            ...(result.messageId ? { messageId: result.messageId } : {}),
          }),
        });
        await tx
          .update(receipts)
          .set({ resultId: outcomeId })
          .where(
            and(
              eq(receipts.tenantId, s.tenantId),
              eq(receipts.jobId, s.jobId),
              eq(receipts.key, fresh.key),
              eq(receipts.resultId, claim.id!),
            ),
          );
        if (outcome === "provider_accepted")
          await tx
            .update(sessions)
            .set({ inviteSentAt: new Date() })
            .where(and(eq(sessions.id, fresh.state.sessionId), eq(sessions.tenantId, s.tenantId)));
      });
      return (await current(s, w, r, visible)).state;
    },
  };
}
