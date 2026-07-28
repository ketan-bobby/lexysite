/**
 * record-terminal-outcome.ts — Auto-capture of terminal pipeline outcomes
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * When an application reaches a terminal stage (hired, rejected, withdrawn, or
 * ghosted/no-show), the recruiter no longer has to log the outcome by hand:
 * every terminal transition routes through recordTerminalOutcome(), which:
 *   1. Upserts the application's `candidate_outcomes` row, stamping the terminal
 *      `outcome` + `outcome_at` (and `hire_date` for hires).
 *   2. Best-effort mirrors the label onto candidate_job_intelligence.outcome so
 *      the learning loop has a label for every closed application — NOT just the
 *      ones a recruiter remembered to mark.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * Keyed on applicationId — one outcome row per application. Re-running the same
 * terminal transition updates the existing row in place (no duplicates). If the
 * row already carries the same terminal `outcome`, the write is a no-op.
 *
 * ─── Best-effort design ──────────────────────────────────────────────────────
 * Never throws. A failed capture is logged loudly but the caller's stage update
 * still goes through. Callers should fire-and-forget.
 */
import { db } from "@workspace/db";
import { candidateOutcomesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { recordOutcome } from "./intelligence.js";

export type TerminalOutcome = "hired" | "rejected" | "withdrawn" | "ghosted";

/** Terminal labels that have a matching candidate_job_intelligence enum value. */
const INTELLIGENCE_OUTCOME: Partial<Record<TerminalOutcome, "hired" | "rejected" | "ghosted">> = {
  hired: "hired",
  rejected: "rejected",
  ghosted: "ghosted",
  // `withdrawn` has no hiring_outcome enum value — captured on candidate_outcomes only.
};

export interface RecordTerminalOutcomeInput {
  tenantId: string;
  applicationId: string;
  candidateId: string;
  jobId: string;
  outcome: TerminalOutcome;
  /** For hires — defaults to now() when omitted. */
  hireDate?: Date | null;
  /** Provenance label stored on outcomeSource for new rows (e.g. "auto:reject"). */
  source?: string | null;
}

/**
 * Persist the terminal outcome for an application. Idempotent + best-effort.
 */
export async function recordTerminalOutcome(input: RecordTerminalOutcomeInput): Promise<void> {
  const { tenantId, applicationId, candidateId, jobId, outcome } = input;
  if (!applicationId || !candidateId || !jobId) {
    logger.debug({ applicationId, candidateId, jobId, outcome },
      "[terminal-outcome] missing ids — skipping capture");
    return;
  }

  try {
    const [existing] = await db
      .select({ id: candidateOutcomesTable.id, outcome: candidateOutcomesTable.outcome })
      .from(candidateOutcomesTable)
      .where(eq(candidateOutcomesTable.applicationId, applicationId))
      .limit(1);

    const now = new Date();
    const hireDate = outcome === "hired" ? (input.hireDate ?? now) : undefined;

    if (existing) {
      if (existing.outcome === outcome) {
        // Already captured with the same terminal label — nothing to do.
        return;
      }
      await db
        .update(candidateOutcomesTable)
        .set({
          outcome,
          outcomeAt: now,
          ...(hireDate ? { hireDate } : {}),
          updatedAt: now,
        })
        .where(eq(candidateOutcomesTable.id, existing.id));
    } else {
      // Atomic insert; the unique index on application_id makes a concurrent
      // insert resolve to an UPDATE instead of a duplicate row (or a 23505).
      await db.insert(candidateOutcomesTable).values({
        id: crypto.randomUUID(),
        tenantId,
        applicationId,
        candidateId,
        jobId,
        outcome,
        outcomeAt: now,
        ...(hireDate ? { hireDate } : {}),
        outcomeSource: input.source ?? "auto",
      }).onConflictDoUpdate({
        target: candidateOutcomesTable.applicationId,
        set: { outcome, outcomeAt: now, ...(hireDate ? { hireDate } : {}), updatedAt: now },
      });
    }

    logger.info({ applicationId, candidateId, jobId, outcome }, "[terminal-outcome] captured");
  } catch (err) {
    logger.error({ err, applicationId, outcome },
      "[terminal-outcome] failed to capture outcome (non-fatal)");
  }

  // Best-effort mirror onto the learning label. recordOutcome is a no-op when no
  // intelligence row exists for the (job, candidate) pair, which is fine.
  const intelOutcome = INTELLIGENCE_OUTCOME[outcome];
  if (intelOutcome) {
    try {
      await recordOutcome(jobId, candidateId, intelOutcome);
    } catch (err) {
      logger.warn({ err, jobId, candidateId, outcome },
        "[terminal-outcome] failed to mirror learning label (non-fatal)");
    }
  }
}
