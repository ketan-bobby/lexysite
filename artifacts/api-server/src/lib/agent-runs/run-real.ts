/**
 * lib/agent-runs/run-real.ts — REAL work-order sourcing run
 *
 * The production counterpart of `simulateSourcingRun`: it emits the SAME
 * durable event sequence (analyzing → searching → screening → ranking →
 * shortlist) over the agent_runs / agent_run_events stream, but every number is
 * grounded in the real sourcing engine:
 *
 *   • Discovery goes through the provider adapter layer
 *     (lib/sourcing-providers.ts — two-phase PDL/SERP/GitHub/EnrichLayer) plus
 *     the internal tenant-pool search (routes/sourcing.ts
 *     searchInternalDatabase, the firewalled chokepoint).
 *   • Scoring is the LLM/ICP scorer (`scoreExternalCandidates`) against the
 *     job's latest ICP version — the same scorer /sourcing/search uses — so the
 *     match score a recruiter sees on a run-sourced candidate is genuine.
 *   • Persistence mirrors POST /sourcing/search: shared dedup
 *     (findExistingCandidate), sourced_candidates rawData with
 *     matchScore/matchReason, a sourced-stage application row with
 *     ai_sourcing origin attribution, and a candidate_job_intelligence row
 *     seeded from the REAL score.
 *
 * The internal-first gate (review-your-own-bench-before-external-spend) is
 * enforced by the ROUTE before the run row is created — by the time this
 * function executes, spend is authorized.
 *
 * Runs fire-and-forget after the HTTP response, so writes use dbAdmin with
 * explicit tenant_id (same rule as recorder.ts / simulate.ts). Cancellation is
 * polled between stages and between per-candidate persists.
 */
import {
  dbAdmin,
  candidatesTable,
  applicationsTable,
  jobsTable,
  icpTable,
  sourcedCandidatesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { emitRunEvent, updateRunSummary, completeAgentRun, isRunCancelled } from "./recorder";
import { logger } from "../logger";
import { upsertIntelligence } from "../intelligence";
import { runSourcingProviders } from "../sourcing-providers.js";
import { scoreExternalCandidates, classifyLocationMatches } from "../external-sourcing.js";
import { findExistingCandidate } from "../candidate-dedup.js";
import { originFields } from "../sourcing-origin";
import { buildSearchContext, searchInternalDatabase } from "../../routes/sourcing";

/** Sentinel thrown to unwind the run when a recruiter cancels. */
class RunCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelledError";
  }
}

export interface RealRunOptions {
  /** Max number of top-scored candidates persisted into the pipeline. */
  shortlistSize?: number;
  /**
   * Injectable pipeline dependencies — TEST ONLY. Production callers omit
   * this and get the real provider registry / LLM scorer / geo classifier.
   */
  deps?: {
    runProviders?: typeof runSourcingProviders;
    scoreCandidates?: typeof scoreExternalCandidates;
    classifyLocations?: typeof classifyLocationMatches;
    searchInternal?: typeof searchInternalDatabase;
  };
}

/**
 * sourced_candidates.source is a Postgres ENUM (candidate_source) that does
 * NOT include every provider id (e.g. "enrichlayer"). Map non-enum sources to
 * their nearest enum value so the insert never fails silently; the raw
 * provider id is preserved in rawData.source and candidates.source (free text).
 */
const SOURCED_ENUM_VALUES = new Set([
  "pdl",
  "serp",
  "github",
  "linkedin",
  "internal",
  "manual",
  "referral",
]);
function toSourcedEnum(
  source: unknown,
): "pdl" | "serp" | "github" | "linkedin" | "internal" | "manual" | "referral" {
  const s = typeof source === "string" ? source.toLowerCase() : "";
  if (SOURCED_ENUM_VALUES.has(s)) return s as any;
  if (s === "enrichlayer") return "linkedin"; // EnrichLayer enriches LinkedIn profiles
  return "manual";
}

export async function runRealSourcingRun(
  run: { id: string; tenantId: string; workOrderId: string },
  opts: RealRunOptions = {},
): Promise<void> {
  const shortlistSize = Math.min(Math.max(opts.shortlistSize ?? 8, 1), 25);
  const tenantId = run.tenantId;
  const jobId = run.workOrderId;
  const runProviders = opts.deps?.runProviders ?? runSourcingProviders;
  const scoreCandidates = opts.deps?.scoreCandidates ?? scoreExternalCandidates;
  const classifyLocations = opts.deps?.classifyLocations ?? classifyLocationMatches;
  const searchInternal = opts.deps?.searchInternal ?? searchInternalDatabase;

  const checkpoint = async () => {
    if (await isRunCancelled(run.id)) throw new RunCancelledError();
  };

  // Serialized, fire-and-forget progress emitter. Provider fan-out callbacks
  // fire concurrently, but emitRunEvent computes seq = MAX+1 in-statement —
  // concurrent emits would collide on UNIQUE(run_id, seq) and silently drop.
  // Chaining through one promise keeps emits sequential without blocking the
  // fan-out; failures are logged and never break the run.
  let progressChain: Promise<void> = Promise.resolve();
  const emitProgress = (stepName: string, message: string, count?: number) => {
    progressChain = progressChain
      .then(() => emitRunEvent(run, { type: "step_progress", stepName, message, count }))
      .catch((err) => {
        logger.warn({ err, runId: run.id }, "[agent-runs] progress emit failed — continuing");
      });
  };
  // Lifecycle events (step_started/completed, run_completed/failed) must never
  // race a queued progress emit — a concurrent MAX(seq)+1 collides on
  // UNIQUE(run_id, seq) and one event is silently dropped. Fence behind the
  // progress chain so every write for this run is strictly sequential.
  const emitSequenced = async (evt: Parameters<typeof emitRunEvent>[1]) => {
    await progressChain;
    await emitRunEvent(run, evt);
  };

  try {
    // ── Stage 1: Analyzing requirements (load job + latest ICP) ─────────────
    await emitSequenced({
      type: "step_started",
      stepName: "analyzing",
      message: "Analyzing work order requirements",
    });
    const [job] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) throw new Error("Work order not found");
    const [icp] = await dbAdmin
      .select()
      .from(icpTable)
      .where(eq(icpTable.jobId, jobId))
      .orderBy(desc(icpTable.version))
      .limit(1);

    // Same context builder as /sourcing/search: ICP location is first-class
    // (cleared = no preference), workType comes from the job, languages from
    // the ICP when present. Search wide, then shortlist narrow.
    const maxPerSource = Math.max(15, shortlistSize);
    const ctx = buildSearchContext(job, icp || null, maxPerSource);
    await checkpoint();
    await emitSequenced({
      type: "step_completed",
      stepName: "analyzing",
      message: icp
        ? `Requirements parsed — searching against the ideal candidate profile (v${(icp as any).version ?? 1})`
        : "No ICP on file — searching on job title and skills",
    });

    // ── Stage 2: Searching (internal bench + external providers) ────────────
    await emitSequenced({
      type: "step_started",
      stepName: "searching",
      message: "Searching internal bench and external candidate sources",
      count: 0,
    });
    // Internal search reads via dbAdmin (fire-and-forget context) but stays
    // scoped to the job's tenant AND pool='tenant' inside the chokepoint.
    const [internalRes, providerResults] = await Promise.all([
      searchInternal(ctx, tenantId, dbAdmin as any)
        .then((r: any) => {
          emitProgress(
            "searching",
            `Internal bench: ${r.candidates.length} matching candidate${r.candidates.length === 1 ? "" : "s"}`,
            r.candidates.length,
          );
          return r;
        })
        .catch((err: unknown) => {
          logger.warn({ err }, "[agent-runs] internal search failed — continuing external-only");
          emitProgress(
            "searching",
            "Internal bench search failed — continuing with external sources",
          );
          return { candidates: [] as any[], query: "internal: failed" };
        }),
      // allowSimulatedFallback:false — a real run must NEVER persist
      // fabricated people; a keyless provider reports skipped/empty instead.
      runProviders(ctx, {
        allowSimulatedFallback: false,
        // Live per-provider progress so a minutes-long fan-out isn't a silent gap.
        onProviderEvent: (e) => {
          if (e.phase === "started") {
            emitProgress("searching", `Searching ${e.label}…`);
          } else if (e.skipped) {
            emitProgress("searching", `${e.label}: skipped — ${e.skipped}`);
          } else {
            emitProgress(
              "searching",
              `${e.label}: ${e.count ?? 0} profile${(e.count ?? 0) === 1 ? "" : "s"} found`,
              e.count,
            );
          }
        },
      }),
    ]);
    // Let any queued progress emits land before the stage-completed event so
    // the stream stays chronological.
    await progressChain;
    const externalAll = [
      ...providerResults.github.candidates,
      ...providerResults.pdl.candidates,
      ...providerResults.serp.candidates,
      ...providerResults.enrichlayer.candidates,
      // Defense in depth: drop anything tagged simulated regardless of origin.
    ].filter((c: any) => !(c?.rawData?.simulated || c?.simulated));
    const found = internalRes.candidates.length + externalAll.length;
    await checkpoint();
    await emitSequenced({
      type: "step_completed",
      stepName: "searching",
      message: `Found ${found} candidate profiles (${internalRes.candidates.length} internal, ${externalAll.length} external)`,
      count: found,
      payload: {
        bySource: {
          internal: internalRes.candidates.length,
          github: providerResults.github.candidates.length,
          pdl: providerResults.pdl.candidates.length,
          serp: providerResults.serp.candidates.length,
          enrichlayer: providerResults.enrichlayer.candidates.length,
        },
      },
    });
    await updateRunSummary(run.id, { found });

    // ── Stage 3: Screening (LLM/ICP scoring + DNC filter) ────────────────────
    await emitSequenced({
      type: "step_started",
      stepName: "screening",
      message: icp
        ? `Scoring ${externalAll.length} external profiles against the ideal candidate profile`
        : `Screening ${externalAll.length} external profiles (no ICP — provider scores stand)`,
      count: externalAll.length,
    });
    if (icp && externalAll.length > 0) {
      emitProgress(
        "screening",
        `AI is scoring ${externalAll.length} profiles against the ideal candidate profile — this can take a minute`,
        externalAll.length,
      );
    }
    const externalScored =
      icp && externalAll.length > 0
        ? await scoreCandidates(externalAll as any[], icp as any)
        : externalAll;
    if (icp && externalAll.length > 0) {
      emitProgress("screening", "AI scoring complete — applying do-not-contact filter");
    }

    // DNC filter: never surface a candidate the tenant marked do-not-contact.
    const dncRows = await dbAdmin
      .select({ email: candidatesTable.email })
      .from(candidatesTable)
      .where(
        and(
          eq(candidatesTable.tenantId, tenantId),
          eq((candidatesTable as any).doNotContact, true),
        ),
      )
      .catch(() => [] as { email: string | null }[]);
    const dncEmails = new Set(
      dncRows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean),
    );
    const screened = (externalScored as any[]).filter((c) => {
      const e = (c?.email ?? "").trim().toLowerCase();
      return !(e !== "" && dncEmails.has(e));
    });
    await checkpoint();
    await emitSequenced({
      type: "step_completed",
      stepName: "screening",
      message: `${screened.length} candidates scored against requirements`,
      count: screened.length,
    });
    await updateRunSummary(run.id, { screened: screened.length });

    // ── Stage 4: Ranking (score desc) + geo flags for the shortlist ─────────
    await emitSequenced({
      type: "step_started",
      stepName: "ranking",
      message: "Ranking candidates by fit",
    });
    const ranked = [...screened].sort(
      (a: any, b: any) => (b.matchScore ?? 0) - (a.matchScore ?? 0),
    );
    const shortlist = ranked.slice(0, shortlistSize);

    // Geo flag the shortlist only (one batched model call) so location honesty
    // is stored in rawData like /sourcing/search does.
    emitProgress("ranking", `Verifying locations for the top ${shortlist.length} candidates`);
    const locResults = await classifyLocations(
      shortlist.map((c: any, i: number) => ({ id: String(i), location: c.location })),
      ctx.location,
    ).catch(() => new Map());
    const shortlistFlagged = shortlist.map((c: any, i: number) => {
      const r = (locResults as Map<string, any>).get(String(i)) || { match: "unknown", flag: null };
      return { ...c, locationMatch: r.match, locationFlag: r.flag };
    });
    await checkpoint();
    await emitSequenced({
      type: "step_completed",
      stepName: "ranking",
      message: "Candidates ranked",
    });

    // ── Stage 5: Shortlist — persist real candidates with real scores ────────
    await emitSequenced({
      type: "step_started",
      stepName: "shortlist",
      message: `Preparing shortlist — top ${shortlistFlagged.length}`,
      count: shortlistFlagged.length,
    });
    const createdIds = await persistShortlist({
      run,
      tenantId,
      jobId,
      candidates: shortlistFlagged,
      checkpoint,
    });

    await emitSequenced({
      type: "step_completed",
      stepName: "shortlist",
      message: `Shortlist ready — top ${createdIds.length} candidates added to the pipeline`,
      count: createdIds.length,
      payload: { candidateIds: createdIds },
    });
    await updateRunSummary(run.id, { shortlisted: createdIds.length });

    await checkpoint();
    await emitSequenced({
      type: "run_completed",
      stepName: "shortlist",
      message: `Sourcing complete — ${createdIds.length} candidates shortlisted from ${found} sourced`,
      count: createdIds.length,
    });
    await completeAgentRun(run.id, "completed");
  } catch (err: any) {
    if (err instanceof RunCancelledError) {
      logger.info({ runId: run.id }, "[agent-runs] runRealSourcingRun cancelled");
      return;
    }
    logger.error({ err }, "[agent-runs] runRealSourcingRun failed");
    await emitSequenced({
      type: "run_failed",
      message: `Sourcing run failed: ${err?.message || "unknown error"}`,
    });
    await completeAgentRun(run.id, "failed", String(err?.message || err));
  }
}

/**
 * Persist the scored shortlist, mirroring POST /sourcing/search:
 * dedup via findExistingCandidate → candidates row (real provider source,
 * genuine talentMatchScore) → sourced_candidates rawData (matchScore/Reason,
 * geo flags) → sourced-stage application with ai_sourcing origin → intelligence
 * row seeded from the REAL score. Each row is best-effort and checkpointed.
 */
async function persistShortlist(args: {
  run: { id: string; tenantId: string; workOrderId: string };
  tenantId: string;
  jobId: string;
  candidates: any[];
  checkpoint: () => Promise<void>;
}): Promise<string[]> {
  const { run, tenantId, jobId, candidates, checkpoint } = args;
  const created: string[] = [];

  for (const c of candidates) {
    // Outside the try below so cancellation unwinds instead of being swallowed.
    await checkpoint();
    try {
      const matchScore: number | null =
        typeof c.matchScore === "number" ? Math.round(c.matchScore * 10) / 10 : null;
      const realEmail =
        typeof c.email === "string" &&
        c.email.trim() &&
        !c.email.trim().toLowerCase().endsWith("@unknown.local") &&
        !c.email.trim().toLowerCase().endsWith("@import.local")
          ? c.email.trim().toLowerCase()
          : "";

      // Shared identity resolution (LinkedIn → email → phone → name+location)
      // so a re-run or a previously imported person never duplicates.
      let candidateId: string | null = null;
      const existing: any = await findExistingCandidate({
        tenantId,
        email: realEmail || c.email,
        phone: c.phone,
        linkedinUrl: c.linkedinUrl,
        firstName: c.firstName,
        lastName: c.lastName,
        location: c.location,
      }).catch(() => null);
      if (existing) {
        candidateId = existing.id;
        // Keep the score fresh on re-source — the ICP may have changed.
        if (matchScore != null) {
          await dbAdmin
            .update(candidatesTable)
            .set({ talentMatchScore: matchScore, updatedAt: new Date() } as any)
            .where(eq(candidatesTable.id, existing.id))
            .catch(() => undefined);
        }
      } else {
        const [inserted] = await dbAdmin
          .insert(candidatesTable)
          .values({
            tenantId,
            firstName: c.firstName || "Unknown",
            lastName: c.lastName || "",
            // email is NOT NULL — placeholder when the source had none.
            email:
              realEmail ||
              `sourced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unknown.local`,
            location: c.location || null,
            currentTitle: c.currentTitle || null,
            currentCompany: c.currentCompany || null,
            linkedinUrl: c.linkedinUrl || null,
            githubUrl: c.githubProfile || null,
            skills: c.skills || [],
            source: c.source || "sourcing_agent",
            talentMatchScore: matchScore,
          })
          .returning({ id: candidatesTable.id })
          .catch(() => [null as any]);
        candidateId = inserted?.id ?? null;
      }
      if (!candidateId) continue;

      // sourced_candidates row (global per normalized candidate — same rule as
      // /sourcing/search): carries the REAL score + reason + geo flag.
      try {
        const [already] = await dbAdmin
          .select({ id: sourcedCandidatesTable.id })
          .from(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.normalizedCandidateId, candidateId))
          .limit(1);
        if (!already) {
          await dbAdmin.insert(sourcedCandidatesTable).values({
            tenantId,
            source: toSourcedEnum(c.source),
            rawData: {
              ...c,
              jobId,
              matchScore: c.matchScore,
              matchReason: c.matchReason,
              runId: run.id,
            },
            normalizedCandidateId: candidateId,
            mergeConfidence: matchScore != null ? matchScore / 100 : null,
          });
        }
      } catch {
        /* best-effort */
      }

      // Job-scoped sourced-stage application (dedup on candidate+job). Written
      // at 'sourced' so no downstream automation fires; origin = ai_sourcing.
      try {
        const [existingApp] = await dbAdmin
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(eq(applicationsTable.candidateId, candidateId), eq(applicationsTable.jobId, jobId)),
          )
          .limit(1);
        if (!existingApp) {
          await dbAdmin.insert(applicationsTable).values({
            tenantId,
            jobId,
            candidateId,
            stage: "sourced",
            matchScore,
            ...originFields(
              "ai_sourcing",
              { source: c.source, jobId, via: "agent_run", runId: run.id, matchScore },
              "sourcing_agent",
            ),
          } as any);
        }
      } catch {
        /* best-effort: never block the run on app-row creation */
      }

      created.push(candidateId);

      // Intelligence row seeded from the REAL score so the Decision Queue's
      // run view surfaces the shortlist (queue reads intelligence rows only).
      try {
        await upsertIntelligence(tenantId, jobId, candidateId, {
          sourcing: {
            sourceType: c.source || "sourcing_agent",
            sourceConfidence: matchScore ?? undefined,
          },
          screening:
            matchScore != null
              ? { resumeMatchScore: matchScore, skillMatchScore: matchScore, score: matchScore }
              : undefined,
        } as any);
      } catch (err) {
        logger.warn({ err, candidateId }, "[agent-runs] shortlist intelligence seed failed");
      }

      await emitRunEvent(run, {
        type: "step_progress",
        stepName: "shortlist",
        message: `Adding candidates to the pipeline — ${created.length}/${candidates.length}`,
        count: created.length,
        payload: { candidateIds: [...created] },
      });
      await updateRunSummary(run.id, { shortlisted: created.length });
    } catch (err) {
      if (err instanceof RunCancelledError) throw err;
      logger.error({ err }, "[agent-runs] persistShortlist row failed");
    }
  }

  return created;
}
