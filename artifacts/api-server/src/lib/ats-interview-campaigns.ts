import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  interviewPlansTable as plans,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type {
  AtsCampaignPreparationInput,
  AtsCampaignControlInput,
  AtsCampaignDispatchInput,
} from "@workspace/api-zod";
import {
  applicantInterviewPlanHash,
  greenhouseApplicantInterviews,
} from "./ats-applicant-interviews";
import {
  greenhouseInterviewInvitations,
  reviewGreenhouseInvitation,
} from "./ats-interview-invitations";
import { greenhouseGateway, type GreenhouseGateway } from "./ats-connectors/greenhouse-gateway";
import { sendEmail, type SendEmailInput, type SendEmailResult } from "./email";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import {
  campaignBase,
  campaignIndex,
  campaignRoot,
  campaignView,
  eventData,
  lockedCampaign,
  memberData,
  scopedEvent,
  type CampaignHandle,
  type CampaignVisible,
} from "./ats-campaign-store";

type Plan = typeof plans.$inferSelect;
function planContent(p: Plan) {
  const { id: _id, createdAt: _createdAt, ...content } = p;
  return fingerprint(content);
}
async function reviewedMember(
  h: CampaignHandle,
  s: WorkflowScope,
  w: string,
  recordId: string,
  sourcePlan: Plan,
  visible: CampaignVisible,
) {
  const review = await reviewGreenhouseInvitation(h, s, w, recordId, visible);
  const session = review.c.existing;
  if (
    !session ||
    session.applicationId !== `greenhouse-import:${recordId}` ||
    !review.state.canSend ||
    session.status !== "scheduled"
  )
    throw new WorkflowConflict(
      "Every selected applicant must have an unsent, eligible interview prepared from this import.",
    );
  const [frozen] = await h
    .select()
    .from(plans)
    .where(
      and(eq(plans.id, session.planId), eq(plans.jobId, s.jobId), eq(plans.tenantId, s.tenantId)),
    )
    .for("share");
  if (!frozen || planContent(frozen) !== planContent(sourcePlan))
    throw new WorkflowConflict(
      "An applicant's prepared interview uses a different plan. Review it individually; no interview is replaced.",
    );
  return review;
}

/** Explicit, resumable human-approved batches; no cron or background auto-dispatch. */
export function greenhouseInterviewCampaigns(
  gateway: GreenhouseGateway = greenhouseGateway(),
  deliver: (input: SendEmailInput) => Promise<SendEmailResult> = sendEmail,
) {
  const preparation = greenhouseApplicantInterviews(gateway);
  const detail = async (s: WorkflowScope, w: string, id: string, visible: CampaignVisible) =>
    lockedCampaign(s, w, async (h) => (await campaignView(h, s, w, id, visible)).state);
  return {
    index: campaignIndex,
    read: detail,
    async prepare(
      s: WorkflowScope,
      w: string,
      input: AtsCampaignPreparationInput,
      visible: CampaignVisible,
    ) {
      if (
        input.acknowledge !== true ||
        input.recordIds.length < 1 ||
        input.recordIds.length > 10 ||
        new Set(input.recordIds).size !== input.recordIds.length
      )
        throw new WorkflowConflict(
          "Select up to ten distinct reviewed applicants and acknowledge private link preparation.",
          400,
        );
      const recordIds = [...input.recordIds].sort();
      const id = `gh-campaign:${fingerprint({
        tenant: s.tenantId,
        job: s.jobId,
        workflow: w,
        actor: s.actorId,
        key: input.idempotencyKey,
      })}`;
      const requestHash = fingerprint({ ...input, recordIds });
      const before = await lockedCampaign(s, w, async (h) => {
        const base = await campaignBase(h, s, w, visible);
        const existing = await scopedEvent(h, s, w, id);
        if (existing) {
          const root = await campaignRoot(h, s, w, id);
          if (root.data.requestHash !== requestHash)
            throw new WorkflowConflict("This preparation key belongs to a different selection.");
          return { base, existing: true };
        }
        if (base.sourceHash !== input.sourceHash)
          throw new WorkflowConflict("Employer, job or plans changed. Refresh batch setup.");
        return { base, existing: false };
      });
      if (before.existing) return detail(s, w, id, visible);
      const sourcePlan = before.base.selectable.find((p) => p.id === input.planId);
      if (!sourcePlan || applicantInterviewPlanHash(before.base.job, sourcePlan) !== input.planHash)
        throw new WorkflowConflict("Choose the current nonempty job plan.");
      // Existing preparation preserves mint idempotency, provider checks and
      // private frozen plans. Partial preview preparation never sends email.
      for (const recordId of recordIds) {
        const view = await preparation.read(s, w, recordId, visible);
        const selected = view.plans.find((p) => p.id === input.planId);
        if (!selected || selected.approvalHash !== input.planHash)
          throw new WorkflowConflict("The selected plan changed while preparing the preview.");
        const prepared = await preparation.prepare(
          s,
          w,
          recordId,
          {
            planId: input.planId,
            expectedPlanHash: input.planHash,
            acknowledge: true,
            expectedWorkflowRevision: view.workflowRevision,
            expectedBindingRevision: view.bindingRevision,
            expectedImportRevision: view.importRevision,
          },
          visible,
        );
        if (!prepared.session?.preparedFromThisImport)
          throw new WorkflowConflict(
            "Use the existing interview's individual controls; it is not adopted by this batch.",
          );
      }
      return lockedCampaign(s, w, async (h) => {
        const base = await campaignBase(h, s, w, visible);
        const existing = await scopedEvent(h, s, w, id);
        if (existing) {
          if ((await campaignRoot(h, s, w, id)).data.requestHash !== requestHash)
            throw new WorkflowConflict("This preparation key belongs to another selection.");
          return (await campaignView(h, s, w, id, visible)).state;
        }
        if (base.sourceHash !== input.sourceHash)
          throw new WorkflowConflict("The job or employer changed. No batch was approved or sent.");
        const itemIds = [];
        for (const recordId of recordIds) {
          const review = await reviewedMember(h, s, w, recordId, sourcePlan, visible);
          const memberId = `gh-campaign-member:${fingerprint({ id, recordId })}`;
          itemIds.push(memberId);
          await h.insert(events).values({
            id: memberId,
            tenantId: s.tenantId,
            jobId: s.jobId,
            workflowId: w,
            actorId: s.actorId,
            action: "ats.interview.campaign.member",
            note: JSON.stringify({
              campaignId: id,
              recordId,
              sessionId: review.state.sessionId,
              invitationHash: review.state.reviewHash,
            }),
          });
        }
        await h.insert(events).values({
          id,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: "ats.interview.campaign.created",
          note: JSON.stringify({
            version: 1,
            planId: input.planId,
            planHash: input.planHash,
            sourceHash: input.sourceHash,
            requestHash,
            itemIds,
          }),
        });
        return (await campaignView(h, s, w, id, visible)).state;
      });
    },
    async control(
      s: WorkflowScope,
      w: string,
      id: string,
      input: AtsCampaignControlInput,
      visible: CampaignVisible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict("Explicit batch acknowledgement is required.", 400);
      return lockedCampaign(s, w, async (h) => {
        const view = await campaignView(h, s, w, id, visible);
        if (
          (input.action === "cancel" && view.root.cancelled) ||
          (input.action === "approve" && view.root.approved)
        )
          return view.state;
        if (
          view.state.reviewHash !== input.reviewHash ||
          (input.action === "approve" ? !view.state.canApprove : !view.state.canCancel)
        )
          throw new WorkflowConflict("Batch review or control authority changed. Review again.");
        await h.insert(events).values({
          id: `${id}:${input.action === "approve" ? "approved" : "cancelled"}`,
          tenantId: s.tenantId,
          jobId: s.jobId,
          workflowId: w,
          actorId: s.actorId,
          action: `ats.interview.campaign.${input.action === "approve" ? "approved" : "cancelled"}`,
          note: JSON.stringify({ campaignId: id, reviewHash: input.reviewHash }),
        });
        return (await campaignView(h, s, w, id, visible)).state;
      });
    },
    async dispatch(
      s: WorkflowScope,
      w: string,
      id: string,
      memberId: string,
      input: AtsCampaignDispatchInput,
      visible: CampaignVisible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict("Explicit execution of this approved batch is required.", 400);
      const before = await lockedCampaign(s, w, async (h) => {
        const view = await campaignView(h, s, w, id, visible);
        if (
          !["approved", "complete"].includes(view.state.status) ||
          input.reviewHash !== view.state.reviewHash
        )
          throw new WorkflowConflict(
            "The batch is unapproved, cancelled or changed. No new contact is authorized.",
          );
        const member = view.state.members.find((m) => m.id === memberId);
        if (!member) throw new WorkflowConflict("Batch member unavailable.", 404);
        if (!member.canDispatch) return { member: null, view };
        const event = await scopedEvent(h, s, w, memberId);
        const data = memberData.parse(eventData(event!.note));
        return { member: data, view };
      });
      if (!before.member) return before.view.state;
      const item = before.member;
      // This guard runs at EVERY existing invitation read/claim/transport
      // boundary under the same employer lock as cancellation and approval.
      const invitations = greenhouseInterviewInvitations(
        gateway,
        deliver,
        async (h, scope, workflow, record, state) => {
          const view = await campaignView(h, scope, workflow, id, visible);
          if (
            !["approved", "complete"].includes(view.state.status) ||
            view.state.reviewHash !== input.reviewHash ||
            record !== item.recordId ||
            state.sessionId !== item.sessionId ||
            state.reviewHash !== item.invitationHash
          )
            throw new WorkflowConflict("Batch approval or execution authority changed.");
        },
      );
      try {
        await invitations.send(
          s,
          w,
          item.recordId,
          { reviewHash: item.invitationHash, acknowledge: true },
          visible,
        );
      } catch (error) {
        if (!(error instanceof WorkflowConflict)) throw error;
        // Persist only a bounded diagnostic code, never private provider text.
        // Revalidation fences erasure before this late per-person audit write.
        await lockedCampaign(s, w, async (h) => {
          const view = await campaignView(h, s, w, id, visible);
          if (!view.state.members.find((m) => m.id === memberId)?.recordId) return;
          await h.insert(events).values({
            id: randomUUID(),
            tenantId: s.tenantId,
            jobId: s.jobId,
            workflowId: w,
            actorId: s.actorId,
            action: "ats.interview.campaign.member_blocked",
            note: JSON.stringify({
              campaignId: id,
              memberId,
              sessionId: item.sessionId,
              recordId: item.recordId,
              statusCode: error.status,
            }),
          });
        });
      }
      return detail(s, w, id, visible);
    },
  };
}
