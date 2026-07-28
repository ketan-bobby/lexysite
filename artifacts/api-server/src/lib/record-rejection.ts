/**
 * record-rejection.ts — Canonical Rejection Bookkeeping Helper
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Every code path that rejects a candidate (application PUT, recruiter button,
 * log_reply classification, system auto-reject) routes through recordRejection().
 * It resolves all context needed for the email and the audit row, then:
 *   1. Optionally fires the candidate-facing rejection email (via candidate-rejection-email.ts)
 *   2. Persists a row in candidate_rejections for compliance/audit
 *
 * ─── Context resolution cascade ──────────────────────────────────────────────
 * The function resolves candidate email + name from whichever IDs the caller
 * provides, in this precedence order:
 *   applicationId → applications → candidateId
 *   sourcedId     → sourced_candidates.rawData → normalizedCandidateId
 *   candidateId   → candidates
 *   jobId         → jobs.title
 *   tenantId      → tenants.name (company name for email copy)
 *
 * This cascade means every caller only needs to pass the IDs it already has
 * and the function fills in the rest. Language is resolved the same way.
 *
 * ─── Best-effort design ──────────────────────────────────────────────────────
 * Never throws. A failed rejection persist is logged loudly but the caller's
 * stage update still goes through. emailOk and emailError in the return value
 * let callers surface partial failures without crashing the request.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/applications.ts   — application PATCH status=rejected
 *   routes/pipeline.ts       — sourced candidate reject button
 *   routes/outreach.ts       — log_reply with classification=not_interested
 *   lib/outreach-engine.ts   — classifyReply() DNC handling
 */
import { db } from "@workspace/db";
import { candidateRejectionsTable, candidatesTable, jobsTable, tenantsTable, sourcedCandidatesTable, applicationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { sendCandidateRejectionEmail } from "./candidate-rejection-email.js";

export interface RecordRejectionInput {
  tenantId: string;
  jobId?: string | null;
  applicationId?: string | null;
  sourcedId?: string | null;
  candidateId?: string | null;
  rejectedByUserId?: string | null;
  rejectedByRole: "recruiter" | "hiring_manager" | "system";
  reason?: string | null;
  notes?: string | null;
  fromStage?: string | null;
  language?: string | null;
  sendEmail?: boolean;
}

export interface RecordRejectionResult {
  rejectionId: string;
  emailOk: boolean | null;
  emailError?: string | null;
}

/**
 * Persist a rejection record AND (optionally) fire the candidate-facing
 * sophisticated rejection email. Centralises the bookkeeping so every
 * rejection path — application-PUT, log_reply, explicit reject button —
 * produces identical audit data.
 *
 * Best-effort: failures are logged but the function still returns a
 * record so callers can continue.
 */
export async function recordRejection(input: RecordRejectionInput): Promise<RecordRejectionResult> {
  /* Resolve candidate + job + tenant context for both the record and the
   * email. We try the cheapest lookups first and fall back as needed. */
  let candidateEmail: string | null = null;
  let candidateFirstName: string | null = null;
  let candidateName: string | null = null;
  let jobTitle: string | null = null;
  let companyName: string | null = null;
  let resolvedLanguage = input.language ?? "en";
  let resolvedCandidateId = input.candidateId ?? null;

  try {
    if (input.applicationId && !resolvedCandidateId) {
      const [app] = await db.select().from(applicationsTable)
        .where(eq(applicationsTable.id, input.applicationId)).limit(1);
      if (app) resolvedCandidateId = app.candidateId;
    }
    if (input.sourcedId) {
      const [sc] = await db.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.id, input.sourcedId)).limit(1);
      if (sc) {
        if (!resolvedCandidateId && sc.normalizedCandidateId) resolvedCandidateId = sc.normalizedCandidateId;
        const raw: any = sc.rawData ?? {};
        candidateFirstName = candidateFirstName ?? raw?.firstName ?? null;
        candidateName = candidateName ?? (`${raw?.firstName ?? ""} ${raw?.lastName ?? ""}`.trim() || raw?.name || null);
        candidateEmail = candidateEmail ?? raw?.email ?? null;
        if (!input.language && raw?.preferredLanguage) resolvedLanguage = raw.preferredLanguage;
      }
    }
    if (resolvedCandidateId) {
      const [c] = await db.select().from(candidatesTable)
        .where(eq(candidatesTable.id, resolvedCandidateId)).limit(1);
      if (c) {
        candidateEmail = candidateEmail ?? c.email ?? null;
        candidateFirstName = candidateFirstName ?? c.firstName ?? null;
        candidateName = candidateName ?? (`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email || null);
        if (!input.language && (c as any).preferredLanguage) resolvedLanguage = (c as any).preferredLanguage;
      }
    }
    if (input.jobId) {
      const [j] = await db.select().from(jobsTable)
        .where(eq(jobsTable.id, input.jobId)).limit(1);
      if (j) jobTitle = j.title ?? null;
    }
    if (input.tenantId) {
      const [t] = await db.select().from(tenantsTable)
        .where(eq(tenantsTable.id, input.tenantId)).limit(1);
      if (t) companyName = t.name ?? null;
    }
  } catch (err) {
    logger.warn({ err }, "recordRejection: context lookup failed (non-fatal)");
  }

  /* Fire the email (when requested) BEFORE persisting so we can record
   * the outcome on the rejection row itself. */
  let emailOk: boolean | null = null;
  let emailError: string | null = null;
  if (input.sendEmail !== false && candidateEmail) {
    try {
      const r = await sendCandidateRejectionEmail({
        to: candidateEmail,
        candidateFirstName,
        candidateFullName: candidateName ?? candidateEmail,
        jobTitle,
        companyName,
        language: resolvedLanguage,
        tenantId: input.tenantId,
        candidateId: resolvedCandidateId,
        rejectedBy: input.rejectedByRole,
        metadata: {
          reason: input.reason ?? null,
          fromStage: input.fromStage ?? null,
          jobId: input.jobId ?? null,
          applicationId: input.applicationId ?? null,
          sourcedId: input.sourcedId ?? null,
        },
      });
      emailOk = !!r.ok;
      emailError = r.error ?? r.skipped ?? null;
    } catch (err: any) {
      emailOk = false;
      emailError = err?.message ?? String(err);
    }
  }

  /* Persist the audit record. We never throw — if even this fails we log
   * loudly and return a best-effort result so the caller's stage update
   * still goes through. */
  let rejectionId = "";
  try {
    const [row] = await db.insert(candidateRejectionsTable).values({
      tenantId: input.tenantId,
      candidateId: resolvedCandidateId,
      sourcedId: input.sourcedId ?? null,
      applicationId: input.applicationId ?? null,
      jobId: input.jobId ?? null,
      rejectedByUserId: input.rejectedByUserId ?? null,
      rejectedByRole: input.rejectedByRole,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      fromStage: input.fromStage ?? null,
      language: resolvedLanguage,
      emailSent: emailOk === true,
      emailError,
      candidateEmail,
      candidateName,
      jobTitle,
      metadata: {},
    }).returning({ id: candidateRejectionsTable.id });
    rejectionId = row?.id ?? "";
  } catch (err) {
    logger.error({ err }, "recordRejection: failed to persist rejection row");
  }

  return { rejectionId, emailOk, emailError };
}
