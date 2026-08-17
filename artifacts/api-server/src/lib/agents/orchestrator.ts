/**
 * agents/orchestrator.ts — Agent Orchestrator & Pipeline Runner
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Central dispatch layer for all Lexy AI agents. Maintains an in-memory
 * agent registry, tracks run history and status, and provides two execution
 * modes:
 *
 *   Single agent   triggerAgent(agentId, input)
 *     Runs one named agent, records the run in memory, emits an event, and
 *     non-critically feeds the intelligence table after completion.
 *
 *   Full pipeline  runPipeline(jobId, runId, enabledAgents, triggeredBy)
 *     Executes a user-configured sequence of agents in order, passing each
 *     agent's output forward as the next agent's input. Updates pipeline_runs
 *     stage statuses in the DB at each step.
 *
 * ─── Ten registered agents ───────────────────────────────────────────────────
 *   icp          — Extract Ideal Candidate Profile from a job description
 *   sourcing     — Search GitHub / PDL / SERP for external candidates, score
 *                  against ICP, upsert to sourced_candidates
 *   screening    — Score resumes against ICP, draft recruiter summaries,
 *                  advance / hold / reject with optional real-time email alerts
 *   interview    — Generate interview invite links for shortlisted candidates
 *   proctoring   — Monitor interview sessions for integrity signals
 *   outreach     — Write personalised outreach messages, queue them for send
 *   anti-ghosting— Detect candidate silence, fire follow-ups, escalate
 *   verification — Run identity checks: LinkedIn, resume consistency, email/phone
 *   scheduling   — Generate interview links and calendar invites
 *   analytics    — Produce pipeline funnel reports and anomaly alerts
 *
 * ─── In-memory state ─────────────────────────────────────────────────────────
 * Runs and events are stored in class-level arrays (max 200 events kept).
 * The constructor seeds recent-activity data so the agent dashboard shows
 * populated history on first load without needing real prior runs.
 *
 * ─── Intelligence feed ───────────────────────────────────────────────────────
 * After every successful agent run, _feedIntelligence() fires non-blocking
 * to update the jobs intelligence metrics (time-to-hire predictions, screening
 * funnel data, etc.) in the intelligence table.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   routes/agents.ts    — all agent trigger and status APIs
 *   routes/pipeline.ts  — runPipeline() for canvas pipeline execution
 */
import { generateJSON, generateText } from "../ai";
import { logger } from "../logger";
import { isJobApprovedForInterview } from "../job-approval";
import { scoreExternalCandidates, type SearchContext } from "../external-sourcing.js";
import { runSourcingProviders } from "../sourcing-providers.js";
import { generateIcpForJob } from "../icp-generator.js";
import { changeCandidateStage } from "../change-candidate-stage.js";
import { db } from "@workspace/db";
import {
  jobsTable,
  candidatesTable,
  icpTable,
  applicationsTable,
  sourcedCandidatesTable,
  outreachMessagesTable,
  pipelineRunsTable,
  interviewPlansTable,
  interviewSessionsTable,
  jobPipelinesTable,
  usersTable,
  tenantsTable,
} from "@workspace/db";
import { eq, desc, and, isNull, isNotNull, ne, sql, count } from "drizzle-orm";
import { upsertIntelligence, type AgentSignals } from "../intelligence";
import { computeSimilarHirePatternScore } from "../similar-hire";
import { sendEmail, plainToHtml, isEmailConfigured } from "../email";
import { generateFirstTouchDraft } from "../outreach-generate";
import { buildMessageContext, renderContextBlock } from "../ai-message-context";
import { dispatchOutreachMessage } from "../outreach-dispatch";
import { realEmailOrEmpty, isRealEmail } from "../real-email";
import { emitPipelineRunEvent, type PipelineRunRef } from "../pipeline-runs/recorder";

/** Hard per-candidate budget for background similar-hire enrichment (Task #26).
 *  Covers the embedding round trip plus, on inactive/below-gate tenants, the
 *  LLM-vs-ICP fallback (~15s timeout). Runs off the screening hot path, so on
 *  timeout we simply skip the merge and leave prior behavior intact. */
const SIMILAR_HIRE_ENRICH_BUDGET_MS = 20_000;

/* Resolve a sourced candidate's deliverable email. The real address often lives
 * on the canonical candidates row (linked via normalizedCandidateId) while the
 * sourced rawData has none or a placeholder — fall back to it so a linked
 * candidate with a valid email isn't skipped/failed as "no email on file". */
async function resolveSourcedEmail(
  raw: any,
  normalizedCandidateId: string | null | undefined,
): Promise<string> {
  const direct = realEmailOrEmpty(raw?.email) || realEmailOrEmpty(raw?.contactInfo?.email);
  if (direct) return direct;
  if (normalizedCandidateId) {
    const [nc] = await db
      .select({ email: candidatesTable.email })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, normalizedCandidateId))
      .limit(1);
    if (nc) return realEmailOrEmpty(nc.email);
  }
  return "";
}

export type AgentId =
  | "icp"
  | "sourcing"
  | "screening"
  | "interview"
  | "proctoring"
  | "outreach"
  | "anti-ghosting"
  | "verification"
  | "scheduling"
  | "analytics";

export type AgentStatus = "idle" | "running" | "completed" | "failed";

export interface AgentRun {
  id: string;
  agentId: AgentId;
  triggeredBy: string;
  /* Tenant/job/user provenance so the in-memory run history can be filtered to
   * the caller's tenant subtree (routes/agents.ts). Optional because a handful
   * of internal callers and the demo seed don't carry it; an unstamped run
   * (tenantId null) is treated as NOT visible to a scoped (non-platform) caller
   * — fail closed so we never leak another tenant's activity. */
  tenantId?: string | null;
  jobId?: string | null;
  triggeredByUserId?: string | null;
  input: Record<string, any>;
  output?: Record<string, any>;
  status: AgentStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface AgentEvent {
  id: string;
  type: string;
  agentId: AgentId;
  /* See AgentRun.tenantId — events are scoped the same way. */
  tenantId?: string | null;
  payload: Record<string, any>;
  timestamp: string;
  processed: boolean;
}

class AgentOrchestrator {
  private runs: AgentRun[] = [];
  private events: AgentEvent[] = [];
  private agentStatus: Map<AgentId, AgentStatus> = new Map();

  readonly registry: Record<AgentId, {
    name: string;
    description: string;
    triggers: string[];
    capabilities: string[];
    model: string;
    avgDurationMs: number;
  }> = {
    icp: {
      name: "ICP Agent",
      description: "Analyzes work order descriptions to extract the Ideal Candidate Profile — required skills, nice-to-haves, disqualifiers, and weighted scoring attributes.",
      triggers: ["work_order_created", "work_order_updated"],
      capabilities: ["Skill extraction", "Seniority mapping", "Disqualifier identification", "Attribute weighting"],
      model: "gpt-4o",
      avgDurationMs: 4200,
    },
    sourcing: {
      name: "Sourcing Agent",
      description: "Searches the candidate database, scores each profile against the ICP, and surfaces the top matches for the role.",
      triggers: ["icp_generated", "manual_trigger"],
      capabilities: ["DB candidate search", "ICP match scoring", "Talent pool ranking", "Signal scoring"],
      model: "gpt-4o",
      avgDurationMs: 8500,
    },
    screening: {
      name: "Screening Agent",
      description: "Parses and scores resumes against the ICP. Extracts work history, skills, gaps, and produces a structured recruiter summary with a match percentage.",
      triggers: ["candidate_applied", "candidate_sourced"],
      capabilities: ["Resume parsing", "Skill matching", "Gap detection", "Score generation", "Recruiter summary"],
      model: "gpt-4o",
      avgDurationMs: 3100,
    },
    interview: {
      name: "AI Video Interview Agent",
      description: "Generates a unique interview link per candidate. Conducts generative AI video interviews, evaluates responses in real-time, and produces a structured evaluation report.",
      triggers: ["screening_passed", "manual_trigger"],
      capabilities: ["Interview link generation", "Adaptive questioning", "Real-time scoring", "STAR evaluation", "Video transcript generation"],
      model: "gpt-4o",
      avgDurationMs: 1800000,
    },
    proctoring: {
      name: "Proctoring Agent",
      description: "Monitors video interview sessions for integrity signals: face presence, multiple faces, gaze direction, tab switching, audio anomalies, and suspicious behaviour patterns.",
      triggers: ["interview_started"],
      capabilities: ["Face detection", "Multi-person detection", "Gaze tracking", "Tab-switch monitoring", "Audio analysis", "Risk scoring"],
      model: "vision",
      avgDurationMs: 0,
    },
    outreach: {
      name: "Outreach Agent",
      description: "Writes personalised outreach messages per candidate, saves them to the outreach queue, and attaches interview links for candidates who pass screening.",
      triggers: ["screening_passed", "manual_trigger"],
      capabilities: ["Personalised copywriting", "Send-time optimisation", "Multi-step sequences", "Reply detection", "Interview link attachment"],
      model: "gpt-4o",
      avgDurationMs: 1800,
    },
    "anti-ghosting": {
      name: "Anti-Ghosting Agent",
      description: "Monitors candidate engagement across the pipeline. Detects silence, auto-sends follow-ups, and escalates at-risk candidates to the recruiter before they drop off.",
      triggers: ["candidate_silent_48h", "stage_stalled"],
      capabilities: ["Engagement monitoring", "Auto follow-up", "Risk flagging", "Recruiter escalation", "Sentiment analysis"],
      model: "gpt-4o",
      avgDurationMs: 900,
    },
    verification: {
      name: "Verification Agent",
      description: "Runs digital identity checks: LinkedIn profile matching, resume consistency, profile age, disposable email detection, and burner phone identification.",
      triggers: ["interview_completed", "manual_trigger"],
      capabilities: ["LinkedIn matching", "Resume cross-check", "Email validation", "Phone validation", "Profile age check"],
      model: "gpt-4o",
      avgDurationMs: 5200,
    },
    scheduling: {
      name: "Scheduling Agent",
      description: "Generates interview links for shortlisted candidates and attaches them to their outreach messages automatically.",
      triggers: ["interview_approved", "reschedule_request"],
      capabilities: ["Interview link generation", "Calendar invite draft", "Timezone handling", "Reminder scheduling"],
      model: "gpt-4o",
      avgDurationMs: 2100,
    },
    analytics: {
      name: "Analytics Agent",
      description: "Aggregates pipeline data across all agents. Identifies conversion bottlenecks, surfaces anomalies, generates hiring velocity reports, and provides predictive insights.",
      triggers: ["daily_0900", "stage_completed"],
      capabilities: ["Funnel analysis", "Bottleneck detection", "Trend forecasting", "Anomaly detection", "Report generation"],
      model: "gpt-4o",
      avgDurationMs: 3800,
    },
  };

  constructor() {
    const allIds: AgentId[] = ["icp", "sourcing", "screening", "interview", "proctoring", "outreach", "anti-ghosting", "verification", "scheduling", "analytics"];
    allIds.forEach(id => this.agentStatus.set(id, "idle"));
    this._seedRecentActivity();
  }

  private _seedRecentActivity() {
    const now = Date.now();
    const seed: Array<{ agentId: AgentId; durationMs: number; input: any; output: any }> = [
      { agentId: "icp", durationMs: 3800, input: { jobId: "job_001", title: "Senior Software Engineer" }, output: { requiredSkills: 5, disqualifiers: 2, weightedAttributes: 8 } },
      { agentId: "screening", durationMs: 2900, input: { candidateId: "cand_001", resumeScore: null }, output: { score: 84, summary: "Strong TypeScript/React background" } },
      { agentId: "sourcing", durationMs: 9200, input: { jobId: "job_001", icp: "Senior SWE" }, output: { candidatesFound: 34, highMatch: 8 } },
      { agentId: "outreach", durationMs: 1600, input: { candidateId: "cand_003", campaignId: "camp_01" }, output: { messagesQueued: 3, subject: "Opportunity at Acme" } },
      { agentId: "proctoring", durationMs: 3600000, input: { sessionId: "sess_001" }, output: { riskScore: 12, flags: 0 } },
      { agentId: "verification", durationMs: 4900, input: { candidateId: "cand_002" }, output: { checks: 5, passed: 4, failed: 1 } },
      { agentId: "anti-ghosting", durationMs: 800, input: { candidateId: "cand_005", silentDays: 3 }, output: { followUpSent: true, channel: "email" } },
      { agentId: "analytics", durationMs: 4100, input: { period: "weekly" }, output: { avgTimeToHire: 22, conversionRate: "18%" } },
    ];

    seed.forEach((s, i) => {
      const completedAt = new Date(now - (i + 1) * 7 * 60 * 1000);
      const startedAt = new Date(completedAt.getTime() - s.durationMs);
      this.runs.push({
        id: crypto.randomUUID(),
        agentId: s.agentId,
        triggeredBy: i < 3 ? "orchestrator" : i < 6 ? "user" : "scheduled",
        input: s.input,
        output: s.output,
        status: "completed",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: s.durationMs,
      });
    });
  }

  /* Visibility gate for the in-memory run/event history. `allowed` is the
   * caller's tenant subtree (from getDataScopeTenantIds):
   *   - null   → platform_admin: sees everything (incl. unstamped demo seed).
   *   - []/[…] → scoped caller: sees ONLY runs stamped with a tenantId in the
   *              set. An unstamped run (tenantId null/undefined) is hidden — we
   *              fail closed rather than risk leaking another tenant's activity.
   * Note: filtering happens here, in process memory, because these arrays are
   * never read through the RLS-scoped `db` connection — RLS cannot protect them,
   * so the endpoints must scope explicitly. */
  private _isVisible(tenantId: string | null | undefined, allowed: string[] | null): boolean {
    if (allowed === null) return true;
    if (!tenantId) return false;
    return allowed.includes(tenantId);
  }

  getAgentStatuses(allowed: string[] | null = null) {
    // Derive per-agent status/stats from the caller-visible runs only — never
    // expose the process-global `agentStatus` map, which reflects whatever any
    // tenant last triggered.
    const visibleRuns = this.runs.filter(r => this._isVisible(r.tenantId, allowed));
    return (Object.keys(this.registry) as AgentId[]).map(id => {
      const agentRuns = visibleRuns
        .filter(r => r.agentId === id)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      const completed = agentRuns.filter(r => r.status === "completed").length;
      return {
        id,
        // Status reflects the caller's most recent visible run, not global state.
        status: (agentRuns[0]?.status ?? "idle") as AgentStatus,
        ...this.registry[id],
        lastRun: agentRuns[0] || null,
        totalRuns: agentRuns.length,
        successRate: agentRuns.length === 0 ? 100 : Math.round((completed / agentRuns.length) * 100),
      };
    });
  }

  getEvents(limit = 20, allowed: string[] | null = null): AgentEvent[] {
    return [...this.events]
      .filter(e => this._isVisible(e.tenantId, allowed))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  getRecentRuns(limit = 20, allowed: string[] | null = null): AgentRun[] {
    return [...this.runs]
      .filter(r => this._isVisible(r.tenantId, allowed))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  async triggerAgent(
    agentId: AgentId,
    input: Record<string, any>,
    triggeredBy = "user",
    meta?: { tenantId?: string | null; jobId?: string | null; triggeredByUserId?: string | null },
  ): Promise<AgentRun> {
    // Resolve run provenance so getRecentRuns/getEvents/getAgentStatuses can be
    // tenant-scoped. runPipeline passes `meta` explicitly; other direct callers
    // don't, so fall back to deriving the tenant from input.jobId (one cheap
    // lookup, off the hot path). Unresolved tenant → null → hidden from scoped
    // callers (see _isVisible).
    const jobId = meta?.jobId ?? (typeof input?.jobId === "string" ? input.jobId : null);
    let tenantId = meta?.tenantId ?? null;
    if (!tenantId && jobId) {
      try {
        const [j] = await db
          .select({ tenantId: jobsTable.tenantId })
          .from(jobsTable)
          .where(eq(jobsTable.id, jobId))
          .limit(1);
        tenantId = j?.tenantId ?? null;
      } catch { /* non-critical — leave tenantId null (fails closed to hidden) */ }
    }

    const run: AgentRun = {
      id: crypto.randomUUID(),
      agentId,
      triggeredBy,
      tenantId,
      jobId,
      triggeredByUserId: meta?.triggeredByUserId ?? null,
      input,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    this.runs.push(run);
    this.agentStatus.set(agentId, "running");

    try {
      const startMs = Date.now();
      // Thread triggeredBy through to the agent body so per-agent logic
      // (e.g. real-time vs. digest notifications) can branch on it.
      (input as any)._triggeredBy = triggeredBy;
      (input as any)._runId = run.id;
      const output = await this._runAgent(agentId, input);
      const durationMs = Date.now() - startMs;

      run.output = output;
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.durationMs = durationMs;
      this.agentStatus.set(agentId, "idle");

      this._emit(agentId, `${agentId}_completed`, { runId: run.id, output }, tenantId);
      logger.info({ agentId, durationMs }, "Agent run completed");

      /* Feed intelligence table — non-blocking, non-critical */
      this._feedIntelligence(agentId, input, output).catch(() => {});
    } catch (err: any) {
      run.status = "failed";
      run.error = err?.message || "Unknown error";
      run.completedAt = new Date().toISOString();
      this.agentStatus.set(agentId, "failed");
      logger.error({ agentId, err }, "Agent run failed");
    }

    return run;
  }

  /* ── Full pipeline execution ─────────────────────────────────────────── */
  async runPipeline(
    jobId: string,
    runId: string,
    enabledAgents: Array<{ id: string; order: number; config: any }>,
    triggeredBy: string,
    meta?: { tenantId?: string | null; triggeredByUserId?: string | null },
  ): Promise<void> {
    /* Look up the recruiter's "Stop when this many viable candidates are found"
       setting once per run and seed it into the pipeline input. Sourcing uses
       it to size external API calls (instead of always pulling 15/source) and
       Screening uses it to short-circuit the LLM-screening loop the moment we
       have enough viable candidates for this job. Defaults to 5 to match the
       UI fallback in routes/agents.ts. */
    let targetCandidates = 5;
    try {
      const [cfg] = await db
        .select({ target: jobPipelinesTable.targetCandidates })
        .from(jobPipelinesTable)
        .where(eq(jobPipelinesTable.jobId, jobId))
        .limit(1);
      if (cfg?.target && cfg.target > 0) targetCandidates = cfg.target;
    } catch { /* non-critical — fall back to 5 */ }

    let pipelineInput: Record<string, any> = { jobId, targetCandidates };

    /* Resolve a run handle for the DURABLE event stream (pipeline_run_events,
     * migration 0043). Emits are fire-and-forget (`void`) and the recorder never
     * throws, so persisting the audit trail can never fail or slow the run. The
     * in-memory `_emit` buffer is retained (dual-write) as a hot cache. The tenant
     * is taken from meta, falling back to the pipeline_runs row if a caller didn't
     * pass it. If tenant can't be resolved we simply skip persistence (unscoped
     * events would violate RLS). */
    let runRef: PipelineRunRef | null = null;
    {
      let tenantId = meta?.tenantId ?? null;
      if (!tenantId) {
        try {
          const [r] = await db
            .select({ tenantId: pipelineRunsTable.tenantId })
            .from(pipelineRunsTable)
            .where(eq(pipelineRunsTable.id, runId))
            .limit(1);
          tenantId = r?.tenantId ?? null;
        } catch { /* non-critical — leave null → skip persistence */ }
      }
      if (tenantId) runRef = { id: runId, tenantId };
    }
    const agentSequence = enabledAgents.map(a => a.id).join(" → ");
    if (runRef) void emitPipelineRunEvent(runRef, {
      type: "run_started",
      message: `Pipeline started: ${agentSequence}`,
      count: enabledAgents.length,
      payload: { jobId, agents: enabledAgents.map(a => a.id) },
    });

    for (const agentConfig of enabledAgents) {
      const agentId = agentConfig.id as AgentId;
      const mergedInput = { ...pipelineInput, ...agentConfig.config, jobId };

      logger.info({ agentId, jobId }, "Pipeline: starting agent");

      await this._updatePipelineStage(runId, agentId, "running");
      if (runRef) void emitPipelineRunEvent(runRef, {
        type: "step_started",
        stepName: agentId,
        message: `${agentId} started`,
      });
      /* Advance the per-job currentStage so the UI banner can update
       * "Running — icp" → "Running — sourcing" between agents. Without
       * this the recruiter just sees the first agent's name for the
       * entire run. Non-critical: failure to update is swallowed. */
      await this._setCurrentStage(jobId, agentId);

      const run = await this.triggerAgent(agentId, mergedInput, triggeredBy, {
        tenantId: meta?.tenantId ?? null,
        jobId,
        triggeredByUserId: meta?.triggeredByUserId ?? null,
      });

      if (run.status === "failed") {
        await this._updatePipelineStage(runId, agentId, "failed", run.output, run.error);
        if (runRef) void emitPipelineRunEvent(runRef, {
          type: "run_failed",
          stepName: agentId,
          message: `${agentId} failed: ${run.error ?? "unknown error"}`,
        });
        throw new Error(`Agent ${agentId} failed: ${run.error}`);
      }

      await this._updatePipelineStage(runId, agentId, "completed", run.output);
      if (runRef) void emitPipelineRunEvent(runRef, {
        type: "step_completed",
        stepName: agentId,
        message: `${agentId} completed`,
        payload: run.output ? { outputKeys: Object.keys(run.output).slice(0, 8) } : null,
      });

      if (run.output) {
        pipelineInput = { ...pipelineInput, ...run.output };
      }
    }

    if (runRef) void emitPipelineRunEvent(runRef, {
      type: "run_completed",
      message: `Pipeline completed: ${agentSequence}`,
      count: enabledAgents.length,
    });
  }

  private async _setCurrentStage(jobId: string, agentId: string) {
    try {
      await db
        .update(jobPipelinesTable)
        .set({ currentStage: agentId, updatedAt: new Date() })
        .where(eq(jobPipelinesTable.jobId, jobId));
    } catch { /* non-critical */ }
  }

  private async _updatePipelineStage(runId: string, agentId: string, status: string, output?: any, error?: string) {
    try {
      const [run] = await db.select().from(pipelineRunsTable).where(eq(pipelineRunsTable.id, runId)).limit(1);
      if (!run) return;
      const stages = (run.stages as any[]).map(s =>
        s.agentId === agentId
          ? { ...s, status, output: output ?? s.output, error: error ?? s.error, completedAt: status !== "running" ? new Date().toISOString() : s.completedAt, startedAt: status === "running" ? new Date().toISOString() : s.startedAt }
          : s
      );
      await db.update(pipelineRunsTable).set({ stages }).where(eq(pipelineRunsTable.id, runId));
    } catch { /* non-critical */ }
  }

  private _emit(agentId: AgentId, type: string, payload: Record<string, any>, tenantId: string | null = null) {
    this.events.push({
      id: crypto.randomUUID(),
      type,
      agentId,
      tenantId,
      payload,
      timestamp: new Date().toISOString(),
      processed: false,
    });
    if (this.events.length > 200) this.events = this.events.slice(-200);
  }

  private async _runAgent(agentId: AgentId, input: Record<string, any>): Promise<Record<string, any>> {
    switch (agentId) {
      case "icp":          return this._runICP(input);
      case "screening":    return this._runScreening(input);
      case "sourcing":     return this._runSourcing(input);
      case "outreach":     return this._runOutreach(input);
      case "anti-ghosting":return this._runAntiGhosting(input);
      case "verification": return this._runVerification(input);
      case "scheduling":   return this._runScheduling(input);
      case "analytics":    return this._runAnalytics(input);
      case "interview":    return this._runInterview(input);
      case "proctoring":   return this._runProctoring(input);
    }
  }

  /* ── ICP Agent ───────────────────────────────────────────────────────── */
  private async _runICP(input: Record<string, any>): Promise<Record<string, any>> {
    const { jobId, recruiterNotes, hiringManagerNotes } = input;
    if (!jobId) return { icpGenerated: false, message: "No jobId provided" };

    // Delegate to the shared rich-schema generator so the pipeline-run ICP
    // matches the route-generated one (domain, alternateTitles, certifications,
    // tools, compliance, negativeKeywords, booleanSearchString — all needed by
    // the Sourcing agent).
    const saved = await generateIcpForJob({ jobId, recruiterNotes, hiringManagerNotes });
    if (!saved) return { icpGenerated: false, message: "Job not found" };
    logger.info({ jobId }, "ICP saved to database");
    return { ...saved, icpGenerated: true };
  }

  /* ── Sourcing Agent ─────────────────────────────────────────────────── */
  private async _runSourcing(input: Record<string, any>): Promise<Record<string, any>> {
    /* Size each external search to the recruiter's target instead of a flat 15.
       Heuristic: with 3 discovery sources (GitHub, PDL, SerpAPI) and a ~50%
       qualified rate after scoring, asking for ~2× target per source gives us
       roughly 3× target qualified candidates after dedupe — enough headroom
       for screening to find `target` viable ones, without burning quota when
       the recruiter just wants 5. Floor of 8 keeps small targets sane. */
    const { jobId, targetCandidates, minScore = 50 } = input;
    const target = Math.max(1, Number(targetCandidates) || 5);
    const maxPerSource = Math.max(8, Math.min(50, target * 2));

    if (!jobId) return { candidatesFound: 0, highMatch: 0, sourced: 0, message: "No jobId provided" };

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    const [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, jobId)).limit(1);
    if (!job) return { candidatesFound: 0, highMatch: 0, sourced: 0, message: "Job not found" };

    const ctx: SearchContext = {
      jobTitle: icp?.jobTitle || job.title,
      alternateTitles: (icp as any)?.alternateTitles || [],
      requiredSkills: icp?.requiredSkills || [],
      preferredSkills: icp?.preferredSkills || [],
      requiredCertifications: (icp as any)?.requiredCertifications || [],
      toolsAndSystems: (icp as any)?.toolsAndSystems || [],
      compliance: (icp as any)?.compliance || [],
      negativeKeywords: (icp as any)?.negativeKeywords || [],
      domain: (icp as any)?.domain ?? null,
      roleFamily: icp?.roleFamily ?? null,
      seniority: icp?.seniority ?? null,
      // Language requirements are not an ICP column yet — pass through if present.
      languages: (icp as any)?.languages ?? [],
      // First-class ICP location: honor it verbatim when an ICP exists (cleared
      // → "no location preference"); only seed from job.location when no ICP row.
      location: icp ? ((icp as any).location || "") : (job.location || ""),
      // Work arrangement lives on the job, not the ICP — remote roles skip the
      // location pin entirely (see searchPDL tiered relaxation).
      workType: ((job as any)?.workType ?? null) as SearchContext["workType"],
      booleanSearchString: (icp as any)?.booleanSearchString ?? null,
      maxResults: maxPerSource,
    };

    logger.info({ jobId, jobTitle: ctx.jobTitle, domain: ctx.domain, skills: ctx.requiredSkills }, "Sourcing: starting external search");

    // Run the external providers through the adapter layer (Task #28). Phase 1
    // discovery (GitHub, PDL, SerpAPI) runs in parallel; Phase 2 enrichment
    // (EnrichLayer) is seeded from the discovery LinkedIn URLs. Provider
    // selection/disabling is config-driven and failures degrade gracefully —
    // see lib/sourcing-providers.ts.
    const providerResults = await runSourcingProviders(ctx);
    const ghCandidates   = providerResults.github.candidates;
    const pdlCandidates  = providerResults.pdl.candidates;
    const serpCandidates = providerResults.serp.candidates;
    const elCandidates   = providerResults.enrichlayer.candidates;

    const all = [...ghCandidates, ...pdlCandidates, ...serpCandidates, ...elCandidates];
    logger.info({ jobId, github: ghCandidates.length, pdl: pdlCandidates.length, serp: serpCandidates.length, enrichlayer: elCandidates.length, total: all.length }, "Sourcing: external search complete");

    const scored = icp ? await scoreExternalCandidates(all, icp as any) : all.map(c => ({ ...c, matchScore: 50 }));
    const qualified = scored.filter(c => (c.matchScore ?? 0) >= minScore).sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

    let sourced = 0;
    for (const c of qualified) {
      try {
        // Upsert into normalized candidates table so intelligence records have a
        // proper UUID. Match an existing person on LinkedIn URL first, then on
        // email, so a second sourcing run never creates a duplicate row (and
        // never trips the (tenant, lower(email)) unique index).
        let normalizedId: string = c.id; // fallback to raw id
        const tid = job.tenantId || "acme";
        const realEmail = typeof c.email === "string" && c.email.trim()
          && !c.email.trim().toLowerCase().endsWith("@unknown.local")
          && !c.email.trim().toLowerCase().endsWith("@import.local")
          ? c.email.trim().toLowerCase() : "";
        let existingCand: any = null;
        if (c.linkedinUrl) {
          const r = await db.select().from(candidatesTable)
            .where(and(eq(candidatesTable.tenantId, tid), eq(candidatesTable.linkedinUrl, c.linkedinUrl))).limit(1);
          existingCand = r[0] ?? null;
        }
        if (!existingCand && realEmail) {
          const r = await db.select().from(candidatesTable)
            .where(and(eq(candidatesTable.tenantId, tid), sql`lower(${candidatesTable.email}) = ${realEmail}`)).limit(1);
          existingCand = r[0] ?? null;
        }
        if (existingCand) {
          normalizedId = existingCand.id;
        } else {
          const [inserted] = await db.insert(candidatesTable).values({
            tenantId: tid,
            firstName: c.firstName || "Unknown",
            lastName: c.lastName || "",
            // email is NOT NULL — mint a placeholder when the source had none.
            email: realEmail || `sourced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unknown.local`,
            location: c.location || null,
            currentTitle: c.currentTitle || null,
            currentCompany: c.currentCompany || null,
            linkedinUrl: c.linkedinUrl || null,
            githubUrl: c.githubProfile || null,
            skills: c.skills || [],
            source: c.source || "serp",
          }).returning({ id: candidatesTable.id }).catch(() => [null]);
          if (inserted?.id) normalizedId = inserted.id;
        }

        const existingSourced = await db.select().from(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.normalizedCandidateId, normalizedId)).limit(1);
        if (existingSourced.length === 0) {
          await db.insert(sourcedCandidatesTable).values({
            tenantId: job.tenantId || "acme",
            source: c.source,
            rawData: { ...c, jobId, matchScore: c.matchScore, matchReason: c.matchReason },
            normalizedCandidateId: normalizedId,
            mergeConfidence: c.matchScore ? c.matchScore / 100 : null,
          });
          sourced++;
        }
      } catch { /* skip duplicates */ }
    }

    const highMatch = qualified.filter(c => (c.matchScore ?? 0) >= 80).length;
    logger.info({ jobId, sourced, highMatch }, "Sourcing completed");

    return {
      candidatesFound: all.length,
      bySource: { github: ghCandidates.length, pdl: pdlCandidates.length, serp: serpCandidates.length, enrichlayer: elCandidates.length },
      qualified: qualified.length,
      highMatch,
      sourced,
      topCandidates: qualified.slice(0, 5).map(c => ({ name: `${c.firstName} ${c.lastName}`, score: c.matchScore, source: c.source })),
    };
  }

  /* ── Screening Agent ─────────────────────────────────────────────────── */
  private async _runScreening(input: Record<string, any>): Promise<Record<string, any>> {
    // (helpers defined at module scope below)
    const { candidateId, jobId, topCandidateIds, _triggeredBy } = input;
    const triggeredBy: string = _triggeredBy || "user";

    let icpContext: any = null;
    if (jobId) {
      const [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, jobId)).limit(1);
      if (icp) icpContext = { requiredSkills: icp.requiredSkills, preferredSkills: icp.preferredSkills, mustHaves: icp.mustHaves, disqualifiers: icp.disqualifiers, seniority: icp.seniority, yearsExperienceMin: icp.yearsExperienceMin, weightedAttributes: icp.weightedAttributes };
    }

    const screenedIds: string[] = [];
    const passedIds: string[] = [];
    const screeningResults: any[] = [];

    // Agent stage moves route through the choke-point (stage + candidate_events +
    // audit pointer, atomically). Resolve the JOB tenant (authoritative — the
    // sourced row's own tenant may be the candidate's home tenant) and thread
    // the triggering run id for attribution.
    const runId: string | null = (input as any)._runId ?? null;
    const screeningTenantId: string | null = jobId
      ? (await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1))[0]?.tenantId ?? null
      : null;

    // --- Path 1: screen specific candidates by ID (from applications/pipeline chain)
    const explicitIds: string[] = topCandidateIds ?? (candidateId ? [candidateId] : []);
    if (explicitIds.length > 0) {
      for (const cid of explicitIds.slice(0, 15)) {
        const [candidate] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, cid)).limit(1);
        if (!candidate) continue;
        const ctx = { name: `${candidate.firstName} ${candidate.lastName}`, currentTitle: candidate.currentTitle, currentCompany: candidate.currentCompany, location: candidate.location, skills: candidate.skills, source: candidate.source };
        const result = await generateJSON<any>(
          buildScreeningPrompt(ctx, icpContext),
          SCREENING_SYSTEM_PROMPT,
        );
        await db.update(candidatesTable).set({ resumeScreenScore: result.score, updatedAt: new Date() }).where(eq(candidatesTable.id, cid));

        // Also update the matching sourced_candidates row so the pipeline kanban
        // moves the card from "Sourced" → "Screening" / "Rejected".
        try {
          const sourcedRows = await db.select().from(sourcedCandidatesTable)
            .where(eq(sourcedCandidatesTable.normalizedCandidateId, cid));
          for (const sr of sourcedRows) {
            const sraw = (sr.rawData as any) || {};
            if (jobId && sraw.jobId && sraw.jobId !== jobId) continue;
            // Mirror the board's derivation EXACTLY (reject → "rejected",
            // advance/hold → "screening"); never write "sourced".
            const nextStage = result.recommendation === "reject" ? "rejected" : "screening";
            if (screeningTenantId && jobId) {
              await changeCandidateStage({
                tenantId: screeningTenantId,
                candidateId: cid,
                jobId,
                to: nextStage,
                actor: { type: "agent", label: "Screening Agent", runId },
                source: "agent_orchestrator",
                sourcedId: sr.id,
                sourcedRawDataPatch: { screeningScore: result.score, screeningResult: result, screened: true },
                sourcedColumnPatch: { mergeConfidence: result.score / 100 },
              });
            } else {
              // stage-write-exempt: no resolvable tenant/job — no auditable trail; persist signal only
              await db.update(sourcedCandidatesTable).set({
                mergeConfidence: result.score / 100,
                rawData: { ...sraw, screeningScore: result.score, screeningResult: result, screened: true },
              }).where(eq(sourcedCandidatesTable.id, sr.id));
            }
          }
        } catch (e) {
          logger.warn({ err: e, cid }, "Failed to update sourced_candidates after screening");
        }

        screenedIds.push(cid);
        if (result.recommendation === "advance") passedIds.push(cid);
        screeningResults.push({ candidateId: cid, name: ctx.name, ...result });
      }
      await notifyRecruiterOfScreeningBatch(jobId, screeningResults, triggeredBy);
      return { screened: screenedIds.length, passed: passedIds.length, passedCandidateIds: passedIds, screeningResults };
    }

    // --- Path 2: screen sourced candidates for this job (standalone run)
    if (!jobId) return { screened: 0, passed: 0, message: "No jobId and no candidates provided" };

    const sourced = await db.select().from(sourcedCandidatesTable)
      .orderBy(desc(sourcedCandidatesTable.createdAt))
      .limit(50);

    // Only screen candidates explicitly sourced for this job
    const forJob = sourced.filter(s => {
      const raw = s.rawData as any;
      return raw?.jobId === jobId;
    });

    if (forJob.length === 0) return { screened: 0, passed: 0, message: "No sourced candidates for this job. Run the Sourcing agent first." };

    /* Honor the recruiter's "Stop when this many viable candidates are found"
       setting: count what's already viable for this job (active applications
       with a match score), then stop screening as soon as the *new* passes
       in this run plus what's already viable reaches the target. Avoids
       paying for LLM screening of the 21st candidate when 5 was the goal. */
    const target = Math.max(1, Number((input as any).targetCandidates) || 5);
    let alreadyViable = 0;
    try {
      const [row] = await db
        .select({ cnt: count() })
        .from(applicationsTable)
        .where(and(
          eq(applicationsTable.jobId, jobId),
          isNotNull(applicationsTable.matchScore),
          ne(applicationsTable.stage, "rejected"),
          ne(applicationsTable.stage, "withdrawn"),
        ));
      alreadyViable = row?.cnt ?? 0;
    } catch { /* non-critical — fall through with 0 */ }
    const stillNeeded = Math.max(0, target - alreadyViable);

    logger.info({ jobId, count: forJob.length, target, alreadyViable, stillNeeded }, "Screening sourced candidates");

    if (stillNeeded === 0) {
      return { screened: 0, passed: 0, passedCandidateIds: [], screeningResults: [], message: `Target of ${target} viable candidates already met` };
    }

    for (const s of forJob.slice(0, 25)) {
      if (passedIds.length >= stillNeeded) {
        logger.info({ jobId, target, passed: passedIds.length, alreadyViable }, "Screening: target reached, stopping early");
        break;
      }
      const raw = s.rawData as any;
      const ctx = {
        name:         `${raw?.firstName || ""} ${raw?.lastName || ""}`.trim(),
        currentTitle: raw?.currentTitle || "",
        currentCompany: raw?.currentCompany || "",
        location:     raw?.location || "",
        skills:       raw?.skills || [],
        source:       s.source,
        bio:          raw?.rawData?.bio || "",
        githubRepos:  raw?.publicRepos,
        followers:    raw?.followers,
      };

      const result = await generateJSON<any>(
        buildScreeningPrompt(ctx, icpContext),
        SCREENING_SYSTEM_PROMPT,
      );

      // Update sourced candidate with screening score. Write an explicit stage
      // mirroring the board's derivation (reject → "rejected", else "screening").
      const nextStage = result.recommendation === "reject" ? "rejected" : "screening";
      if (s.normalizedCandidateId && screeningTenantId) {
        await changeCandidateStage({
          tenantId: screeningTenantId,
          candidateId: s.normalizedCandidateId,
          jobId: jobId as string,
          to: nextStage,
          actor: { type: "agent", label: "Screening Agent", runId },
          source: "agent_orchestrator",
          sourcedId: s.id,
          sourcedRawDataPatch: { screeningScore: result.score, screeningResult: result, screened: true },
          sourcedColumnPatch: { mergeConfidence: result.score / 100 },
        }).catch((e) => { logger.warn({ err: e, sourcedId: s.id }, "screening stage-change failed"); });
      } else {
        // stage-write-exempt: pre-normalized sourced row has no canonical candidate id to audit
        await db.update(sourcedCandidatesTable).set({
          mergeConfidence: result.score / 100,
          rawData: { ...raw, screeningScore: result.score, screeningResult: result, screened: true },
        }).where(eq(sourcedCandidatesTable.id, s.id));
      }

      // Tracking IDs (used for batch counts) can fall back to the sourced
      // row id when no normalized candidate exists yet. The intelligence
      // feed, however, requires a real candidates.id — pushing s.id there
      // would create orphan candidate_job_intelligence rows that the UI
      // renders as "Unknown" candidates.
      const trackingId = s.normalizedCandidateId || s.id;
      screenedIds.push(trackingId);
      if (result.recommendation === "advance") passedIds.push(trackingId);
      screeningResults.push({ sourcedId: s.id, candidateId: s.normalizedCandidateId || null, name: ctx.name, ...result });
    }

    logger.info({ jobId, screened: screenedIds.length, passed: passedIds.length }, "Screening completed");

    await notifyRecruiterOfScreeningBatch(jobId, screeningResults, triggeredBy);

    return {
      screened: screenedIds.length,
      passed: passedIds.length,
      passedCandidateIds: passedIds,
      screeningResults,
    };
  }

  /* ── Outreach Agent ─────────────────────────────────────────────────── */
  private async _runOutreach(input: Record<string, any>): Promise<Record<string, any>> {
    const { candidateId, jobId, passedCandidateIds } = input;
    const runId: string | null = (input as any)._runId ?? null;

    /* Manual recruiter/admin override: when a recruiter explicitly drags a
     * candidate into the Outreach Queued stage, that is a deliberate human
     * decision that must win over the automatic verify→outreach gate. The
     * Verification Agent can legitimately return "pending / needs review"
     * (e.g. sparse profile data) and never reach "verified" — without this,
     * such candidates would be silently skipped and no draft would ever be
     * produced, even though the recruiter asked for one. Only the manual
     * stage-move trigger sets this flag; automatic/scheduler runs leave it
     * false so they continue to respect the gate. The draft is still held for
     * approval, so a human still signs off before anything sends. */
    const manualOverride = input.manualOverride === true;

    // Approval gate ("approve once per work order"): by default the FIRST cold
    // outreach email in a work order is generated and held as "pending_approval"
    // for a recruiter to sign off before it sends. Once the recruiter has
    // approved ANY outreach for this job, every subsequent first-touch email for
    // the same work order sends automatically — no repeated approvals.
    // Callers that explicitly want the legacy immediate-send behavior pass
    // autoSendOutreach: true. Verify→outreach ordering is enforced below: only
    // verified candidates (or screened+advance, when no verification step is
    // configured) are eligible for a first-touch email.
    let requireApproval = input.autoSendOutreach !== true;
    if (requireApproval && jobId) {
      const [priorApproved] = await db
        .select({ id: outreachMessagesTable.id })
        .from(outreachMessagesTable)
        .where(and(
          eq(outreachMessagesTable.jobId, jobId),
          isNotNull(outreachMessagesTable.approvedAt),
        ))
        .limit(1);
      if (priorApproved) requireApproval = false;
    }

    let jobCtx: any = {};
    let jobTenantId: string | undefined;
    let outreachContextBlock = "";
    let outreachHasBrandContext = false;
    let outreachContextSummary = "";
    let aiMessagingEnabled = true;
    if (jobId) {
      const [j] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      if (j) {
        jobTenantId = j.tenantId ?? undefined;
        // Assemble the tenant brand + role context once for the whole batch, and
        // use the real company name from the brand profile (falling back to the
        // tenant name, then a neutral stub) instead of the old "our company".
        const ctx = await buildMessageContext({ tenantId: jobTenantId ?? "", jobId });
        aiMessagingEnabled = ctx.aiMessagingEnabled;
        let companyName = ctx.companyName;
        if (!companyName && jobTenantId) {
          const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, jobTenantId)).limit(1);
          companyName = t?.name ?? undefined;
        }
        outreachContextBlock = renderContextBlock(ctx);
        // "Brand context" = the company's own brand voice (profile) and/or
        // uploaded COMPANY documents only — NOT workorder/role docs (which are
        // folded into ctx.docsBrief). When neither is present we want the
        // role-only fallback, so the email never claims brand values that the
        // tenant hasn't provided.
        outreachHasBrandContext = !!ctx.brandBrief || ctx.sourceContext.tenantDocs > 0;
        outreachContextSummary = ctx.contextSummary;
        jobCtx = {
          title: j.title,
          location: j.location,
          workType: j.workType,
          company: companyName ?? "our company",
          language: j.language ?? "en",
          description: j.description,
        };
      }
    }

    // Build a unified list of candidates to reach: { id, firstName, lastName, currentTitle, currentCompany, skills, sourcedId? }
    type OutreachCandidate = { id: string; firstName: string; lastName: string; email?: string; currentTitle?: string; currentCompany?: string; skills?: string[]; sourcedId?: string; tenantId?: string };
    const toReach: OutreachCandidate[] = [];
    // Candidates that were requested but have NOT passed verification yet.
    // Enforces verify→outreach: we never write a first email for an unverified
    // sourced candidate, even on the chained/explicit-id path.
    const skippedUnverified: string[] = [];
    // NON-overridable contact-email guard: candidates with no real address are
    // collected here and reported back so the caller can surface an actionable
    // "add an email" reason instead of silently queueing an unsendable draft.
    const skippedNoEmail: string[] = [];

    const explicitIds: string[] = passedCandidateIds ?? (candidateId ? [candidateId] : []);

    if (explicitIds.length > 0) {
      // Try candidates table first, then sourced_candidates
      for (const cid of explicitIds) {
        const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, cid)).limit(1);
        if (c) {
          // Verify gate (matches the sourced path): a candidates-table record is
          // eligible for a first-touch cold email only once verification has
          // cleared. Enforces verify→outreach ordering on the explicit-id path.
          if (!manualOverride && c.verificationStatus !== "verified") {
            skippedUnverified.push(cid);
            logger.info({ candidateId: cid, jobId, verificationStatus: c.verificationStatus }, "[outreach] skipped — candidate has not passed verification");
            continue;
          }
          if (manualOverride && c.verificationStatus !== "verified") {
            logger.info({ candidateId: cid, jobId, verificationStatus: c.verificationStatus }, "[outreach] verify gate bypassed — manual recruiter override (stage move to Outreach)");
          }
          /* Dedup: unlike the sourced path (which guards on rawData.outreachDrafted/
             outreachSent), a candidates-table record has no such flag, so a repeat
             trigger — e.g. re-advancing into Outreach Queued — would otherwise
             generate a second draft. Skip if this candidate already has a live
             outreach message for this job. */
          if (jobId) {
            const [existing] = await db.select({ id: outreachMessagesTable.id })
              .from(outreachMessagesTable)
              .where(and(eq(outreachMessagesTable.candidateId, c.id), eq(outreachMessagesTable.jobId, jobId)))
              .limit(1);
            if (existing) {
              logger.info({ candidateId: cid, jobId }, "[outreach] skipped — candidate already has an outreach message for this job");
              continue;
            }
          }
          // Contact-email guard (NON-overridable, holds even under manualOverride):
          // no real address = every send bounces. Skip + report rather than queue
          // an unsendable draft.
          if (!isRealEmail(c.email)) {
            skippedNoEmail.push(cid);
            logger.info({ candidateId: cid, jobId }, "[outreach] skipped — candidate has no contact email on file");
            continue;
          }
          toReach.push({ id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email ?? undefined, currentTitle: c.currentTitle ?? undefined, currentCompany: c.currentCompany ?? undefined, skills: c.skills ?? [], tenantId: c.tenantId });
        } else {
          // May be a sourced_candidates ID
          const [s] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, cid)).limit(1);
          if (s) {
            const raw = s.rawData as any;
            // Verify gate (matches the standalone path): a sourced candidate is
            // eligible only once they've passed verification, or — when no
            // verification step is configured — they're screened + advance.
            const verified = raw?.stage === "verification";
            const screenedAdvance = raw?.screened === true && raw?.screeningResult?.recommendation === "advance";
            if (!manualOverride && !verified && !screenedAdvance) {
              skippedUnverified.push(cid);
              logger.info({ candidateId: cid, jobId }, "[outreach] skipped — candidate has not passed verification");
              continue;
            }
            if (manualOverride && !verified && !screenedAdvance) {
              logger.info({ candidateId: cid, jobId }, "[outreach] verify gate bypassed — manual recruiter override (stage move to Outreach)");
            }
            const resolvedEmail = await resolveSourcedEmail(raw, s.normalizedCandidateId);
            // Contact-email guard (NON-overridable, holds even under manualOverride).
            if (!isRealEmail(resolvedEmail)) {
              skippedNoEmail.push(cid);
              logger.info({ candidateId: cid, jobId }, "[outreach] skipped — sourced candidate has no contact email on file");
              continue;
            }
            toReach.push({ id: s.id, firstName: raw?.firstName || "Candidate", lastName: raw?.lastName || "", email: resolvedEmail || undefined, currentTitle: raw?.currentTitle, currentCompany: raw?.currentCompany, skills: raw?.skills, sourcedId: s.id, tenantId: raw?.tenantId ?? s.tenantId ?? undefined });
          }
        }
      }
    } else if (jobId) {
      // Standalone run: find verification-stage sourced candidates (verified and ready for outreach)
      // Falls back to screened+advance candidates if no verified ones exist
      const allSourced = await db.select().from(sourcedCandidatesTable).orderBy(desc(sourcedCandidatesTable.createdAt)).limit(200);

      const jobSourced = allSourced.filter(s => (s.rawData as any)?.jobId === jobId);
      const alreadySent = jobSourced.filter(s => { const r = s.rawData as any; return r?.outreachSent === true || r?.outreachDrafted === true; });

      const readyForOutreach = jobSourced.filter(s => {
        const raw = s.rawData as any;
        // Already sent OR already has a pending-approval draft → don't regenerate.
        if (raw?.outreachSent || raw?.outreachDrafted) return false;
        // Primary: candidates who've passed verification
        if (raw?.stage === "verification") return true;
        // Fallback: screened candidates with advance recommendation (no verification step used)
        if (raw?.screened === true && raw?.screeningResult?.recommendation === "advance") return true;
        return false;
      });

      if (readyForOutreach.length === 0) {
        if (alreadySent.length > 0) {
          return { messagesQueued: 0, alreadyQueued: alreadySent.length, message: `All ${alreadySent.length} candidate${alreadySent.length !== 1 ? "s" : ""} already have outreach messages queued.` };
        }
        return { messagesQueued: 0, message: "No verified candidates ready for outreach. Run Verification agent first." };
      }

      for (const s of readyForOutreach.slice(0, 15)) {
        const raw = s.rawData as any;
        const resolvedEmail = await resolveSourcedEmail(raw, s.normalizedCandidateId);
        // Contact-email guard (NON-overridable): never queue an unsendable draft.
        if (!isRealEmail(resolvedEmail)) {
          skippedNoEmail.push(s.id);
          logger.info({ candidateId: s.id, jobId }, "[outreach] skipped — sourced candidate has no contact email on file");
          continue;
        }
        toReach.push({ id: s.id, firstName: raw?.firstName || "Candidate", lastName: raw?.lastName || "", email: resolvedEmail || undefined, currentTitle: raw?.currentTitle, currentCompany: raw?.currentCompany, skills: raw?.skills, sourcedId: s.id, tenantId: raw?.tenantId ?? s.tenantId ?? undefined });
      }
    } else {
      return { messagesQueued: 0, message: "No candidates for outreach" };
    }

    if (toReach.length === 0) {
      if (skippedNoEmail.length > 0 || skippedUnverified.length > 0) {
        const parts: string[] = [];
        if (skippedNoEmail.length > 0) parts.push(`${skippedNoEmail.length} have no email address on file`);
        if (skippedUnverified.length > 0) parts.push(`${skippedUnverified.length} have not passed verification`);
        const remedy = skippedNoEmail.length > 0
          ? (skippedUnverified.length > 0 ? "Add or enrich an email address, or run the Verification agent, first." : "Add or enrich an email address first.")
          : "Run the Verification agent first.";
        return { messagesQueued: 0, skippedUnverified, skippedNoEmail, message: `No candidates ready for outreach — ${parts.join(" and ")}. ${remedy}` };
      }
      return { messagesQueued: 0, message: "No candidates for outreach" };
    }

    // Tenant kill switch: fail closed before any model invocation. When AI
    // messaging is disabled for the tenant we never generate first-touch drafts.
    if (!aiMessagingEnabled) {
      return { messagesQueued: 0, aiDisabled: true, message: "AI messaging is disabled for this tenant. No outreach was generated." };
    }

    let messagesQueued = 0;
    let messagesPending = 0;
    let messagesSent = 0;
    let messagesFailed = 0;
    const outreachIds: string[] = [];
    const sendErrors: Array<{ candidateId: string; email?: string; error: string }> = [];

    for (const c of toReach.slice(0, 20)) {
      const candidateCtx = { name: `${c.firstName} ${c.lastName}`, currentTitle: c.currentTitle, currentCompany: c.currentCompany, skills: c.skills?.slice(0, 5) };
      const cid = c.id;

      // Resolve the owning tenant explicitly. The outreach draft belongs to the
      // tenant that OWNS THE JOB — that recruiter performs and approves the
      // outreach in the job's Approvals queue, which is tenant-scoped. The
      // candidate's own tenantId must NOT win here: a platform-pool candidate
      // sourced onto another tenant's job carries her home tenant, and filing
      // the draft under it silently hides the draft from the job's recruiter.
      // Only fall back to the candidate tenant when there is no job context.
      // Never fall back to a hard-coded "acme" literal; if no real tenant can be
      // resolved, surface a loud failure instead of misfiling the message.
      const resolvedTenant = jobTenantId ?? c.tenantId;
      if (!resolvedTenant) {
        logger.error({ candidateId: cid, jobId }, "[outreach] skipped — could not resolve tenant for outreach message");
        messagesFailed++;
        sendErrors.push({ candidateId: cid, email: c.email, error: "Could not resolve tenant for outreach message" });
        continue;
      }

      // Single source of truth for first-touch generation (prompt, guardrail
      // verify/retry, deterministic enforcement, CTA-stripping) — shared with
      // the reject endpoint so a regenerated draft is byte-for-byte identical.
      const draft = await generateFirstTouchDraft({
        candidate: { name: candidateCtx.name, currentTitle: c.currentTitle, currentCompany: c.currentCompany, skills: c.skills },
        job: jobCtx,
        contextBlock: outreachContextBlock,
        hasBrandContext: outreachHasBrandContext,
        logCtx: { jobId, candidateId: cid },
      });

      const [msg] = await db.insert(outreachMessagesTable).values({
        jobId: jobId ?? "unknown",
        candidateId: cid,
        tenantId: resolvedTenant,
        subject: draft.subject,
        body: draft.body,
        status: requireApproval ? "pending_approval" : "queued",
        tone: draft.tone,
        callToAction: draft.callToAction,
        followUpSchedule: draft.followUpSchedule,
        estimatedOpenRate: draft.estimatedOpenRate?.toString(),
      }).returning();

      outreachIds.push(msg.id);

      if (requireApproval) {
        // Held for recruiter sign-off. Mark the sourced candidate as DRAFTED
        // (not sent) so repeat runs don't regenerate a second pending draft —
        // and do NOT advance the stage; that happens when it's approved + sent.
        messagesPending++;
        if (c.sourcedId) {
          const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, c.sourcedId)).limit(1);
          if (sc) {
            const raw = sc.rawData as any;
            await db.update(sourcedCandidatesTable).set({
              rawData: { ...raw, outreachDrafted: true, outreachMessageId: msg.id },
            }).where(eq(sourcedCandidatesTable.id, c.sourcedId));
          }
        }
        continue;
      }

      // ── Legacy immediate-send path (autoSendOutreach: true) ──────────────
      // Reuses the shared dispatcher so the recruiter-approval endpoint and the
      // orchestrator send a first-touch email exactly the same way.
      messagesQueued++;
      const dispatch = await dispatchOutreachMessage(msg.id, draft.body, draft.subject, c.email);
      if (dispatch.ok) {
        messagesSent++;
      } else {
        messagesFailed++;
        sendErrors.push({ candidateId: cid, email: c.email, error: dispatch.error });
      }

      // Mark sourced candidate as outreach sent + move to shortlisted stage —
      // ONLY when the dispatch actually succeeded. On failure leave it un-sent
      // so it is not falsely advanced and remains eligible for a retry.
      if (c.sourcedId && dispatch.ok) {
        if (jobId && resolvedTenant) {
          await changeCandidateStage({
            tenantId: resolvedTenant,
            candidateId: cid,
            jobId,
            to: "shortlisted",
            actor: { type: "agent", label: "Outreach Agent", runId },
            source: "agent_orchestrator",
            sourcedId: c.sourcedId,
            sourcedRawDataPatch: { outreachSent: true, outreachMessageId: msg.id },
          }).catch((e) => { logger.warn({ err: e, sourcedId: c.sourcedId }, "outreach stage-change failed"); });
        } else {
          // stage-write-exempt: no resolvable job/tenant — persist send flags only
          const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, c.sourcedId)).limit(1);
          if (sc) {
            const raw = sc.rawData as any;
            await db.update(sourcedCandidatesTable).set({
              rawData: { ...raw, outreachSent: true, outreachMessageId: msg.id, stage: "shortlisted" },
            }).where(eq(sourcedCandidatesTable.id, c.sourcedId));
          }
        }
      }
    }

    logger.info({ jobId, messagesPending, messagesQueued, messagesSent, messagesFailed, skipped: skippedUnverified.length, skippedNoEmail: skippedNoEmail.length, context: outreachContextSummary }, "Outreach generation complete");
    return { messagesPending, messagesQueued, messagesSent, messagesFailed, outreachIds, sendErrors, skippedUnverified, skippedNoEmail, requireApproval };
  }

  /* ── Interview Agent ─────────────────────────────────────────────────── */
  private async _runInterview(input: Record<string, any>): Promise<Record<string, any>> {
    const { jobId, candidateId, passedCandidateIds, questionCount = 5 } = input;
    const runId: string | null = (input as any)._runId ?? null;
    let { interviewType } = input as { interviewType?: string };

    if (!jobId) return { interviewLinksGenerated: 0, message: "No jobId provided" };

    const [jobForInterview] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!jobForInterview) return { interviewLinksGenerated: 0, message: "Job not found" };

    /* Approval gate: the pipeline interview agent must NOT generate interview
       links/sessions for a work order a recruiter_admin hasn't approved yet
       (pending_approval / draft / rejected). This is a system-triggered flow
       with no caller identity, so it never carries a platform_admin exemption —
       automated interviews simply do not fire until the work order is live. */
    if (!isJobApprovedForInterview(jobForInterview.status)) {
      logger.warn({ jobId, status: jobForInterview.status }, "[interview-agent] blocked — work order not approved");
      return { interviewLinksGenerated: 0, message: "Work order awaiting approval — no interviews generated" };
    }

    /* Resolve the interview type the right way:
     *   1. If the caller passed an explicit interviewType, use it (manual
     *      coordinator / API consumer wins).
     *   2. Otherwise read the recruiter's selection from the job's pipeline
     *      config (Workflow Canvas → "Interview Types"). When the
     *      recruiter picked exactly one type we use it directly; when they
     *      picked multiple we run with the first deterministically (more
     *      sophisticated multi-round support is a future enhancement).
     *   3. Empty selection → fall back to "general". */
    if (!interviewType) {
      const [pipelineCfg] = await db
        .select({ interviewTypes: jobPipelinesTable.interviewTypes })
        .from(jobPipelinesTable)
        .where(eq(jobPipelinesTable.jobId, jobId))
        .limit(1);
      const configured = (pipelineCfg?.interviewTypes as string[] | undefined) ?? [];
      interviewType = configured[0] ?? "general";
      if (configured.length > 1) {
        logger.info({ jobId, configured, picked: interviewType },
          "Interview: multiple types configured, running with first");
      }
    }

    const tenantId = jobForInterview.tenantId ?? "acme";
    const interviewLang = (jobForInterview as any).language ?? "en";
    const interviewLangInstruction = interviewLang !== "en"
      ? `IMPORTANT: Write every question, follow-up prompt, and text in the language with code "${interviewLang}". Do NOT write in English.`
      : "Write all questions in English.";

    // Build candidate list: explicit IDs first, then fall back to sourced+screened+advanced for this job
    let candidatesToInterview: Array<{ id: string; name: string; sourcedId?: string }> =
      (passedCandidateIds ?? (candidateId ? [candidateId] : [])).map((id: string) => ({ id, name: id }));

    // ── Eligibility gate: only AI-advanced + verified candidates may be interviewed ───
    // Applies to both explicit IDs and the auto-pulled fallback list. Reasons a candidate
    // is excluded:
    //   - screening recommendation is not "advance" (hold/reject stays in Screening)
    //   - source is "manual" but verificationStatus is not "verified"
    const skipped: Array<{ id: string; reason: string }> = [];
    const isEligible = async (cid: string): Promise<{ ok: boolean; reason?: string; sourcedId?: string }> => {
      // Find the matching sourced row (cid may be candidates.id OR sourced_candidates.id)
      const byCandidate = await db.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, cid)).limit(1);
      const byId = byCandidate.length === 0
        ? await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, cid)).limit(1)
        : [];
      const sourced = byCandidate[0] || byId[0];
      const raw = (sourced?.rawData as any) || {};

      // Gate 1: screening must say "advance"
      const rec = raw?.screeningResult?.recommendation;
      if (raw?.screened !== true) return { ok: false, reason: "not_yet_screened", sourcedId: sourced?.id };
      if (rec !== "advance") return { ok: false, reason: `screening_${rec ?? "unknown"}`, sourcedId: sourced?.id };

      // Gate 2: manual candidates must pass verification first
      const candId = sourced?.normalizedCandidateId;
      if (candId) {
        const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candId)).limit(1);
        if (cand && cand.source === "manual" && (cand.verificationStatus ?? "unverified") !== "verified") {
          return { ok: false, reason: "manual_unverified", sourcedId: sourced?.id };
        }
      }

      return { ok: true, sourcedId: sourced?.id };
    };

    if (candidatesToInterview.length > 0) {
      const filtered: typeof candidatesToInterview = [];
      for (const c of candidatesToInterview) {
        const e = await isEligible(c.id);
        if (e.ok) filtered.push({ ...c, sourcedId: e.sourcedId });
        else skipped.push({ id: c.id, reason: e.reason! });
      }
      candidatesToInterview = filtered;
    }

    if (candidatesToInterview.length === 0 && skipped.length === 0) {
      // Pull screened+passed sourced candidates for this job
      const allSourced = await db.select().from(sourcedCandidatesTable)
        .orderBy(desc(sourcedCandidatesTable.createdAt))
        .limit(50);

      const advanced = allSourced.filter(s => {
        const raw = s.rawData as any;
        return (raw?.jobId === jobId || !raw?.jobId)
          && raw?.screened === true
          && raw?.screeningResult?.recommendation === "advance"
          && !raw?.interviewSessionId; // don't re-create sessions
      });

      // Apply manual-verification gate to the fallback set as well
      const eligible: typeof advanced = [];
      for (const s of advanced) {
        const candId = s.normalizedCandidateId;
        if (!candId) { eligible.push(s); continue; }
        const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candId)).limit(1);
        if (cand && cand.source === "manual" && (cand.verificationStatus ?? "unverified") !== "verified") {
          skipped.push({ id: candId, reason: "manual_unverified" });
          continue;
        }
        eligible.push(s);
      }

      if (eligible.length === 0) {
        return {
          interviewLinksGenerated: 0,
          skipped,
          message: skipped.length > 0
            ? `No candidates eligible for interview. ${skipped.length} skipped (manually-added candidates must be verified, AI-Hold candidates need recruiter review).`
            : "No screened candidates ready for interview. Run Screening first.",
        };
      }

      logger.info({ jobId, count: eligible.length, skipped: skipped.length }, "Interview: scheduling sessions for screened candidates");

      for (const s of eligible.slice(0, 5)) {
        const raw = s.rawData as any;
        const name = `${raw?.firstName || ""} ${raw?.lastName || ""}`.trim() || "Candidate";
        candidatesToInterview.push({ id: s.id, name, sourcedId: s.id });
      }
    }

    if (candidatesToInterview.length === 0) {
      return {
        interviewLinksGenerated: 0,
        skipped,
        message: `No candidates eligible for interview. ${skipped.length} skipped (manually-added candidates must be verified, AI-Hold candidates need recruiter review).`,
      };
    }

    const linksGenerated: string[] = [];

    // Generate one shared interview plan for this job (reuse if exists)
    const existingPlans = await db.select().from(interviewPlansTable)
      .where(and(eq(interviewPlansTable.jobId, jobId), eq(interviewPlansTable.interviewType, interviewType as any)))
      .limit(1);

    let planId: string;

    if (existingPlans.length > 0) {
      planId = existingPlans[0].id;
      logger.info({ jobId, planId }, "Interview: reusing existing plan");
    } else {
      const questionsResult = await generateJSON<any>(
        `Generate ${questionCount} ${interviewType} interview questions for the role: ${jobForInterview.title ?? "this position"}.

${interviewLangInstruction}

Return a JSON array. Each element: { id (UUID), text (in the required language), category ("technical"|"behavioral"|"competency"|"situational"), followUpPrompts (array of 2, in the required language), order (int) }`,
        `You are Lexy's Interview Agent. Generate structured interview questions. Always respect the required language. Return a JSON array only.`,
      );

      const questions = Array.isArray(questionsResult) ? questionsResult : [];
      const [plan] = await db.insert(interviewPlansTable).values({
        tenantId,
        jobId,
        title: `${interviewType.charAt(0).toUpperCase() + interviewType.slice(1)} Interview — ${jobForInterview.title}`,
        interviewType: interviewType as any,
        language: interviewLang,
        questions: questions.map((q: any, i: number) => ({ ...q, id: q.id || crypto.randomUUID(), order: i + 1 })),
        estimatedDurationMinutes: questionCount * 8,
      }).returning();
      planId = plan.id;
    }

    const [planRow] = await db.select().from(interviewPlansTable).where(eq(interviewPlansTable.id, planId)).limit(1);

    for (const c of candidatesToInterview) {
      try {
        const [session] = await db.insert(interviewSessionsTable).values({
          tenantId,
          applicationId: "pipeline",
          planId,
          candidateId: c.id,
          language: interviewLang,
          status: "scheduled",
          currentQuestionIndex: 0,
          totalQuestions: (planRow?.questions as any[])?.length ?? questionCount,
          answers: [],
        }).returning();

        linksGenerated.push(session.id);

        // Mark sourced candidate with interview session ID and stage
        if (c.sourcedId) {
          await changeCandidateStage({
            tenantId,
            candidateId: c.id,
            jobId,
            to: "interview",
            actor: { type: "agent", label: "Interview Agent", runId },
            source: "agent_orchestrator",
            sourcedId: c.sourcedId,
            sourcedRawDataPatch: { interviewSessionId: session.id },
          }).catch((e) => { logger.warn({ err: e, sourcedId: c.sourcedId }, "interview stage-change failed"); });
        }

        await db.update(outreachMessagesTable)
          .set({ interviewLink: `/interviews/${session.id}/room`, status: "sent", sentAt: new Date() })
          .where(and(eq(outreachMessagesTable.candidateId, c.id), eq(outreachMessagesTable.jobId, jobId)));

        /* ── Email the full interview link to the candidate ──────────── */
        // Resolve recipient email + name from the sourced raw payload first
        // (cheapest), then fall back to the canonical candidates table.
        let toEmail: string | null = null;
        let toName: string = (c as any).name || "Candidate";
        if (c.sourcedId) {
          const [sc] = await db.select().from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, c.sourcedId)).limit(1);
          const raw: any = sc?.rawData || {};
          toEmail = raw.email || raw.contactInfo?.email || null;
          if (!toName || toName === "Candidate") {
            const nm = `${raw.firstName || ""} ${raw.lastName || ""}`.trim();
            if (nm) toName = nm;
          }
          if (!toEmail && sc?.normalizedCandidateId) {
            const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, sc.normalizedCandidateId)).limit(1);
            toEmail = cand?.email || null;
            if (cand && (!toName || toName === "Candidate")) toName = `${cand.firstName} ${cand.lastName}`.trim();
          }
        } else {
          const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, c.id)).limit(1);
          toEmail = cand?.email || null;
          if (cand && (!toName || toName === "Candidate")) toName = `${cand.firstName} ${cand.lastName}`.trim();
        }

        if (toEmail) {
          const baseUrl = process.env.PUBLIC_APP_URL
            || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
            || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");
          const fullLink = `${baseUrl}/interviews/${session.id}/room`;
          const firstName = toName.split(" ")[0] || "there";
          const subject = `Your interview for ${jobForInterview.title}`;
          const body = `Hi ${firstName},

Great news — you've been shortlisted for the ${jobForInterview.title} role at ${jobForInterview.companyName || "our company"}, and we'd like to invite you to a short AI-powered video interview.

Click the link below to start whenever you're ready (it should take about ${(planRow as any)?.estimatedDurationMinutes ?? questionCount * 8} minutes):

${fullLink}

The link is unique to you — please don't share it. If you have any trouble loading the interview, just reply to this email.

Looking forward to your responses,
The ${jobForInterview.companyName || "Hiring"} Team`;

          try {
            const sendResult = await sendEmail({
              to: toEmail,
              subject,
              html: plainToHtml(body),
              text: body,
            });
            if (sendResult.ok) {
              logger.info({ to: toEmail, sessionId: session.id, simulated: !!sendResult.simulated }, "[interview] invite email dispatched");
            } else {
              logger.error({ to: toEmail, sessionId: session.id, err: sendResult.error }, "[interview] invite email failed");
            }
          } catch (err: any) {
            logger.error({ to: toEmail, sessionId: session.id, err: err?.message }, "[interview] invite email threw");
          }
        } else {
          logger.warn({ cid: c.id, sessionId: session.id }, "[interview] no email on candidate – invite not sent");
        }
      } catch (err: any) {
        logger.error({ cid: c.id, err: err?.message }, "Interview: failed to create session");
      }
    }

    logger.info({ jobId, sessionsCreated: linksGenerated.length }, "Interview agent completed");

    return {
      interviewLinksGenerated: linksGenerated.length,
      sessionIds: linksGenerated,
      planId,
      candidatesProcessed: candidatesToInterview.length,
    };
  }

  /* ── Anti-Ghosting Agent ─────────────────────────────────────────────── */
  private async _runAntiGhosting(input: Record<string, any>): Promise<Record<string, any>> {
    const { candidateId, silentDays, jobId } = input;

    const sentMessages = jobId
      ? await db.select().from(outreachMessagesTable)
          .where(and(eq(outreachMessagesTable.jobId, jobId), eq(outreachMessagesTable.status, "sent")))
          .limit(20)
      : [];

    const noReplyCandidates = sentMessages.filter(m => !m.repliedAt);

    if (noReplyCandidates.length === 0 && !candidateId) {
      return { riskLevel: "low", followUpsSent: 0, message: "No silent candidates detected" };
    }

    let candidateCtx: any = input;
    if (candidateId) {
      const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
      const apps = await db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, candidateId));
      if (c) candidateCtx = { name: `${c.firstName} ${c.lastName}`, currentTitle: c.currentTitle, applications: apps.map(a => ({ stage: a.stage, updatedAt: a.updatedAt })), silentDays };
    }

    const result = await generateJSON<any>(
      `Analyze this candidate's engagement and determine the anti-ghosting strategy.

Context:
${JSON.stringify(candidateCtx, null, 2)}
Silent candidates without reply: ${noReplyCandidates.length}

Return JSON:
{
  "riskLevel": "low" | "medium" | "high" | "critical",
  "riskReason": string,
  "recommendedAction": "wait" | "send_nudge" | "call" | "escalate_to_recruiter" | "close",
  "messageTemplate": string,
  "urgency": "low" | "medium" | "high",
  "estimatedDropoffProbability": number (0-100)
}`,
      "You are Lexy's Anti-Ghosting Agent. Analyze candidate silence and craft effective follow-up strategies. JSON only.",
    );

    return { ...result, followUpsSent: noReplyCandidates.length, candidatesAtRisk: noReplyCandidates.length };
  }

  /* ── Verification Agent ─────────────────────────────────────────────── */
  private async _runVerification(input: Record<string, any>): Promise<Record<string, any>> {
    const { candidateId, jobId } = input;

    // --- Path 1: verify single candidate by ID
    if (candidateId) {
      const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
      const candidateCtx = c
        ? { name: `${c.firstName} ${c.lastName}`, email: c.email, phone: c.phone, linkedinUrl: c.linkedinUrl, currentTitle: c.currentTitle, currentCompany: c.currentCompany, skills: c.skills }
        : input;

      const result = await generateJSON<any>(
        `Run digital identity verification on this candidate.\n\nCandidate data:\n${JSON.stringify(candidateCtx, null, 2)}\n\nReturn JSON: { "linkedinMatch": "verified"|"partial"|"unverified"|"mismatch", "resumeConsistency": "consistent"|"minor_discrepancies"|"major_discrepancies", "emailValidity": "valid"|"suspicious"|"disposable", "profileCompleteness": number, "riskFlags": string[], "overallScore": number, "verdict": "clear"|"review"|"flag", "notes": string }`,
        "You are Lexy's Verification Agent. Conduct thorough digital identity checks. JSON only.",
      );

      if (result.verdict) {
        const verificationStatus = result.verdict === "clear" ? "verified" : result.verdict === "flag" ? "flagged" : "pending";
        await db.update(candidatesTable).set({ verificationStatus: verificationStatus as any, updatedAt: new Date() }).where(eq(candidatesTable.id, candidateId));
      }
      return { verified: 1, results: [{ candidateId, ...result }] };
    }

    // --- Path 2: bulk-verify screening-stage sourced candidates for this job
    if (!jobId) return { verified: 0, message: "No jobId or candidateId provided" };

    const runId: string | null = (input as any)._runId ?? null;
    const verifyTenantId: string | null =
      (await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1))[0]?.tenantId ?? null;

    const sourced = await db.select().from(sourcedCandidatesTable)
      .orderBy(desc(sourcedCandidatesTable.createdAt))
      .limit(50);

    const forVerification = sourced.filter(s => {
      const raw = s.rawData as any;
      if (raw?.jobId !== jobId) return false;
      // Process candidates that are in "screening" stage (screened but not yet verified)
      const stage = raw?.stage;
      const screened = raw?.screened === true;
      const explicitStage = stage && stage !== "sourced";
      if (explicitStage) return stage === "screening";
      return screened && raw?.screeningResult?.recommendation !== "reject";
    });

    if (forVerification.length === 0) {
      return { verified: 0, message: "No candidates in screening stage ready for verification. Run Screening agent first." };
    }

    logger.info({ jobId, count: forVerification.length }, "Verification: processing screening-stage candidates");

    const verificationResults: any[] = [];
    let verified = 0;
    let passedIds: string[] = [];

    for (const s of forVerification.slice(0, 20)) {
      const raw = s.rawData as any;
      const ctx = {
        name: `${raw?.firstName || ""} ${raw?.lastName || ""}`.trim(),
        email: raw?.email || null,
        linkedinUrl: raw?.linkedinUrl || null,
        currentTitle: raw?.currentTitle || "",
        currentCompany: raw?.currentCompany || "",
        location: raw?.location || "",
        skills: raw?.skills || [],
        source: s.source,
      };

      const result = await generateJSON<any>(
        `Run digital identity verification on this candidate.\n\nCandidate data:\n${JSON.stringify(ctx, null, 2)}\n\nReturn JSON: { "linkedinMatch": "verified"|"partial"|"unverified"|"mismatch", "resumeConsistency": "consistent"|"minor_discrepancies"|"major_discrepancies", "emailValidity": "valid"|"suspicious"|"disposable", "profileCompleteness": number (0-100), "riskFlags": string[], "overallScore": number (0-100), "verdict": "clear"|"review"|"flag", "notes": string }`,
        "You are Lexy's Verification Agent. Conduct thorough digital identity checks. JSON only.",
      );

      // Advance clear/review candidates to "verification" stage; flag → rejected
      const nextStage = result.verdict === "flag" ? "rejected" : "verification";
      const verificationStatus = result.verdict === "clear" ? "verified" : result.verdict === "flag" ? "flagged" : "pending";

      if (s.normalizedCandidateId && verifyTenantId) {
        await changeCandidateStage({
          tenantId: verifyTenantId,
          candidateId: s.normalizedCandidateId,
          jobId: jobId as string,
          to: nextStage,
          actor: { type: "agent", label: "Verification Agent", runId },
          source: "agent_orchestrator",
          sourcedId: s.id,
          sourcedRawDataPatch: { verified: true, verificationResult: result, verificationStatus },
        }).catch((e) => { logger.warn({ err: e, sourcedId: s.id }, "verification stage-change failed"); });
      } else {
        // stage-write-exempt: pre-normalized sourced row has no canonical candidate id to audit
        await db.update(sourcedCandidatesTable).set({
          rawData: { ...raw, stage: nextStage, verified: true, verificationResult: result, verificationStatus },
        }).where(eq(sourcedCandidatesTable.id, s.id));
      }

      // Also update normalized candidate record if linked
      const nid = s.normalizedCandidateId;
      if (nid) {
        await db.update(candidatesTable).set({ verificationStatus: verificationStatus as any, updatedAt: new Date() })
          .where(eq(candidatesTable.id, nid)).catch(() => {});
      }

      if (nextStage === "verification") passedIds.push(s.normalizedCandidateId || s.id);
      verificationResults.push({ sourcedId: s.id, candidateId: s.normalizedCandidateId || s.id, stage: nextStage, ...result });
      verified++;
    }

    logger.info({ jobId, verified, passed: passedIds.length }, "Verification completed");
    return { verified, passed: passedIds.length, passedCandidateIds: passedIds, verificationResults };
  }

  /* ── Scheduling Agent ─────────────────────────────────────────────────── */
  private async _runScheduling(input: Record<string, any>): Promise<Record<string, any>> {
    const { jobId, passedCandidateIds } = input;

    const candidateIds: string[] = passedCandidateIds ?? [];
    if (candidateIds.length === 0 && jobId) {
      const msgs = await db.select().from(outreachMessagesTable)
        .where(and(eq(outreachMessagesTable.jobId, jobId), eq(outreachMessagesTable.status, "sent")))
        .limit(10);
      candidateIds.push(...msgs.map(m => m.candidateId));
    }

    if (candidateIds.length === 0) {
      return { scheduled: 0, message: "No candidates to schedule" };
    }

    const inviteDetails = await generateJSON<any>(
      `Generate interview scheduling details for ${candidateIds.length} candidates.

Context: ${JSON.stringify({ jobId, candidateCount: candidateIds.length }, null, 2)}

Return JSON:
{
  "proposedSlots": [{ "date": string, "time": string, "timezone": string, "durationMinutes": number }],
  "inviteSubject": string,
  "inviteBody": string,
  "reminderSchedule": [{ "hoursBeforeInterview": number, "message": string }],
  "timezone": string
}`,
      "You are Lexy's Scheduling Agent. Generate professional interview invitations. JSON only.",
    );

    return {
      ...inviteDetails,
      scheduled: candidateIds.length,
      candidatesScheduled: candidateIds,
    };
  }

  /* ── Analytics Agent ─────────────────────────────────────────────────── */
  private async _runAnalytics(input: Record<string, any>): Promise<Record<string, any>> {
    const [candidateCount] = await db.select({ count: sql<number>`count(*)` }).from(candidatesTable);
    const [jobCount]       = await db.select({ count: sql<number>`count(*)` }).from(jobsTable);
    const [appCount]       = await db.select({ count: sql<number>`count(*)` }).from(applicationsTable);
    const [sessionCount]   = await db.select({ count: sql<number>`count(*)` }).from(interviewSessionsTable);
    const [outreachCount]  = await db.select({ count: sql<number>`count(*)` }).from(outreachMessagesTable);
    const [sourcedCount]   = await db.select({ count: sql<number>`count(*)` }).from(sourcedCandidatesTable);

    const completedSessions = await db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.status, "completed")).limit(50);
    const avgScore = completedSessions.length > 0
      ? completedSessions.reduce((s, r) => s + (r.score ?? 0), 0) / completedSessions.length
      : 0;

    const pipelineSnapshot = {
      totalCandidates: Number(candidateCount.count),
      totalJobs: Number(jobCount.count),
      totalApplications: Number(appCount.count),
      totalInterviews: Number(sessionCount.count),
      completedInterviews: completedSessions.length,
      avgInterviewScore: Math.round(avgScore),
      outreachMessagesSent: Number(outreachCount.count),
      candidatesSourced: Number(sourcedCount.count),
      period: input.period ?? "all_time",
    };

    const result = await generateJSON<any>(
      `Analyze this hiring pipeline data and surface actionable insights.

Pipeline snapshot:
${JSON.stringify(pipelineSnapshot, null, 2)}

Return JSON:
{
  "conversionRate": string,
  "bottleneck": string,
  "trend": "improving" | "stable" | "declining",
  "avgTimeToHire": number,
  "recommendation": string,
  "alerts": string[],
  "highlights": string[],
  "kpis": { [name: string]: string | number }
}`,
      "You are Lexy's Analytics Agent. Analyze hiring pipeline data to identify bottlenecks and surface trends. JSON only.",
    );

    return { ...result, snapshot: pipelineSnapshot };
  }

  /* ── Intelligence Feeder ─────────────────────────────────────────────────
   * Called after every successful agent run. Maps agent output to typed
   * AgentSignals and calls upsertIntelligence for each affected candidate.
   * Failures are swallowed — this is non-critical enrichment.
   */
  private async _feedIntelligence(agentId: AgentId, input: Record<string, any>, output: Record<string, any>): Promise<void> {
    let tenantId = input.tenantId as string | undefined;
    const jobId    = input.jobId as string | undefined;
    /* Never stamp intelligence rows with a hard-coded "acme" tenant. When the
     * agent input lacks a tenant, derive it from the canonical job. If neither
     * yields a real tenant, skip the feed rather than corrupt multi-tenant data
     * (a mis-stamped row becomes invisible to its real tenant's surfaces). */
    if (!tenantId && jobId) {
      const [j] = await db
        .select({ tenantId: jobsTable.tenantId })
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId))
        .limit(1);
      tenantId = j?.tenantId ?? undefined;
    }

    const feed = async (candidateId: string, signals: Record<string, any>) => {
      if (!tenantId || !jobId || !candidateId) return;
      try { await upsertIntelligence(tenantId, jobId, candidateId, signals); } catch { /* skip */ }
    };

    switch (agentId) {
      case "screening": {
        const results: any[] = output.screeningResults ?? [];
        for (const r of results) {
          // Persist the screening feed IMMEDIATELY — never wait on network-bound
          // work in the hot path.
          await feed(r.candidateId, {
            screening: {
              score: r.score, resumeMatchScore: r.score, skillMatchScore: r.score,
              strengthAreas: r.strengthAreas, gapAreas: r.gapAreas,
              gapFlags: r.gapAreas, recommendation: r.recommendation,
            },
          });
          // Real similar-hire embedding signal (Task #26). Fire-and-forget so the
          // screening feed is not blocked by the embedding + LLM-fallback round
          // trips. The producer embeds the candidate (corpus building) and
          // computes the ICP-pattern slice of fitScore via kNN vs real successful
          // hires (or the LLM-vs-ICP fallback), then merges it back via a second
          // analytics-only upsert. Bounded by a per-candidate budget; on
          // timeout/failure prior behavior is left intact.
          if (jobId && r.candidateId) {
            void this._enrichSimilarHire(tenantId, jobId, r.candidateId);
          }
        }
        break;
      }
      case "sourcing": {
        const scores: any[] = output.scores ?? [];
        for (const s of scores) {
          await feed(s.candidateId, {
            sourcing: {
              sourceConfidence: s.score,
              profileCompleteness: Math.min(100, s.score + 10),
              passiveCandidateScore: s.score,
            },
          });
        }
        break;
      }
      case "verification": {
        // Handle bulk results array (new format) or single-candidate (legacy)
        const verResults: any[] = output.verificationResults ?? (output.results ?? []);
        for (const r of verResults) {
          const cid = r.candidateId || input.candidateId;
          if (!cid) continue;
          await feed(cid, {
            verification: {
              identityConfidence: r.overallScore ?? output.overallScore,
              linkedinMatchScore:
                (r.linkedinMatch ?? output.linkedinMatch) === "verified" ? 90 :
                (r.linkedinMatch ?? output.linkedinMatch) === "partial"   ? 60 : 30,
              resumeConsistencyScore:
                (r.resumeConsistency ?? output.resumeConsistency) === "consistent"          ? 90 :
                (r.resumeConsistency ?? output.resumeConsistency) === "minor_discrepancies" ? 65 : 30,
              emailValidity: (r.emailValidity ?? output.emailValidity) === "valid",
              verdict: r.verdict ?? output.verdict,
            },
          });
        }
        break;
      }
      case "anti-ghosting": {
        const cid = input.candidateId;
        if (cid) {
          const riskMap: Record<string, number> = { critical: 90, high: 70, medium: 45, low: 20 };
          await feed(cid, {
            antiGhosting: {
              ghostingRiskScore: output.estimatedDropoffProbability ?? riskMap[output.riskLevel] ?? 30,
              engagementDecayScore: riskMap[output.riskLevel] ?? 30,
            },
          });
        }
        break;
      }
      case "proctoring": {
        let cid = input.candidateId;
        if (!cid && input.sessionId) {
          try {
            const [s] = await db.select({ candidateId: interviewSessionsTable.candidateId })
              .from(interviewSessionsTable).where(eq(interviewSessionsTable.id, input.sessionId)).limit(1);
            cid = s?.candidateId;
          } catch { /* ignore */ }
        }
        if (cid) {
          const risk = output.riskScore ?? 10;
          await feed(cid, {
            proctoring: {
              riskScore: risk, fraudRiskScore: risk,
              integrityScore: 100 - risk,
              gazeAnomalyFlag: output.checks?.gazeOnCamera?.pass === false,
              multipleFacesFlag: (output.flags ?? []).includes("multiple_faces"),
            },
          });
        }
        break;
      }
      case "outreach": {
        const cids: string[] = [
          ...(output.passedCandidateIds ?? []),
          ...(input.passedCandidateIds  ?? []),
          ...(input.candidateId ? [input.candidateId] : []),
        ];
        for (const cid of [...new Set(cids)]) {
          await feed(cid, {
            outreach: {
              openRate:           Number(output.estimatedOpenRate ?? 50),
              replyRate:          0,
              positiveReplyScore: 0,
            },
          });
        }
        break;
      }
      case "scheduling": {
        const cids: string[] = output.candidatesScheduled ?? input.passedCandidateIds ?? [];
        for (const cid of cids) {
          await feed(cid, {
            scheduling: { schedulingFrictionScore: 20, rescheduleCount: 0, noShowRisk: 25 },
          });
        }
        break;
      }
      default:
        break; /* icp, interview, analytics — no per-candidate signal here */
    }
  }

  /**
   * Background (fire-and-forget) similar-hire enrichment for one screened
   * candidate (Task #26). Runs OFF the screening hot path: it embeds the
   * candidate (corpus building), computes the ICP-pattern slice of fitScore
   * (kNN vs real successful hires, or LLM-vs-ICP fallback), and merges only the
   * analytics.similarHirePatternScore back via upsertIntelligence (which merges
   * signals, so the already-persisted screening signal is preserved). Bounded by
   * a hard per-candidate budget; on timeout or any failure it does nothing and
   * prior behavior is left intact. Never throws.
   */
  private async _enrichSimilarHire(tenantId: string, jobId: string, candidateId: string): Promise<void> {
    try {
      const [cand] = await db.select().from(candidatesTable)
        .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)))
        .limit(1);
      if (!cand) return;
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SIMILAR_HIRE_ENRICH_BUDGET_MS));
      const sim = await Promise.race([
        computeSimilarHirePatternScore({
          tenantId, jobId,
          candidate: {
            id: cand.id,
            firstName: cand.firstName, lastName: cand.lastName,
            currentTitle: cand.currentTitle, currentCompany: cand.currentCompany,
            skills: cand.skills, location: cand.location,
          },
        }),
        timeout,
      ]);
      if (sim) {
        try {
          await upsertIntelligence(tenantId, jobId, candidateId, {
            analytics: {
              similarHirePatternScore: sim.score,
              // Provenance (similar-hire transparency): lets the UI say WHEN
              // the pattern-match signal (vs the LLM fallback) is active.
              similarHireSource: sim.source,
              similarHireExemplarCount: sim.exemplarCount,
            },
          } as AgentSignals);
        } catch { /* merge-only enrichment — leave prior behavior intact */ }
      }
    } catch { /* best-effort background enrichment */ }
  }

  /* ── Proctoring Agent (reads real proctoring_events from DB) ─────────── */
  private async _runProctoring(input: Record<string, any>): Promise<Record<string, any>> {
    const { sessionId, jobId, tenantId } = input;

    /* Helper: compute integrity report from a session's raw events */
    const analyseSession = (session: typeof interviewSessionsTable.$inferSelect) => {
      const events: any[] = (session.proctoring_events as any[]) ?? [];

      const tabSwitches   = events.filter(e => e.type === "tab_switch").length;
      const copyAttempts  = events.filter(e => e.type === "copy").length;
      const pasteAttempts = events.filter(e => e.type === "paste").length;
      const rightClicks   = events.filter(e => e.type === "right_click").length;
      const snapshots     = events.filter(e => e.type === "snapshot");
      const noFace        = snapshots.filter(e => e.faceVisible === false).length;
      const multiFace     = snapshots.filter(e => (e.faceCount ?? 0) > 1).length;
      const suspicious    = snapshots.filter(e => e.suspiciousActivity).length;
      const snapshotTotal = snapshots.length;

      const faceOkPct   = snapshotTotal > 0 ? Math.round(((snapshotTotal - noFace) / snapshotTotal) * 100) : 100;
      const gazeOkPct   = snapshotTotal > 0 ? Math.round(((snapshotTotal - suspicious) / snapshotTotal) * 100) : 100;

      /* Deduct from 100: tab-switch −10, copy −5, paste −8, no-face −5, multi-face −15, suspicious −12 */
      let integrityScore = 100;
      integrityScore -= tabSwitches  * 10;
      integrityScore -= copyAttempts * 5;
      integrityScore -= pasteAttempts * 8;
      integrityScore -= noFace       * 5;
      integrityScore -= multiFace    * 15;
      integrityScore -= suspicious   * 12;
      integrityScore = Math.max(0, Math.min(100, integrityScore));

      const riskScore = 100 - integrityScore;
      const trustLevel = integrityScore >= 85 ? "low_risk" : integrityScore >= 60 ? "medium_risk" : "high_risk";

      const flags: string[] = [];
      if (tabSwitches > 0)  flags.push(`tab_switches_${tabSwitches}`);
      if (multiFace > 0)    flags.push("multiple_faces");
      if (noFace > 0)       flags.push("face_absent");
      if (suspicious > 0)   flags.push("suspicious_activity");
      if (copyAttempts > 0) flags.push(`copy_attempts_${copyAttempts}`);

      const notes = events.length === 0
        ? (session.status === "completed"
            ? "Session completed but no proctoring events were recorded — candidate may have used an older session link."
            : "Session not yet started — proctoring activates automatically when the candidate joins the interview room.")
        : integrityScore >= 85
          ? `Session integrity verified. Score ${integrityScore}/100. ${snapshotTotal} face checks passed.`
          : integrityScore >= 60
            ? `Session flagged for review. Score ${integrityScore}/100. Violations: ${flags.join(", ")}.`
            : `High-risk session. Score ${integrityScore}/100. Multiple integrity violations detected: ${flags.join(", ")}.`;

      return {
        sessionId: session.id,
        candidateId: session.candidateId,
        status: session.status,
        totalEvents: events.length,
        framesSampled: snapshotTotal,
        riskScore,
        integrityScore,
        trustLevel,
        flags,
        checks: {
          facePresent:  { pass: faceOkPct >= 80,    pct: faceOkPct },
          gazeOnCamera: { pass: gazeOkPct >= 85,    pct: gazeOkPct },
          tabSwitches:  { pass: tabSwitches === 0,  count: tabSwitches },
          copyPaste:    { pass: copyAttempts + pasteAttempts === 0, count: copyAttempts + pasteAttempts },
          multipleFaces:{ pass: multiFace === 0,    count: multiFace },
        },
        verdict: trustLevel,
        notes,
      };
    };

    /* ── Job-level scan: review all sessions for this job ── */
    if (!sessionId && jobId) {
      const plans = await db.select().from(interviewPlansTable)
        .where(eq(interviewPlansTable.jobId, jobId)).limit(10);
      const planIds = new Set(plans.map(p => p.id));

      if (planIds.size === 0) {
        return { sessionsReviewed: 0, message: "No interview plans found for this job." };
      }

      /* Fetch all sessions for these plans */
      const allSessions = await db.select().from(interviewSessionsTable).limit(100);
      const jobSessions = allSessions.filter(s => planIds.has(s.planId));

      if (jobSessions.length === 0) {
        return { sessionsReviewed: 0, message: "No interview sessions found for this job. Run the Interview agent first." };
      }

      const results = jobSessions.map(analyseSession);
      const highRisk = results.filter(r => r.trustLevel === "high_risk").length;
      const medRisk  = results.filter(r => r.trustLevel === "medium_risk").length;
      const avgScore = Math.round(results.reduce((a, r) => a + r.integrityScore, 0) / results.length);

      logger.info({ jobId, sessionsReviewed: results.length, highRisk, avgScore }, "[proctor] Job-level scan complete");

      return {
        sessionsReviewed: results.length,
        averageIntegrityScore: avgScore,
        highRiskCount: highRisk,
        mediumRiskCount: medRisk,
        overallVerdict: highRisk > 0 ? "high_risk" : medRisk > 0 ? "medium_risk" : "low_risk",
        sessions: results,
        riskScore: 100 - avgScore,
      };
    }

    /* ── Single-session run ── */
    if (sessionId) {
      const [session] = await db.select().from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.id, sessionId)).limit(1);

      if (!session) {
        return { sessionId, error: "Session not found." };
      }

      const result = analyseSession(session);
      logger.info({ sessionId, integrityScore: result.integrityScore, riskScore: result.riskScore, flags: result.flags }, "[proctor] Single-session analysis complete");
      return result;
    }

    return { error: "Provide sessionId or jobId to run the Proctoring Agent." };
  }
}

/* ─── Screening helpers ──────────────────────────────────────────────────
 * The screening prompt is shared between the "screen by candidateId" path
 * and the "screen sourced for jobId" path. It must be lenient with sparse
 * profiles (manually-imported candidates often only have title + skills),
 * recognise implicit skills (a "WordPress developer" obviously knows
 * HTML/CSS/JS/PHP/MySQL), treat preferred skills as bonus rather than
 * required, and never reject solely on missing data.
 */
const SCREENING_SYSTEM_PROMPT =
  "You are Lexy's Screening Agent. You evaluate candidates fairly against a job's ICP. " +
  "Be pragmatic, not pedantic — recognise implicit skills (e.g. a WordPress developer " +
  "implicitly knows HTML, CSS, JavaScript, PHP, MySQL), treat preferred skills as bonus " +
  "(not required), and never reject solely because a profile is sparse — recommend 'hold' " +
  "for review when info is missing rather than 'reject'. Only recommend 'reject' when there " +
  "is positive evidence that the candidate is a poor fit (wrong domain entirely, explicit " +
  "disqualifier matched, or fundamental required skill clearly absent). Output JSON only.";

function buildScreeningPrompt(ctx: any, icp: any | null): string {
  const candidateBlock = JSON.stringify(ctx, null, 2);
  let icpBlock = "No ICP provided — score on profile relevance and quality alone.";
  if (icp) {
    icpBlock = [
      icp.requiredSkills?.length ? `Required skills: ${icp.requiredSkills.join(", ")}` : null,
      icp.preferredSkills?.length ? `Preferred (bonus only) skills: ${icp.preferredSkills.join(", ")}` : null,
      icp.mustHaves?.length ? `Must-haves: ${icp.mustHaves.join(", ")}` : null,
      icp.disqualifiers?.length ? `Disqualifiers: ${icp.disqualifiers.join(", ")}` : null,
      icp.seniority ? `Target seniority: ${icp.seniority}` : null,
      icp.yearsExperienceMin != null ? `Min years experience: ${icp.yearsExperienceMin}` : null,
    ].filter(Boolean).join("\n");
  }

  return [
    "Screen this candidate against the job's ICP. Apply the rules in your system prompt.",
    "",
    "## Candidate",
    candidateBlock,
    "",
    "## Job ICP",
    icpBlock,
    "",
    "## Scoring rubric",
    "- 80-100: clear strong fit — recommend 'advance'",
    "- 55-79: plausible fit, missing some info — recommend 'hold' for human review",
    "- 30-54: weak signal but not disqualifying — recommend 'hold'",
    "- 0-29:  clear mismatch (wrong domain, disqualifier present) — recommend 'reject'",
    "",
    "## Important",
    "- If the candidate's listed skills overlap with required skills, that is a STRONG positive signal.",
    "- Do NOT list implicit/foundational skills (HTML, CSS, JS for a web dev) under missingSkills.",
    "- Do NOT list preferred skills under missingSkills — they are bonus, not gaps.",
    "- If years of experience isn't stated, do NOT assume it's missing — leave a note in gapAreas instead and lean toward 'hold'.",
    "- A WordPress developer applying to a WordPress role is a STRONG fit unless an explicit disqualifier matches.",
    "",
    "Return JSON only with this shape:",
    `{ "score": number 0-100, "extractedSkills": string[], "missingSkills": string[], "strengthAreas": string[], "gapAreas": string[], "recruiterSummary": string, "recommendation": "advance"|"hold"|"reject", "confidence": "high"|"medium"|"low" }`,
  ].join("\n");
}

/**
 * Email the assigned recruiter when a batch of candidates lands in the
 * Screening stage so they can review the top picks.  Sends one summary per
 * batch (not per candidate) and is fire-and-forget — never blocks the agent
 * run.  No-ops if the job has no recruiter assigned or no rows were screened.
 */
async function notifyRecruiterOfScreeningBatch(
  jobId: string | undefined,
  screeningResults: Array<{ name?: string; score?: number; recommendation?: string }>,
  triggeredBy: string = "user",
): Promise<void> {
  try {
    if (!jobId || !screeningResults?.length) return;

    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job?.assignedRecruiterId) return;

    const [recruiter] = await db.select().from(usersTable)
      .where(eq(usersTable.id, job.assignedRecruiterId)).limit(1);
    if (!recruiter?.email) return;

    // Sort by score desc so the recruiter sees the strongest first
    const ordered = [...screeningResults].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const advanceCount = ordered.filter((r) => r.recommendation === "advance").length;
    const holdCount = ordered.filter((r) => r.recommendation === "hold").length;
    const rejectCount = ordered.filter((r) => r.recommendation === "reject").length;

    // -------------------------------------------------------------------
    // Routing: real-time vs. daily digest.
    //   • If the recruiter clicked a button (triggeredBy === "user") OR
    //     their preference is "realtime", send the email right now.
    //   • Otherwise, queue it for the next 08:00 local digest.
    //   • If the recruiter is "off" for digests, skip entirely (decision
    //     events still go real-time elsewhere).
    // -------------------------------------------------------------------
    const userPick = (recruiter as any).notificationFrequency || "digest";
    const isManual = triggeredBy === "user";
    if (!isManual && userPick === "off") {
      logger.info({ recruiterId: recruiter.id, jobId }, "[screening-notify] skipped (recruiter opted out)");
      return;
    }
    if (!isManual && userPick === "digest") {
      const { recruiterDigestQueueTable } = await import("@workspace/db");
      // Tag the queue row with the RECRUITER's tenant, not the job's
      // tenant. Sourced candidates can live in a different tenant from
      // the recruiter (e.g. cross-tenant talent pools), and the
      // tenant-scoped drain endpoint filters by `recruiter_digest_queue.
      // tenant_id`. Using the job tenant caused tenant_admins to never
      // see notifications meant for their own recruiters. The job tenant
      // is preserved inside the payload for analytics / display.
      const recruiterTenantId = (recruiter as any).tenantId || job.tenantId;
      await db.insert(recruiterDigestQueueTable).values({
        tenantId: recruiterTenantId,
        recruiterId: recruiter.id,
        jobId,
        eventType: "screening.batch",
        payload: {
          jobTitle: job.title,
          jobTenantId: job.tenantId,
          totalScreened: ordered.length,
          advanceCount, holdCount, rejectCount,
          candidates: ordered.slice(0, 50).map((r) => ({
            name: r.name ?? "Unnamed",
            score: r.score ?? null,
            recommendation: r.recommendation ?? "hold",
          })),
        },
      });
      const { recordAudit } = await import("../audit");
      void recordAudit({
        tenantId: recruiterTenantId,
        actorType: "system",
        actorLabel: "Screening Agent",
        subjectType: "user",
        subjectId: recruiter.id,
        subjectLabel: recruiter.name || recruiter.email,
        channel: "system",
        direction: "internal",
        action: "digest.queued.screening_batch",
        title: `Queued for daily digest: ${ordered.length} candidate${ordered.length === 1 ? "" : "s"} screened`,
        body: `Job: ${job.title} · ${advanceCount} advance · ${holdCount} hold · ${rejectCount} reject`,
        metadata: { jobId, totalScreened: ordered.length, advanceCount, holdCount, rejectCount, triggeredBy },
      });
      logger.info(
        { recruiterId: recruiter.id, jobId, totalScreened: ordered.length, triggeredBy },
        "[screening-notify] queued for daily digest",
      );
      return;
    }
    // Fall through to real-time email below.

    const rows = ordered.slice(0, 25).map((r) => {
      const rec = r.recommendation || "hold";
      const badgeColor = rec === "advance" ? "#16a34a" : rec === "reject" ? "#dc2626" : "#a16207";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(r.name || "Unnamed")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums;">${typeof r.score === "number" ? r.score : "—"}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><span style="color:${badgeColor};font-weight:600;text-transform:uppercase;font-size:11px;">${rec}</span></td>
      </tr>`;
    }).join("");

    const subject = `${ordered.length} candidate${ordered.length === 1 ? "" : "s"} ready for review — ${job.title}`;
    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 8px 0;">Candidates moved to Screening</h2>
      <p style="margin:0 0 16px 0;color:#444;">
        Hi ${escapeHtml(recruiter.name || recruiter.email.split("@")[0])},<br/>
        Lexy just finished screening <b>${ordered.length}</b> candidate${ordered.length === 1 ? "" : "s"} for
        <b>${escapeHtml(job.title)}</b>. They're now in the Screening column of your pipeline, ready to be reviewed.
      </p>
      <p style="margin:0 0 16px 0;color:#444;">
        ${advanceCount} recommended to advance · ${holdCount} need a closer look · ${rejectCount} likely no
      </p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #eee;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f8f9fb;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">
            <th style="padding:8px 12px;">Candidate</th>
            <th style="padding:8px 12px;text-align:right;">Score</th>
            <th style="padding:8px 12px;">Recommendation</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:24px 0 0 0;">
        <a href="${process.env.PUBLIC_APP_URL || ""}/jobs/${jobId}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open the pipeline</a>
      </p>
      <p style="margin:24px 0 0 0;color:#888;font-size:12px;">— Lexy, your AI hiring co-pilot</p>
    </body></html>`;

    const text =
      `${ordered.length} candidate${ordered.length === 1 ? "" : "s"} for "${job.title}" have been screened and moved to the Screening column for your review.\n\n` +
      `Summary: ${advanceCount} advance · ${holdCount} hold · ${rejectCount} reject\n\n` +
      ordered.slice(0, 25).map((r) => `• ${r.name ?? "Unnamed"} — score ${r.score ?? "—"} — ${r.recommendation ?? "hold"}`).join("\n");

    await sendEmail({
      to: recruiter.email,
      subject,
      html,
      text,
      audit: {
        tenantId: job.tenantId,
        actorLabel: "Screening Agent",
        subjectType: "user",
        subjectId: recruiter.id,
        subjectLabel: recruiter.name || recruiter.email,
        action: "screening.batch.recruiter_notified",
        metadata: {
          jobId,
          jobTitle: job.title,
          totalScreened: ordered.length,
          advanceCount, holdCount, rejectCount,
          candidateNames: ordered.slice(0, 25).map((r) => r.name).filter(Boolean),
        },
      },
    });

    // Also create an in-app notification so the recruiter sees a bell badge.
    try {
      const { userNotificationsTable } = await import("@workspace/db");
      const { recordAudit } = await import("../audit");
      await db.insert(userNotificationsTable).values({
        tenantId: job.tenantId,
        userId: recruiter.id,
        type: "candidates_screened",
        title: "Candidates ready for screening review",
        message: `${ordered.length} candidate${ordered.length === 1 ? "" : "s"} just landed in the Screening column for ${job.title}. ${advanceCount} recommended to advance.`,
        actionUrl: `/jobs/${jobId}`,
      });
      void recordAudit({
        tenantId: job.tenantId,
        actorType: "system",
        actorLabel: "Screening Agent",
        subjectType: "user",
        subjectId: recruiter.id,
        subjectLabel: recruiter.name || recruiter.email,
        channel: "in_app",
        direction: "outbound",
        action: "notification.user.candidates_screened",
        title: "Candidates ready for screening review",
        body: `${ordered.length} candidate${ordered.length === 1 ? "" : "s"} screened for ${job.title}.`,
        metadata: { jobId, totalScreened: ordered.length, advanceCount, holdCount, rejectCount },
      });
    } catch (e) {
      logger.warn({ err: e }, "[screening-notify] in-app notification insert failed");
    }
  } catch (err) {
    logger.error({ err, jobId }, "[screening-notify] failed to email recruiter");
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const orchestrator = new AgentOrchestrator();
