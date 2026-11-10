import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  atsImportedApplicationsTable as imports,
  atsCandidateProfilesTable as profiles,
  candidatesTable as people,
  interviewPlansTable as plans,
  interviewSessionsTable as sessions,
  jobsTable as jobs,
  usersTable as users,
  recruitingWorkflowsTable as workflows,
} from "@workspace/db";
import type { AtsApplicantInterviewInput, AtsApplicantInterviewState } from "@workspace/api-zod";
import { currentAtsImportAuthority, lock } from "./ats-imports";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "../routes/candidates";
import {
  greenhouseGateway,
  boundedAtsRead,
  type GreenhouseGateway,
} from "./ats-connectors/greenhouse-gateway";
import { previewApplications, previewJob } from "./ats-connectors/preview";
import { candidateProfile } from "./ats-connectors/profile";
import { interviewRoomUrl } from "./interview-link-url";
import { interviewMintLockKey } from "./interview-mint-lock";
import { hasBoundInvitationWorkflow } from "./workflow-contact-gates";

type Handle = Parameters<typeof currentAtsImportAuthority>[0];
type Visible = Parameters<typeof currentAtsImportAuthority>[3];
type Plan = typeof plans.$inferSelect;
type Job = typeof jobs.$inferSelect;

export const applicantInterviewPlanHash = (job: Job, plan: Plan) => fingerprint({ job, plan });

export function assertApplicantInterviewReview(
  current: {
    workflowRevision: number;
    bindingRevision: number;
    importRevision: number;
    planHash: string;
  },
  input: AtsApplicantInterviewInput,
) {
  if (input.acknowledge !== true)
    throw new WorkflowConflict("Explicit interview-preparation acknowledgement is required.", 400);
  if (
    input.expectedWorkflowRevision !== current.workflowRevision ||
    input.expectedBindingRevision !== current.bindingRevision ||
    input.expectedImportRevision !== current.importRevision ||
    input.expectedPlanHash !== current.planHash
  )
    throw new WorkflowConflict(
      "The applicant, employer grant or interview plan changed. Review again.",
    );
}

export async function applicantInterviewContext(
  h: Handle,
  s: WorkflowScope,
  workflowId: string,
  recordId: string,
  visible: Visible,
) {
  const a = await currentAtsImportAuthority(h, s, workflowId, visible);
  const [actor] = await h.select().from(users).where(eq(users.id, s.actorId)).for("share");
  if (
    !actor ||
    actor.status !== "active" ||
    actor.role !== "tenant_admin" ||
    actor.tenantId !== s.tenantId ||
    s.canEdit === false
  )
    throw new WorkflowConflict(
      "An active administrator of this employer must prepare the interview.",
      403,
    );
  const [r] = await h
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.id, recordId),
        eq(imports.tenantId, s.tenantId),
        eq(imports.jobId, s.jobId),
        eq(imports.accountRef, a.binding.accountRef),
        eq(imports.externalJobId, a.mapping.externalJobId),
      ),
    )
    .for("share");
  if (!r) throw new WorkflowConflict("Imported applicant not found.", 404);
  const snapshot = r.currentSnapshot ?? r.snapshot;
  if (
    r.availability === "unavailable" ||
    snapshot.job.status !== "open" ||
    snapshot.application.status !== "in_process"
  )
    throw new WorkflowConflict(
      "Refresh and review an active applicant on an open Greenhouse job first.",
    );
  const [link] = await h
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.tenantId, s.tenantId),
        eq(profiles.system, "greenhouse"),
        eq(profiles.accountRef, r.accountRef),
        eq(profiles.externalCandidateId, snapshot.application.candidateId),
      ),
    )
    .for("share");
  if (!link)
    throw new WorkflowConflict("Import or explicitly link the reviewed candidate profile first.");
  const [person] = await h
    .select()
    .from(people)
    .where(and(eq(people.id, link.candidateId), eq(people.tenantId, s.tenantId)))
    .for("share");
  if (
    !person ||
    person.pool !== "tenant" ||
    person.doNotContact ||
    person.dataErasedAt ||
    (await applyCandidatePrivacyFilter(applyCandidateHardExclusions([person]), s.tenantId))
      .length !== 1
  )
    throw new WorkflowConflict("This applicant is unavailable for interview preparation.", 404);
  const [job] = await h
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, s.jobId), eq(jobs.tenantId, s.tenantId)))
    .for("share");
  if (!job || job.status !== "active")
    throw new WorkflowConflict("An approved active Lexy work order is required.");
  const available = await h
    .select()
    .from(plans)
    .where(and(eq(plans.jobId, s.jobId), eq(plans.tenantId, s.tenantId)))
    .for("share");
  const selectable = available
    .filter(
      (p) =>
        !p.id.startsWith("gh-prepared:") && Array.isArray(p.questions) && p.questions.length > 0,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const [workflow] = await h
    .select({ revision: workflows.revision })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.tenantId, s.tenantId),
        eq(workflows.jobId, s.jobId),
      ),
    );
  if (!workflow) throw new WorkflowConflict("Workflow unavailable.", 404);
  const [existing] = await h
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(
      plans,
      and(eq(plans.id, sessions.planId), eq(plans.tenantId, s.tenantId), eq(plans.jobId, s.jobId)),
    )
    .where(and(eq(sessions.tenantId, s.tenantId), eq(sessions.candidateId, person.id)))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  // Fresh statement after row-lock acquisition: an erasure marker can live in
  // another table and must not be judged using the locking SELECT's old snapshot.
  const sealed = await h.execute(sql`SELECT EXISTS (
    SELECT 1 FROM candidate_erasure_tombstones
    WHERE subject_id='ats-profile:' || md5(jsonb_build_array(
      ${s.tenantId}::text,'greenhouse'::text,${r.accountRef}::text,
      ${snapshot.application.candidateId}::text)::text)
  ) OR public.lexy_erasure_job_blocked(
    ${JSON.stringify({ candidateId: person.id })}::jsonb,
    NULL::text) AS blocked`);
  if (sealed.rows[0]?.blocked !== false)
    throw new WorkflowConflict("This applicant is unavailable for interview preparation.", 404);
  return {
    a,
    r,
    snapshot,
    person,
    job,
    selectable,
    existing: existing?.session,
    workflowRevision: workflow.revision,
  };
}
type Context = Awaited<ReturnType<typeof applicantInterviewContext>>;
export function applicantInterviewRevision(c: Context) {
  return fingerprint({
    binding: c.a.binding,
    mapping: c.a.mapping,
    recordId: c.r.id,
    importRevision: c.r.refreshRevision,
    snapshot: c.snapshot,
    candidateId: c.person.id,
    email: c.person.email.trim().toLowerCase(),
    job: c.job,
    plans: c.selectable,
    workflowRevision: c.workflowRevision,
  });
}
const context = applicantInterviewContext;
const revision = applicantInterviewRevision;
function view(c: Context, workflowRevision: number, bound: boolean): AtsApplicantInterviewState {
  return {
    workflowRevision,
    bindingRevision: c.a.binding.revision,
    importRevision: c.r.refreshRevision,
    canPrepare: !c.existing && !bound && c.selectable.length > 0,
    plans: c.selectable.map((p) => ({
      id: p.id,
      title: p.title,
      language: p.language,
      questionCount: (p.questions as unknown[]).length,
      approvalHash: applicantInterviewPlanHash(c.job, p),
    })),
    session: c.existing
      ? {
          id: c.existing.id,
          status: c.existing.status,
          roomUrl: interviewRoomUrl(c.existing.id),
          preparedFromThisImport: c.existing.applicationId === `greenhouse-import:${c.r.id}`,
        }
      : null,
  };
}

/**
 * Explicit preparation only. No email/provider write, AI generation, native
 * application enrollment/stage change, offer, or scheduler dispatch.
 */
export function greenhouseApplicantInterviews(gateway: GreenhouseGateway = greenhouseGateway()) {
  async function current(s: WorkflowScope, w: string, r: string, visible: Visible) {
    return dbAdmin.transaction(async (tx) => {
      await lock(tx, s, w);
      const c = await context(tx, s, w, r, visible);
      return { c, workflowRevision: c.workflowRevision };
    });
  }
  return {
    async read(s: WorkflowScope, w: string, r: string, visible: Visible) {
      const { c, workflowRevision } = await current(s, w, r, visible);
      return view(
        c,
        workflowRevision,
        await hasBoundInvitationWorkflow(s.jobId, s.tenantId, c.person.id),
      );
    },
    async prepare(
      s: WorkflowScope,
      w: string,
      r: string,
      input: AtsApplicantInterviewInput,
      visible: Visible,
    ) {
      if (input.acknowledge !== true)
        throw new WorkflowConflict(
          "Explicit interview-preparation acknowledgement is required.",
          400,
        );
      const before = await current(s, w, r, visible);
      const plan = before.c.selectable.find((p) => p.id === input.planId);
      if (!plan) throw new WorkflowConflict("Choose an existing nonempty job interview plan.");
      assertApplicantInterviewReview(
        {
          workflowRevision: before.workflowRevision,
          bindingRevision: before.c.a.binding.revision,
          importRevision: before.c.r.refreshRevision,
          planHash: applicantInterviewPlanHash(before.c.job, plan),
        },
        input,
      );
      // Preserve all prior interviews rather than quietly issuing a second link.
      if (before.c.existing) return view(before.c, before.workflowRevision, false);
      const sourceRevision = revision(before.c);
      const remote = async (path: string) => {
        const fresh = await current(s, w, r, visible);
        if (
          fresh.workflowRevision !== before.workflowRevision ||
          revision(fresh.c) !== sourceRevision
        )
          throw new WorkflowConflict("Applicant authority changed. Reload before preparing.");
        return boundedAtsRead(gateway.read(before.c.a.binding.connectionId, path));
      };
      try {
        const job = previewJob(
          await remote(`/v3/jobs?ids=${before.c.r.externalJobId}`),
          before.c.r.externalJobId,
        );
        const apps = previewApplications(
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
          apps.length !== 1 ||
          fingerprint(apps[0]) !== fingerprint(before.c.snapshot.application) ||
          !person.emails.includes(before.c.person.email.trim().toLowerCase())
        )
          throw new WorkflowConflict(
            "Greenhouse applicant data changed. Refresh and review it first.",
          );
      } catch (error) {
        if (error instanceof WorkflowConflict) throw error;
        throw new WorkflowConflict(
          "Fresh Greenhouse reads could not be verified. Nothing was prepared.",
          503,
        );
      }
      return dbAdmin.transaction(async (tx) => {
        await lock(tx, s, w);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${interviewMintLockKey(
            s.tenantId,
            before.c.person.id,
            s.jobId,
            plan.interviewType,
          )})`,
        );
        const c = await context(tx, s, w, r, visible);
        if (revision(c) !== sourceRevision)
          throw new WorkflowConflict("Applicant, grant or plan changed. Nothing was prepared.");
        const bound = await hasBoundInvitationWorkflow(s.jobId, s.tenantId, c.person.id);
        if (c.existing) return view(c, before.workflowRevision, bound);
        if (bound)
          throw new WorkflowConflict("Use this applicant's existing workflow invitation approval.");
        const id = randomUUID();
        const roomUrl = interviewRoomUrl(id); // Validate origin before persistence.
        const frozenId = `gh-prepared:${fingerprint({ recordId: r, sourceRevision, planId: plan.id })}`;
        await tx.insert(plans).values({ ...plan, id: frozenId, createdAt: new Date() });
        const [session] = await tx
          .insert(sessions)
          .values({
            id,
            tenantId: s.tenantId,
            candidateId: c.person.id,
            planId: frozenId,
            applicationId: `greenhouse-import:${r}`,
            status: "scheduled",
            language: plan.language,
            totalQuestions: (plan.questions as unknown[]).length,
            currentQuestionIndex: 0,
            answers: [],
            inviteSentAt: null,
          })
          .returning();
        return {
          ...view({ ...c, existing: session }, before.workflowRevision, false),
          session: { id, status: session.status, roomUrl, preparedFromThisImport: true },
        };
      });
    },
  };
}
