import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  usersTable as users,
  jobsTable as jobs,
  interviewPlansTable as plans,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type { AtsCampaignDetail, AtsCampaignSummary, AtsCampaignMember } from "@workspace/api-zod";
import { currentAtsImportAuthority, lock } from "./ats-imports";
import { applicantInterviewPlanHash } from "./ats-applicant-interviews";
import { reviewGreenhouseInvitation } from "./ats-interview-invitations";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";

export type CampaignHandle = Parameters<typeof currentAtsImportAuthority>[0];
export type CampaignVisible = Parameters<typeof currentAtsImportAuthority>[3];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const rootData = z.object({
  version: z.literal(1),
  planId: z.string(),
  planHash: hash,
  sourceHash: hash,
  requestHash: hash,
  itemIds: z.array(z.string()).min(1).max(10),
});
export const memberData = z.object({
  campaignId: z.string(),
  recordId: z.string(),
  sessionId: z.string(),
  invitationHash: hash,
});
export function eventData(note: string | null) {
  try {
    return JSON.parse(note ?? "{}") as Record<string, unknown>;
  } catch {
    throw new WorkflowConflict("Campaign audit is incomplete; no contact is authorized.");
  }
}
export async function campaignBase(
  h: CampaignHandle,
  s: WorkflowScope,
  w: string,
  visible: CampaignVisible,
) {
  const a = await currentAtsImportAuthority(h, s, w, visible);
  const [actor] = await h.select().from(users).where(eq(users.id, s.actorId)).for("share");
  if (
    s.canEdit === false ||
    actor?.role !== "tenant_admin" ||
    actor.status !== "active" ||
    actor.tenantId !== s.tenantId
  )
    throw new WorkflowConflict("An active administrator of this employer is required.", 403);
  const [job] = await h
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, s.jobId), eq(jobs.tenantId, s.tenantId)))
    .for("share");
  if (job?.status !== "active")
    throw new WorkflowConflict("An approved active work order is required.");
  const [workflow] = await h
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.id, w), eq(workflows.tenantId, s.tenantId), eq(workflows.jobId, s.jobId)),
    );
  if (!workflow) throw new WorkflowConflict("Workflow unavailable.", 404);
  const selectable = (
    await h
      .select()
      .from(plans)
      .where(and(eq(plans.tenantId, s.tenantId), eq(plans.jobId, s.jobId)))
      .for("share")
  )
    .filter(
      (p) =>
        !p.id.startsWith("gh-prepared:") && Array.isArray(p.questions) && p.questions.length > 0,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    job,
    selectable,
    sourceHash: fingerprint({
      binding: a.binding,
      mapping: a.mapping,
      job,
      plans: selectable,
      revision: workflow.revision,
    }),
    plans: selectable.map((p) => ({
      id: p.id,
      title: p.title,
      language: p.language,
      questionCount: (p.questions as unknown[]).length,
      approvalHash: applicantInterviewPlanHash(job, p),
    })),
  };
}
export async function scopedEvent(h: CampaignHandle, s: WorkflowScope, w: string, id: string) {
  const [row] = await h
    .select()
    .from(events)
    .where(
      and(
        eq(events.id, id),
        eq(events.tenantId, s.tenantId),
        eq(events.jobId, s.jobId),
        eq(events.workflowId, w),
      ),
    );
  return row;
}
export async function campaignRoot(h: CampaignHandle, s: WorkflowScope, w: string, id: string) {
  const row = await scopedEvent(h, s, w, id);
  if (!row || row.action !== "ats.interview.campaign.created")
    throw new WorkflowConflict("Campaign unavailable.", 404);
  const parsed = rootData.safeParse(eventData(row.note));
  if (!parsed.success || new Set(parsed.data.itemIds).size !== parsed.data.itemIds.length)
    throw new WorkflowConflict("Campaign audit is incomplete; no contact is authorized.");
  const approved = await scopedEvent(h, s, w, `${id}:approved`);
  const cancelled = await scopedEvent(h, s, w, `${id}:cancelled`);
  if (
    (approved && approved.action !== "ats.interview.campaign.approved") ||
    (cancelled && cancelled.action !== "ats.interview.campaign.cancelled")
  )
    throw new WorkflowConflict("Campaign control audit is incomplete.");
  return { row, data: parsed.data, approved, cancelled };
}
export function campaignSummary(
  root: Awaited<ReturnType<typeof campaignRoot>>,
): AtsCampaignSummary {
  return {
    id: root.row.id,
    createdAt: root.row.createdAt.toISOString(),
    planId: root.data.planId,
    recipientCount: root.data.itemIds.length,
    approved: !!root.approved,
    cancelled: !!root.cancelled,
  };
}
export async function campaignView(
  h: CampaignHandle,
  s: WorkflowScope,
  w: string,
  id: string,
  visible: CampaignVisible,
) {
  const base = await campaignBase(h, s, w, visible);
  const root = await campaignRoot(h, s, w, id);
  const rows: AtsCampaignMember[] = [];
  let matching = base.sourceHash === root.data.sourceHash;
  for (const memberId of root.data.itemIds) {
    const event = await scopedEvent(h, s, w, memberId);
    const parsed =
      event?.action === "ats.interview.campaign.member"
        ? memberData.safeParse(eventData(event.note))
        : null;
    const item = parsed?.success && parsed.data.campaignId === id ? parsed.data : null;
    const member: AtsCampaignMember = {
      id: memberId,
      recordId: null,
      recipient: null,
      subject: null,
      text: null,
      invitationStatus: "unavailable",
      interviewStatus: null,
      canDispatch: false,
      reason: "Applicant unavailable or approval snapshot changed. No contact is permitted.",
    };
    if (item) {
      try {
        const review = await reviewGreenhouseInvitation(h, s, w, item.recordId, visible);
        if (
          review.state.sessionId !== item.sessionId ||
          review.state.reviewHash !== item.invitationHash
        )
          throw new WorkflowConflict("Snapshot changed.");
        const failures = await h
          .select()
          .from(events)
          .where(
            and(
              eq(events.tenantId, s.tenantId),
              eq(events.jobId, s.jobId),
              eq(events.workflowId, w),
              eq(events.action, "ats.interview.campaign.member_blocked"),
              sql`(CASE WHEN ${events.action}='ats.interview.campaign.member_blocked'
            THEN ${events.note}::jsonb ELSE '{}'::jsonb END)->>'memberId'=${memberId}`,
              sql`(CASE WHEN ${events.action}='ats.interview.campaign.member_blocked'
            THEN ${events.note}::jsonb ELSE '{}'::jsonb END)->>'campaignId'=${id}`,
            ),
          )
          .orderBy(desc(events.createdAt))
          .limit(1);
        const blocked = failures.length > 0;
        Object.assign(member, {
          recordId: item.recordId,
          recipient: review.state.recipient,
          subject: review.state.subject,
          text: review.state.text,
          invitationStatus:
            review.state.status === "not_sent"
              ? blocked || !review.state.canSend
                ? "blocked"
                : "ready"
              : review.state.status,
          interviewStatus: review.c.existing?.status ?? null,
          canDispatch: review.state.canSend,
          reason: review.state.canSend
            ? blocked
              ? "An earlier execution was blocked. A deliberate retry is required."
              : null
            : "No new send is available. Provider acceptance is not inbox delivery; uncertain and simulated attempts remain held.",
        });
      } catch (error) {
        if (!(error instanceof WorkflowConflict)) throw error;
        matching = false;
      }
    } else matching = false;
    rows.push(member);
  }
  let approved = false;
  const reviewHash = fingerprint({ id, root: root.data, sourceHash: base.sourceHash });
  if (root.approved) {
    const [approver] = await h
      .select()
      .from(users)
      .where(eq(users.id, root.approved.actorId))
      .for("share");
    approved =
      approver?.tenantId === s.tenantId &&
      approver.role === "tenant_admin" &&
      approver.status === "active" &&
      eventData(root.approved.note).reviewHash === reviewHash;
  }
  const canRun = matching && approved && !root.cancelled;
  for (const row of rows) row.canDispatch = row.canDispatch && canRun;
  const complete =
    canRun &&
    rows.every((r) => ["provider_accepted", "previously_sent"].includes(r.invitationStatus));
  const state: AtsCampaignDetail = {
    id,
    planId: root.data.planId,
    reviewHash,
    status: root.cancelled
      ? "cancelled"
      : !matching || (!!root.approved && !approved)
        ? "needs_review"
        : complete
          ? "complete"
          : approved
            ? "approved"
            : "review",
    canApprove:
      !root.approved &&
      !root.cancelled &&
      matching &&
      rows.every((r) => r.invitationStatus === "ready" && r.interviewStatus === "scheduled"),
    canCancel: !root.cancelled,
    members: rows,
  };
  return { root, state, base };
}
export async function lockedCampaign<T>(
  s: WorkflowScope,
  w: string,
  work: (h: CampaignHandle) => Promise<T>,
) {
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, s, w);
    return work(tx);
  });
}
export async function campaignIndex(s: WorkflowScope, w: string, visible: CampaignVisible) {
  return lockedCampaign(s, w, async (h) => {
    const base = await campaignBase(h, s, w, visible);
    const recent = await h
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, s.tenantId),
          eq(events.jobId, s.jobId),
          eq(events.workflowId, w),
          eq(events.action, "ats.interview.campaign.created"),
        ),
      )
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(21);
    const campaigns = [];
    for (const row of recent.slice(0, 20))
      campaigns.push(campaignSummary(await campaignRoot(h, s, w, row.id)));
    return {
      sourceHash: base.sourceHash,
      plans: base.plans,
      campaigns,
      truncated: recent.length > 20,
    };
  });
}
