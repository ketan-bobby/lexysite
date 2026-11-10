import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable,
  verificationRecordsTable,
  outreachMessagesTable as messages,
  sourcedCandidatesTable as sources,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowsTable as workflows,
} from "@workspace/db";
import { WorkflowConflict } from "./recruiting-workflows";
import { hasWorkflowTestIdentityClearance } from "./workflow-identity-resolution";

type Handle = Pick<typeof dbAdmin, "select">;
type Workflow = typeof workflows.$inferSelect;

/** Require saved verified identity evidence; pending model advice cannot pass. */
export async function assertWorkflowContactPrerequisites(
  handle: Handle,
  wf: Workflow,
  step: string,
) {
  if (!["engagement", "ai_interview"].includes(step)) return;
  const [candidate] = await handle
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, wf.candidateId));
  const [identity] = await handle
    .select({ id: verificationRecordsTable.id })
    .from(verificationRecordsTable)
    .where(
      and(
        eq(verificationRecordsTable.candidateId, wf.candidateId),
        eq(verificationRecordsTable.tenantId, candidate?.tenantId ?? ""),
        eq(verificationRecordsTable.status, "verified"),
        eq(verificationRecordsTable.identityVerified, true),
      ),
    );
  if (!identity && !(await hasWorkflowTestIdentityClearance(handle, wf)))
    throw new WorkflowConflict(
      "Resolve identity with corroboration, or explicitly clear this synthetic staff-inbox pilot, before candidate contact.",
      409,
    );
  if (step !== "ai_interview") return;
  const [reply] = await handle
    .select({ id: messages.id })
    .from(messages)
    .leftJoin(sources, eq(sources.id, messages.candidateId))
    .innerJoin(
      events,
      and(
        eq(events.tenantId, wf.tenantId),
        eq(events.jobId, wf.jobId),
        eq(events.workflowId, wf.id),
        eq(events.journeyId, wf.journeyId),
        sql`${events.action} = 'workflow.outreach_bound:' || ${messages.id}`,
      ),
    )
    .where(
      and(
        eq(messages.jobId, wf.jobId),
        eq(messages.tenantId, wf.tenantId),
        or(
          eq(messages.candidateId, wf.candidateId),
          and(
            eq(sources.normalizedCandidateId, wf.candidateId),
            eq(sources.tenantId, wf.tenantId),
            sql`${sources.rawData}->>'jobId' = ${wf.jobId}`,
          ),
        ),
        inArray(messages.status, ["sent", "replied", "opened"]),
        eq(messages.replySentiment, "positive"),
        sql`${messages.createdAt} >= ${wf.createdAt}`,
        sql`${messages.sentAt} >= ${wf.createdAt}`,
        sql`${messages.repliedAt} >= ${messages.sentAt}`,
        sql`${messages.repliedAt} <= ${new Date()}`,
      ),
    );
  if (!reply)
    throw new WorkflowConflict(
      "A recorded positive reply to this workflow's sent outreach is required before an interview invitation.",
      409,
    );
}

/** Persisted draft ownership, not planning/enrollment or the work order's mode, governs contact. */
export async function hasBoundInvitationWorkflow(
  jobId: string,
  tenantId: string,
  candidateId: string,
) {
  const [wf] = await dbAdmin
    .select({ id: workflows.id })
    .from(workflows)
    .innerJoin(
      events,
      and(
        eq(events.workflowId, workflows.id),
        eq(events.jobId, workflows.jobId),
        eq(events.tenantId, workflows.tenantId),
        eq(events.journeyId, workflows.journeyId),
        sql`${events.action} LIKE 'workflow.outreach_bound:%'`,
      ),
    )
    .where(
      and(
        eq(workflows.jobId, jobId),
        eq(workflows.tenantId, tenantId),
        or(
          eq(workflows.candidateId, candidateId),
          sql`EXISTS (
            SELECT 1 FROM sourced_candidates sc
            WHERE sc.id = ${candidateId}
              AND sc.tenant_id = ${tenantId}
              AND sc.normalized_candidate_id = ${workflows.candidateId}
          )`,
        ),
      ),
    );
  return !!wf;
}

/** SQL fence for a legacy contact claim; reassesses ownership at write time. */
export function unownedWorkflowContactCondition(
  jobId: string,
  tenantId: string,
  candidateId: string,
) {
  return sql`NOT EXISTS (
    SELECT 1 FROM recruiting_workflows wf
    INNER JOIN recruiting_workflow_events ev
      ON ev.workflow_id = wf.id AND ev.job_id = wf.job_id
      AND ev.tenant_id = wf.tenant_id AND ev.journey_id = wf.journey_id
      AND ev.action LIKE 'workflow.outreach_bound:%'
    WHERE wf.job_id = ${jobId} AND wf.tenant_id = ${tenantId}
      AND (wf.candidate_id = ${candidateId} OR EXISTS (
        SELECT 1 FROM sourced_candidates sc
        WHERE sc.id = ${candidateId} AND sc.tenant_id = ${tenantId}
          AND sc.normalized_candidate_id = wf.candidate_id
      ))
  )`;
}
