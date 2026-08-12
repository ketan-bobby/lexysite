/**
 * lib/agent-runs/simulate.ts — Simulated sourcing run
 *
 * When there is no live external sourcing to observe (e.g. a demo, or providers
 * are quiet), `simulateSourcingRun` produces a realistic ~20s sequence of the
 * SAME events the real pipeline emits:
 *
 *   Analyzing work order requirements
 *   → Searching candidate pools   (progress counting up to ~214 found)
 *   → Screening against requirements (214 → 31 pass)
 *   → Ranking candidates
 *   → Shortlist ready (top N)
 *
 * It also creates REAL candidate + application records marked
 * source = "agent_simulated" so the rest of the app (pipeline, funnel,
 * approvals) populates truthfully. The UI shows a small "Demo run" badge on the
 * run and on any candidate whose source is "agent_simulated".
 *
 * Runs fire-and-forget after the HTTP response, so all writes use the recorder
 * (dbAdmin) with explicit tenant_id.
 */
import { dbAdmin, candidatesTable, applicationsTable, jobsTable, icpTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { DEMO_EMAIL_DOMAIN } from "../demo-email";
import {
  emitRunEvent,
  updateRunSummary,
  completeAgentRun,
  isRunCancelled,
  type CreateRunInput,
} from "./recorder";
import { logger } from "../logger";
import { upsertIntelligence } from "../intelligence";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sentinel thrown to unwind the simulate loop when a recruiter cancels. */
class RunCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelledError";
  }
}

const FIRST_NAMES = [
  "Ava",
  "Liam",
  "Noah",
  "Maya",
  "Ethan",
  "Zoe",
  "Kai",
  "Priya",
  "Diego",
  "Lena",
  "Omar",
  "Sofia",
  "Nina",
  "Marcus",
  "Yuki",
  "Aria",
  "Ravi",
  "Elena",
  "Theo",
  "Isla",
];
const LAST_NAMES = [
  "Chen",
  "Patel",
  "Okafor",
  "Rossi",
  "Kim",
  "Nguyen",
  "Silva",
  "Haddad",
  "Novak",
  "Ibrahim",
  "Torres",
  "Larsson",
  "Mensah",
  "Costa",
  "Rahman",
  "Weiss",
  "Adeyemi",
  "Kowalski",
  "Duarte",
  "Fischer",
];
const TITLES = [
  "Senior Software Engineer",
  "Full-Stack Engineer",
  "Backend Engineer",
  "Frontend Engineer",
  "Staff Engineer",
  "Platform Engineer",
  "Product Engineer",
  "Engineering Lead",
];
const COMPANIES = [
  "Stripe",
  "Datadog",
  "Airbnb",
  "Shopify",
  "Cloudflare",
  "Notion",
  "Linear",
  "Vercel",
];
const SKILL_POOL = [
  "TypeScript",
  "React",
  "Node.js",
  "PostgreSQL",
  "GraphQL",
  "AWS",
  "Kubernetes",
  "Python",
  "Go",
  "System Design",
  "Distributed Systems",
  "CI/CD",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}
function sample(arr: string[], n: number, seed: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(arr[(seed + i * 3) % arr.length]);
  return Array.from(new Set(out));
}

export interface SimulateOptions {
  /** Number of shortlisted candidates to create as real records. */
  shortlistSize?: number;
}

/**
 * Kick off a simulated sourcing run. `run` must already be persisted (created by
 * the route with isSimulated=true) so the client has an id to poll immediately.
 */
export async function simulateSourcingRun(
  run: { id: string; tenantId: string; workOrderId: string },
  opts: SimulateOptions = {},
): Promise<void> {
  const shortlistSize = Math.min(Math.max(opts.shortlistSize ?? 8, 1), 25);
  const tenantId = run.tenantId;
  const jobId = run.workOrderId;

  // Resolve the work order's target location so the demo shortlist is
  // location-consistent with the role. Without this, simulated candidates were
  // pinned to a fixed US/EU pool and a location-specific role (e.g. "Telangana,
  // India") appeared to source "without any location constraint".
  const targetLocation = await resolveTargetLocation(jobId);

  // Between stages, bail out if a recruiter cancelled. Throwing unwinds to the
  // catch, which detects the sentinel and leaves the cancelled status intact.
  const checkpoint = async () => {
    if (await isRunCancelled(run.id)) throw new RunCancelledError();
  };

  try {
    // ── Stage 1: Analyzing requirements ──────────────────────────────────────
    await emitRunEvent(run, {
      type: "step_started",
      stepName: "analyzing",
      message: "Analyzing work order requirements",
    });
    await sleep(2200);
    await checkpoint();
    await emitRunEvent(run, {
      type: "step_completed",
      stepName: "analyzing",
      message: "Requirements parsed — building candidate search",
    });

    // ── Stage 2: Searching candidate pools (count up to ~214) ────────────────
    await emitRunEvent(run, {
      type: "step_started",
      stepName: "searching",
      message: "Searching candidate pools",
      count: 0,
    });
    const foundTarget = 214;
    const searchTicks = [40, 96, 152, 190, foundTarget];
    for (const found of searchTicks) {
      await sleep(1500);
      await checkpoint();
      await emitRunEvent(run, {
        type: "step_progress",
        stepName: "searching",
        message: `Searching candidate pools — ${found} profiles found`,
        count: found,
      });
    }
    await emitRunEvent(run, {
      type: "step_completed",
      stepName: "searching",
      message: `Found ${foundTarget} candidate profiles across pools`,
      count: foundTarget,
    });
    await updateRunSummary(run.id, { found: foundTarget });

    // ── Stage 3: Screening against requirements (214 → 31 pass) ──────────────
    await emitRunEvent(run, {
      type: "step_started",
      stepName: "screening",
      message: `Screening ${foundTarget} profiles against requirements`,
      count: foundTarget,
    });
    const passTarget = 31;
    const screenTicks = [140, 68, passTarget];
    for (const remaining of screenTicks) {
      await sleep(1600);
      await checkpoint();
      await emitRunEvent(run, {
        type: "step_progress",
        stepName: "screening",
        message: `Screening in progress — ${remaining} still passing`,
        count: remaining,
      });
    }
    await emitRunEvent(run, {
      type: "step_completed",
      stepName: "screening",
      message: `${passTarget} candidates passed screening`,
      count: passTarget,
    });
    await updateRunSummary(run.id, { screened: passTarget });

    // ── Stage 4: Ranking ─────────────────────────────────────────────────────
    await emitRunEvent(run, {
      type: "step_started",
      stepName: "ranking",
      message: "Ranking candidates by fit",
    });
    await sleep(2000);
    await checkpoint();
    await emitRunEvent(run, {
      type: "step_completed",
      stepName: "ranking",
      message: "Candidates ranked",
    });

    // ── Stage 5: Shortlist — create REAL candidate + application records ──────
    await emitRunEvent(run, {
      type: "step_started",
      stepName: "shortlist",
      message: `Preparing shortlist — top ${shortlistSize}`,
      count: shortlistSize,
    });
    await checkpoint();

    // Each candidate is checkpointed and recorded against the run AS it is
    // created (see below), so a Cancel mid-shortlist stops promptly and keeps
    // the candidates already produced, attributed to this (now partial) run.
    const createdIds = await createSimulatedShortlist({
      run,
      tenantId,
      jobId,
      count: shortlistSize,
      targetLocation,
      checkpoint,
    });

    await emitRunEvent(run, {
      type: "step_completed",
      stepName: "shortlist",
      message: `Shortlist ready — top ${createdIds.length} candidates added to the pipeline`,
      count: createdIds.length,
      payload: { candidateIds: createdIds },
    });
    await updateRunSummary(run.id, { shortlisted: createdIds.length });

    // Final gate: if a Cancel landed after the last candidate, unwind here so we
    // don't emit a misleading "Sourcing complete" event. completeAgentRun is
    // also status-guarded, so it can never overwrite a cancelled run.
    await checkpoint();
    await emitRunEvent(run, {
      type: "run_completed",
      stepName: "shortlist",
      message: `Sourcing complete — ${createdIds.length} candidates shortlisted from ${foundTarget} sourced`,
      count: createdIds.length,
    });
    await completeAgentRun(run.id, "completed");
  } catch (err: any) {
    // Cancellation unwinds through here — the cancel endpoint already emitted a
    // terminal event and set status=cancelled, so leave it untouched.
    if (err instanceof RunCancelledError) {
      logger.info({ runId: run.id }, "[agent-runs] simulateSourcingRun cancelled");
      return;
    }
    logger.error({ err }, "[agent-runs] simulateSourcingRun failed");
    await emitRunEvent(run, {
      type: "run_failed",
      message: `Sourcing run failed: ${err?.message || "unknown error"}`,
    });
    await completeAgentRun(run.id, "failed", String(err?.message || err));
  }
}

/** One demo candidate's placement: which stage, whether verified, and whether
 *  it deliberately lacks a real email. */
type DemoSlot = { stage: string; verified: boolean; noEmail: boolean };

/**
 * Build a deterministic, honest demo funnel spread for `count` candidates:
 *   • ~1 in Interview, roughly half in Outreach Queued (shortlisted), the rest
 *     split across Verification and Screening — never a wall of identical cards.
 *   • Outreach Queued / Interview rows are verified; earlier-stage rows are not.
 *   • EXACTLY TWO rows (when count allows) get NO real email and are pinned to a
 *     PRE-outreach stage, so the "Add email" guardrail is demonstrable and an
 *     unmessageable card can never land in Outreach Queued.
 */
function buildDemoPlan(count: number): DemoSlot[] {
  if (count <= 0) return [];
  const nInterview = count >= 6 ? 1 : 0;
  const nScreening = Math.max(1, Math.round(count * 0.2));
  const nVerification = Math.max(1, Math.round(count * 0.25));
  let nShortlisted = count - nInterview - nScreening - nVerification;
  if (nShortlisted < 0) nShortlisted = 0;

  const slots: DemoSlot[] = [];
  for (let i = 0; i < nScreening; i++)
    slots.push({ stage: "screening", verified: false, noEmail: false });
  for (let i = 0; i < nVerification; i++)
    slots.push({ stage: "verification", verified: false, noEmail: false });
  for (let i = 0; i < nShortlisted; i++)
    slots.push({ stage: "shortlisted", verified: true, noEmail: false });
  for (let i = 0; i < nInterview; i++)
    slots.push({ stage: "interview", verified: true, noEmail: false });

  // Rounding may over/undershoot; pad extras into Outreach Queued, then trim to
  // exactly `count`.
  while (slots.length < count) slots.push({ stage: "shortlisted", verified: true, noEmail: false });
  slots.length = count;

  // Pin the two no-email candidates onto pre-outreach slots (Screening first,
  // then Verification) so they can never be an unmessageable Outreach card.
  const preOutreachIdx = slots
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.stage === "screening" || s.stage === "verification")
    .map(({ idx }) => idx);
  for (const idx of preOutreachIdx.slice(0, 2)) {
    slots[idx].noEmail = true;
    slots[idx].verified = false;
  }
  return slots;
}

/**
 * Create real, demo-flagged candidates + applications so the pipeline, funnel and
 * approvals reflect the run. All rows are tenant-scoped and carry
 * source = "agent_simulated" (candidates) so the UI can badge them clearly.
 */
async function createSimulatedShortlist(args: {
  run: { id: string; tenantId: string; workOrderId: string };
  tenantId: string;
  jobId: string;
  count: number;
  targetLocation: string;
  checkpoint: () => Promise<void>;
}): Promise<string[]> {
  const { run, tenantId, jobId, count, targetLocation, checkpoint } = args;
  const created: string[] = [];
  const stamp = Date.now();

  // Demo-honesty distribution: instead of dumping every candidate straight into
  // "Outreach Queued" (which produced the "16 queued but unmessageable" report),
  // spread them realistically across the funnel and give MOST of them a send-safe
  // demo-domain email while leaving EXACTLY TWO with no real address at a
  // PRE-outreach stage — so a demo can show the "Add email" affordance and the
  // contact-email guardrail blocking a move to Outreach Queued.
  const plan = buildDemoPlan(count);

  for (let i = 0; i < count; i++) {
    // Stop promptly on Cancel. This runs OUTSIDE the try/catch below so the
    // RunCancelledError unwinds instead of being swallowed as a row failure —
    // candidates created so far are already committed and recorded (below), so
    // they survive as the partial run's output.
    await checkpoint();
    try {
      const first = pick(FIRST_NAMES, stamp + i);
      const last = pick(LAST_NAMES, stamp + i * 7);
      const slot = plan[i];
      // Email: MOST candidates get a send-safe demo-domain address (passes
      // isRealEmail + drafting, but hard-refused at the transport). The two
      // no-email slots get a collision-proof @unknown.local placeholder that
      // isRealEmail() rejects — they demonstrate the "Add email" guardrail.
      const email = slot.noEmail
        ? `demo-${stamp}-${i}@unknown.local`
        : `${first}.${last}.${stamp}-${i}@${DEMO_EMAIL_DOMAIN}`.toLowerCase();
      const matchScore = Math.round((92 - i * 3 + (i % 2)) * 10) / 10;

      const [cand] = await dbAdmin
        .insert(candidatesTable)
        .values({
          tenantId,
          firstName: first,
          lastName: last,
          email,
          location: demoLocation(targetLocation, i),
          currentTitle: pick(TITLES, stamp + i),
          currentCompany: pick(COMPANIES, stamp + i * 5),
          skills: sample(SKILL_POOL, 5, stamp + i),
          source: "agent_simulated",
          talentMatchScore: matchScore,
          verificationStatus: slot.verified ? "verified" : undefined,
        })
        .returning({ id: candidatesTable.id })
        .catch(() => [null as any]);

      if (!cand?.id) continue;

      // Link to the job so it appears on the pipeline / funnel / approvals.
      await dbAdmin
        .insert(applicationsTable)
        .values({
          tenantId,
          jobId,
          candidateId: cand.id,
          stage: slot.stage,
          matchScore,
        })
        .onConflictDoNothing()
        .catch(async () => {
          // If an application already exists (re-run against same candidate),
          // ignore — the candidate row is what matters for the demo.
          const existing = await dbAdmin
            .select({ id: applicationsTable.id })
            .from(applicationsTable)
            .where(
              and(eq(applicationsTable.jobId, jobId), eq(applicationsTable.candidateId, cand.id)),
            )
            .limit(1)
            .catch(() => []);
          return existing as any;
        });

      created.push(cand.id);

      // Seed an intelligence row so the run's shortlist actually surfaces on
      // the Decision Queue — the queue reads candidate_job_intelligence ONLY,
      // so an application row alone leaves the run view empty ("Queue Clear"
      // under an "8 candidates" banner). Best-effort: a scoring failure must
      // never sink the run.
      try {
        await upsertIntelligence(tenantId, jobId, cand.id, {
          sourcing: {
            sourceType: "agent_simulated",
            sourceConfidence: matchScore,
            profileCompleteness: slot.noEmail ? 60 : 85,
          },
          screening: {
            resumeMatchScore: matchScore,
            skillMatchScore: matchScore,
            score: matchScore,
          },
        });
      } catch (err) {
        logger.warn(
          { err, candidateId: cand.id },
          "[agent-runs] shortlist intelligence seed failed",
        );
      }

      // Record each produced candidate against the run AS it lands, so a Cancel
      // between iterations leaves the partial output attributed to this run
      // (payload carries the cumulative ids; summary tracks the running total).
      await emitRunEvent(run, {
        type: "step_progress",
        stepName: "shortlist",
        message: `Adding candidates to the pipeline — ${created.length}/${count}`,
        count: created.length,
        payload: { candidateIds: [...created] },
      });
      await updateRunSummary(run.id, { shortlisted: created.length });
    } catch (err) {
      logger.error({ err }, "[agent-runs] createSimulatedShortlist row failed");
    }
  }

  return created;
}

/**
 * Resolve the work order's target location for the demo shortlist. First-class
 * ICP location semantics: when an ICP row exists we honor `icp.location`
 * verbatim (a recruiter who CLEARED it means "no location preference", so we do
 * NOT fall back to the job's location); only when there is no ICP row at all do
 * we seed from `job.location`. Returns "" when there is no location preference.
 */
async function resolveTargetLocation(jobId: string): Promise<string> {
  // Fetch job and ICP independently so a transient failure on one read does not
  // wipe out the other and silently regress to the global pool (the original
  // bug symptom). If BOTH reads fail we return "" — the honest "no signal".
  let jobLocation = "";
  try {
    const [job] = await dbAdmin
      .select({ location: jobsTable.location })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);
    jobLocation = (job?.location || "").trim();
  } catch {
    /* leave jobLocation empty */
  }

  let icpRow: { location: string | null } | undefined;
  try {
    [icpRow] = await dbAdmin
      .select({ location: icpTable.location })
      .from(icpTable)
      .where(eq(icpTable.jobId, jobId))
      .orderBy(desc(icpTable.version))
      .limit(1);
  } catch {
    /* icp read failed — fall back to job location below */
  }

  // First-class ICP semantics: an ICP row is authoritative (a cleared location
  // means "no preference"). Only when there is no ICP row (missing OR its read
  // failed) do we fall back to the job's own location.
  const target = icpRow ? icpRow.location || "" : jobLocation;
  return (target || "").trim();
}

/**
 * Location for a demo candidate. When the work order targets a location, every
 * simulated candidate is placed there so the demo reflects a real
 * location-constrained search. With no target ("no location preference") we
 * fall back to a varied global pool.
 */
function demoLocation(target: string, i: number): string {
  if (target) return target;
  return pick(["Remote", "New York, NY", "London, UK", "Berlin, DE", "Austin, TX"], i);
}

/** Re-export for route typing convenience. */
export type { CreateRunInput };
