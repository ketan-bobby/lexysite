import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  aiJobsTable,
  candidateEvaluationsTable,
  candidatesTable,
  dbAdmin,
  interviewPlansTable,
  interviewSessionsTable,
  interviewSummariesTable,
  jobsTable,
  qorInterviewRequestsTable as requests,
  qorPartnerCredentialsTable as credentials,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import type { QorInterviewRequestInput, QorInterviewStatus } from "@workspace/api-zod";
import { interviewMintLockKey } from "./interview-mint-lock";
import { compliantCandidatePredicate } from "./compliance-scope";
import {
  qorApplicationMarker,
  qorConflict,
  qorContactHash,
  qorContactLock,
  qorDigest,
  QorError,
  qorEvidence,
  qorFingerprint,
  qorSessionStatus,
  missingQorRequest,
} from "./qor-interview-policy";

export type QorTransaction = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Row = typeof requests.$inferSelect;
export type QorBinding = { jobId: string; candidateId: string; planId: string };

export async function qorCredential(
  tx: QorTransaction,
  header: string | undefined,
  action: "create" | "read",
) {
  const token = /^Bearer (qor_[A-Za-z0-9_-]{43})$/i.exec(header ?? "")?.[1];
  const unauthorized = () =>
    new QorError(401, "unauthorized", "A valid QOR credential is required.");
  if (!token) throw unauthorized();
  const [auth] = await tx
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.digest, qorDigest(token)),
        isNull(credentials.revokedAt),
        gt(credentials.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for("share");
  if (!auth) throw unauthorized();
  await activeEmployer(tx, auth.tenantId);
  if (!(action === "create" ? auth.canCreate : auth.canRead))
    throw new QorError(403, "forbidden", "The credential does not have the required permission.");
  return auth.tenantId;
}

async function activeEmployer(tx: QorTransaction, tenantId: string) {
  const [tenant] = await tx
    .select({ status: tenantsTable.status })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .for("share");
  if (!tenant || tenant.status === "suspended")
    throw new QorError(403, "forbidden", "The employer is not authorized.");
}

export async function qorReviewer(tx: QorTransaction, userId: string) {
  const [user] = await tx
    .select({
      tenantId: usersTable.tenantId,
      role: usersTable.role,
      status: usersTable.status,
      erasedAt: usersTable.accountErasedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .for("share");
  if (
    !user ||
    user.erasedAt ||
    user.status !== "active" ||
    user.role !== "tenant_admin" ||
    !user.tenantId
  )
    throw new QorError(
      403,
      "forbidden",
      "An active administrator of the exact employer is required.",
    );
  await activeEmployer(tx, user.tenantId);
  return user.tenantId;
}

function scoped(tenantId: string, requestId: string) {
  return and(eq(requests.tenantId, tenantId), eq(requests.id, requestId));
}

export async function qorRequest(
  tx: QorTransaction,
  tenantId: string,
  requestId: string,
  lock?: "share" | "update",
) {
  const query = tx.select().from(requests).where(scoped(tenantId, requestId));
  const [row] = await (lock ? query.for(lock) : query);
  if (!row?.externalApplicationId || row.erasedAt) throw missingQorRequest();
  return row;
}

export async function submitQorRequest(
  tx: QorTransaction,
  tenantId: string,
  input: QorInterviewRequestInput,
  key: string,
) {
  const contactHash = qorContactHash(input.candidate.email);
  const idempotencyHash = qorDigest(key);
  const applicationHash = qorDigest(input.externalApplicationId);
  // Names and addresses are not written to intake storage. Keep them in the
  // request fingerprint so changed input is never silently treated as replay.
  const payloadHash = qorFingerprint(input);
  const contactKey = qorContactLock(tenantId, contactHash);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactKey}, 0))`);
  const blocked = await tx.execute(
    sql`SELECT 1 FROM candidate_erasure_tombstones WHERE subject_id=${contactKey}`,
  );
  if (blocked.rows.length) throw missingQorRequest();
  const [created] = await tx
    .insert(requests)
    .values({
      tenantId,
      idempotencyHash,
      applicationHash,
      payloadHash,
      contactHash,
      externalApplicationId: input.externalApplicationId,
      externalCandidateId: input.candidate.externalId,
      selectionRef: input.selectionRef,
      externalJobId: input.job.externalId,
      jobTitle: input.job.title,
      jobBrief: input.job.brief,
      jobRevision: input.job.revision,
      jobApprovalRef: input.job.approvalRef,
    })
    .onConflictDoNothing()
    .returning({ id: requests.id });
  if (created)
    return {
      requestId: created.id,
      externalApplicationId: input.externalApplicationId,
      replayed: false,
    };
  const matches = await tx
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.tenantId, tenantId),
        or(
          eq(requests.idempotencyHash, idempotencyHash),
          eq(requests.applicationHash, applicationHash),
        ),
      ),
    );
  if (
    matches.length !== 1 ||
    matches[0].idempotencyHash !== idempotencyHash ||
    matches[0].payloadHash !== payloadHash
  )
    throw new QorError(
      409,
      "request_conflict",
      "The key or application already has a different submission.",
    );
  const prior = matches[0];
  if (prior.erasedAt) throw missingQorRequest();
  return {
    requestId: prior.id,
    externalApplicationId: input.externalApplicationId,
    replayed: true,
  };
}

async function eligibleCandidate(tx: QorTransaction, r: Row, id: string, preparing = false) {
  const [candidate] = await tx
    .select({
      id: candidatesTable.id,
      email: candidatesTable.email,
    })
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, id),
        eq(candidatesTable.tenantId, r.tenantId),
        eq(candidatesTable.pool, "tenant"),
        eq(candidatesTable.hideFromCurrentEmployer, false),
        compliantCandidatePredicate(),
      ),
    )
    .for(preparing ? "update" : "share");
  if (!candidate || qorContactHash(candidate.email) !== r.contactHash) throw missingQorRequest();
  // Take the lock in a separate statement before reading erasure tombstones.
  // This sees committed erasure even when the candidate tuple didn't change.
  const tombstone = await tx.execute(sql`SELECT 1 FROM candidate_erasure_tombstones
    WHERE subject_id IN (${candidate.id}, ${qorContactLock(r.tenantId, r.contactHash!)}) LIMIT 1`);
  if (tombstone.rows.length) throw missingQorRequest();
  return candidate;
}

async function jobSource(tx: QorTransaction, r: Row, jobId: string, forInterview: boolean) {
  const [job] = await tx
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      description: jobsTable.description,
      status: jobsTable.status,
      confidential: jobsTable.isConfidential,
      path: jobsTable.interviewPath,
      clientWorkOrderNumber: jobsTable.clientWorkOrderNumber,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, r.tenantId)))
    .for("share");
  if (!job || job.confidential) throw missingQorRequest();
  if (["draft", "pending_approval", "rejected"].includes(job.status)) throw missingQorRequest();
  if (forInterview && !jobReadyForQor(job, r))
    throw qorConflict(
      "Use an approved, open work order matching the submitted brief and external job ID.",
    );
  return job;
}

function jobReadyForQor(
  job: {
    status: string;
    path: string;
    title: string;
    description: string;
    clientWorkOrderNumber: string | null;
  },
  request: Row,
) {
  return (
    ["active", "published"].includes(job.status) &&
    job.path !== "human" &&
    job.title.trim() === request.jobTitle &&
    job.description.trim() === request.jobBrief &&
    job.clientWorkOrderNumber?.trim() === request.externalJobId
  );
}

async function scopedPlan(tx: QorTransaction, r: Row, jobId: string, planId: string) {
  const [plan] = await tx
    .select()
    .from(interviewPlansTable)
    .where(
      and(
        eq(interviewPlansTable.id, planId),
        eq(interviewPlansTable.tenantId, r.tenantId),
        eq(interviewPlansTable.jobId, jobId),
      ),
    )
    .for("share");
  if (!plan) throw missingQorRequest();
  return plan;
}

export async function qorPreparation(
  tx: QorTransaction,
  r: Row,
  binding: QorBinding,
  prepare = false,
) {
  const candidate = await eligibleCandidate(tx, r, binding.candidateId, prepare);
  const current = prepare ? await qorRequest(tx, r.tenantId, r.id, "update") : r;
  if (current.sessionId) {
    if (prepare && current.candidateId === binding.candidateId && current.jobId === binding.jobId)
      return { sessionId: current.sessionId, alreadyPrepared: true as const };
    throw qorConflict("This request is already bound to a prepared interview.");
  }
  const job = await jobSource(tx, r, binding.jobId, true);
  const plan = await scopedPlan(tx, r, job.id, binding.planId);
  if (
    plan.id.startsWith("qor-prepared:") ||
    !Array.isArray(plan.questions) ||
    plan.questions.length === 0
  )
    throw qorConflict("A reviewed plan with at least one question is required.");
  const reviewHash = qorFingerprint({
    request: [r.id, r.payloadHash],
    job,
    plan,
    candidateId: candidate.id,
  });
  return { alreadyPrepared: false as const, reviewHash, job, plan, candidate };
}

export async function prepareQorInterview(
  tx: QorTransaction,
  r: Row,
  binding: QorBinding,
  reviewHash: string,
  userId: string,
) {
  const review = await qorPreparation(tx, r, binding, true);
  if (review.alreadyPrepared) return { prepared: false, sessionId: review.sessionId };
  if (review.reviewHash !== reviewHash)
    throw qorConflict("The work order or plan changed. Review it again.");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${interviewMintLockKey(
      r.tenantId,
      binding.candidateId,
      binding.jobId,
      review.plan.interviewType,
    )})`,
  );
  const [previous] = await tx
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.tenantId, r.tenantId),
        eq(requests.jobId, binding.jobId),
        eq(requests.candidateId, binding.candidateId),
      ),
    )
    .limit(1);
  const [otherSession] = await tx
    .select({ id: interviewSessionsTable.id })
    .from(interviewSessionsTable)
    .innerJoin(
      interviewPlansTable,
      and(
        eq(interviewPlansTable.id, interviewSessionsTable.planId),
        eq(interviewPlansTable.tenantId, r.tenantId),
        eq(interviewPlansTable.jobId, binding.jobId),
      ),
    )
    .where(
      and(
        eq(interviewSessionsTable.tenantId, r.tenantId),
        eq(interviewSessionsTable.candidateId, binding.candidateId),
      ),
    )
    .limit(1);
  if (previous || otherSession)
    throw qorConflict("A candidate interview for this work order already exists.");
  const planId = `qor-prepared:${r.id}`;
  await tx
    .insert(interviewPlansTable)
    .values({ ...review.plan, id: planId, createdAt: new Date() });
  const [session] = await tx
    .insert(interviewSessionsTable)
    .values({
      tenantId: r.tenantId,
      candidateId: binding.candidateId,
      applicationId: qorApplicationMarker(r.id),
      planId,
      language: review.plan.language,
      totalQuestions: (review.plan.questions as unknown[]).length,
      status: "scheduled",
    })
    .returning({ id: interviewSessionsTable.id });
  await tx
    .update(requests)
    .set({
      sessionId: session.id,
      jobId: binding.jobId,
      candidateId: binding.candidateId,
      preparedBy: userId,
    })
    .where(scoped(r.tenantId, r.id));
  return { prepared: true, sessionId: session.id };
}

export async function qorBoundContext(tx: QorTransaction, initial: Row, forWrite = false) {
  if (!initial.candidateId || !initial.jobId || !initial.sessionId) return null;
  const candidate = await eligibleCandidate(tx, initial, initial.candidateId);
  const row = await qorRequest(tx, initial.tenantId, initial.id, forWrite ? "update" : "share");
  if (!row.jobId || !row.sessionId || row.candidateId !== candidate.id) throw missingQorRequest();
  const job = await jobSource(tx, row, row.jobId, false);
  const [session] = await tx
    .select()
    .from(interviewSessionsTable)
    .where(
      and(
        eq(interviewSessionsTable.id, row.sessionId),
        eq(interviewSessionsTable.tenantId, row.tenantId),
        eq(interviewSessionsTable.candidateId, candidate.id),
        eq(interviewSessionsTable.planId, `qor-prepared:${row.id}`),
        eq(interviewSessionsTable.applicationId, qorApplicationMarker(row.id)),
      ),
    )
    .for("share");
  return { row, job, candidate, session: session ?? null };
}

type Bound = NonNullable<Awaited<ReturnType<typeof qorBoundContext>>>;

export async function qorInvitationReview(tx: QorTransaction, bound: Bound) {
  const { row, job, session, candidate } = bound;
  if (
    !session ||
    !row.jobId ||
    !jobReadyForQor(job, row) ||
    (session.status !== "scheduled" && !row.invitationReleasedAt)
  )
    return null;
  const plan = await scopedPlan(tx, row, job.id, session.planId);
  return {
    reviewHash: qorFingerprint({
      request: row.id,
      job,
      session: session.id,
      plan,
      recipient: candidate.email,
    }),
    recipient: candidate.email,
    planTitle: plan.title,
  };
}

export async function recordQorInvitation(
  tx: QorTransaction,
  bound: Bound,
  userId: string,
  reviewHash: string,
  sent: boolean,
) {
  const view = await qorInvitationReview(tx, bound);
  if (!view || view.reviewHash !== reviewHash || (!sent && bound.session?.status !== "scheduled"))
    throw qorConflict("The invitation changed. Review it again.");
  const { row } = bound;
  if (sent && !row.invitationReleasedAt)
    throw qorConflict("Release the reviewed invitation first.");
  const change = sent
    ? !row.invitationReportedAt && {
        invitationReportedAt: new Date(),
        invitationReportedBy: userId,
      }
    : !row.invitationReleasedAt && {
        invitationReleasedAt: new Date(),
        invitationReleasedBy: userId,
      };
  if (change) await tx.update(requests).set(change).where(scoped(row.tenantId, row.id));
}

export async function qorReportReview(tx: QorTransaction, bound: Bound) {
  const { row, session } = bound;
  if (!session?.completedAt || !["completed", "reviewed"].includes(session.status) || !row.jobId)
    return null;
  const [summary] = await tx
    .select({
      id: interviewSummariesTable.id,
      revision: sql<string>`interview_summaries.xmin::text`,
    })
    .from(interviewSummariesTable)
    .innerJoin(
      interviewSessionsTable,
      eq(interviewSessionsTable.id, interviewSummariesTable.interviewSessionId),
    )
    .where(
      and(
        eq(interviewSessionsTable.id, session.id),
        eq(interviewSessionsTable.tenantId, row.tenantId),
      ),
    )
    .for("share");
  if (!summary) return null;
  const [source] = await tx
    .select({ evaluation: candidateEvaluationsTable, revision: sql<string>`xmin::text` })
    .from(candidateEvaluationsTable)
    .where(
      and(
        eq(candidateEvaluationsTable.tenantId, row.tenantId),
        eq(candidateEvaluationsTable.jobId, row.jobId),
        eq(candidateEvaluationsTable.candidateId, bound.candidate.id),
      ),
    )
    .for("share");
  const report = source && qorEvidence(source.evaluation, session.id);
  if (!report) return { report: null, reviewHash: null };
  return {
    report,
    reviewHash: qorFingerprint({
      request: row.id,
      session: session.id,
      completedAt: session.completedAt,
      summary,
      source,
      report,
    }),
  };
}

export async function recordQorReport(
  tx: QorTransaction,
  bound: Bound,
  userId: string,
  expectedVersion: number,
  reviewHash: string | null,
) {
  const { row } = bound;
  if (reviewHash) {
    const preview = await qorReportReview(tx, bound);
    if (!preview?.report || preview.reviewHash !== reviewHash)
      throw qorConflict("The approved evidence changed. Review the current QOR report.");
    if (
      row.reportHash === reviewHash &&
      row.reportApprovedAt &&
      row.reportVersion === expectedVersion + 1
    )
      return;
    if (row.reportVersion !== expectedVersion)
      throw qorConflict("The QOR approval changed. Review again.");
    await tx
      .update(requests)
      .set({
        reportHash: reviewHash,
        reportVersion: row.reportVersion + 1,
        reportApprovedAt: new Date(),
        reportApprovedBy: userId,
      })
      .where(scoped(row.tenantId, row.id));
  } else if (row.reportApprovedAt) {
    if (row.reportVersion !== expectedVersion)
      throw qorConflict("The QOR approval changed. Review again.");
    await tx
      .update(requests)
      .set({
        reportHash: null,
        reportApprovedAt: null,
        reportApprovedBy: null,
        reportVersion: row.reportVersion + 1,
      })
      .where(scoped(row.tenantId, row.id));
  }
}

export async function qorStatus(
  tx: QorTransaction,
  initial: Row,
  bound: Bound | null,
): Promise<QorInterviewStatus> {
  const row = bound?.row ?? initial;
  const session = bound?.session ?? null;
  const interview = qorSessionStatus(session, !!row.sessionId);
  const preview = bound && (await qorReportReview(tx, bound));
  const report =
    preview?.report && row.reportHash === preview.reviewHash && row.reportApprovedAt
      ? { ...preview.report, version: row.reportVersion, approvedAt: row.reportApprovedAt }
      : null;
  let reportStatus: QorInterviewStatus["reportStatus"] = "not_ready";
  if (report) reportStatus = "approved";
  else if (row.reportVersion > 0) reportStatus = "withdrawn";
  else if (interview === "needs_attention") reportStatus = "needs_attention";
  else if (preview) reportStatus = "awaiting_review";
  else if (interview === "completed" && session) {
    const [failed] = await tx
      .select({ id: aiJobsTable.id })
      .from(aiJobsTable)
      .where(
        and(
          eq(aiJobsTable.tenantId, row.tenantId),
          eq(aiJobsTable.interviewSessionId, session.id),
          eq(aiJobsTable.type, "summarize_interview"),
          eq(aiJobsTable.status, "failed"),
        ),
      )
      .limit(1);
    reportStatus = failed ? "needs_attention" : "processing";
  }
  return {
    requestId: row.id,
    externalApplicationId: row.externalApplicationId!,
    invitation: {
      status: row.invitationReportedAt
        ? "staff_reported_sent"
        : row.invitationReleasedAt &&
            bound?.session?.status === "scheduled" &&
            jobReadyForQor(bound.job, row)
          ? "ready_to_share"
          : "not_sent",
      reportedAt: row.invitationReportedAt,
    },
    interview: { status: interview, completedAt: session?.completedAt ?? null },
    reportStatus,
    report,
  };
}
