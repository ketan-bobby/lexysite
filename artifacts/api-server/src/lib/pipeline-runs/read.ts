/**
 * lib/pipeline-runs/read.ts — Persisted-first reads for the Agent Hub
 *
 * The Agent Hub (GET /agents, GET /agents/runs) historically read the
 * orchestrator's IN-MEMORY run/event buffers, which a deploy wipes. Part 3 makes
 * persisted data the SOURCE OF TRUTH and demotes the in-memory buffer to a hot
 * cache (freshness + first-load fallback only):
 *
 *   • getPersistedRecentRuns — reads durable pipeline_runs and expands each run's
 *     `stages` jsonb into the per-agent AgentRun shape the UI already renders
 *     (run.agentId / status / output / durationMs). The stages jsonb is READ
 *     only — never mutated (the Kanban still owns it).
 *   • getPersistedActivity  — reads the sanctioned run_activity_events union view
 *     (agent + pipeline events, normalized).
 *   • mergeRuns / mergeActivity — persisted wins; the in-memory cache only adds
 *     entries strictly newer than the newest persisted one (in-flight freshness),
 *     and is used wholesale ONLY when persisted is empty for the caller's scope
 *     (fresh boot / demo seed).
 *
 * ── Why dbAdmin + an explicit `allowed` filter (not the RLS pool) ─────────────
 * These are cross-tenant AGGREGATE reads that run with the exact visibility gate
 * the orchestrator already uses: `allowed === null` = platform admin sees ALL;
 * `[]` = nothing (fail-closed); `[...]` = that tenant subtree. Reproducing that
 * with dbAdmin + an explicit `tenant_id IN (...)` filter keeps platform-sees-all
 * working and avoids depending on request-tenant GUC alignment. Best-effort: any
 * failure returns [] so the endpoint degrades to the in-memory cache.
 */
import { dbAdmin, pipelineRunsTable, runActivityEventsView, type PipelineRun } from "@workspace/db";
import { desc, inArray } from "drizzle-orm";
import type { AgentRun, AgentId, AgentEvent } from "../agents/orchestrator";
import { logger } from "../logger";

type StageStatus = "pending" | "running" | "completed" | "failed" | string;

function mapStageStatus(s: StageStatus): AgentRun["status"] {
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  return "idle"; // pending / unknown
}

/**
 * Durable run history: recent pipeline_runs expanded into per-agent AgentRun
 * entries (id = `${runId}:${agentId}`). Sorted newest-first, capped at `limit`.
 */
export async function getPersistedRecentRuns(
  allowed: string[] | null,
  limit: number,
): Promise<AgentRun[]> {
  try {
    if (allowed !== null && allowed.length === 0) return [];
    // Over-fetch parent runs: one run expands into several per-agent entries, so
    // pull a few runs' worth before flattening + trimming to `limit`.
    const fetchRuns = Math.max(limit * 2, 30);
    const rows: PipelineRun[] =
      allowed === null
        ? await dbAdmin.select().from(pipelineRunsTable).orderBy(desc(pipelineRunsTable.startedAt)).limit(fetchRuns)
        : await dbAdmin
            .select()
            .from(pipelineRunsTable)
            .where(inArray(pipelineRunsTable.tenantId, allowed))
            .orderBy(desc(pipelineRunsTable.startedAt))
            .limit(fetchRuns);

    const out: AgentRun[] = [];
    for (const r of rows) {
      const stages = Array.isArray(r.stages) ? (r.stages as any[]) : [];
      const runStarted = r.startedAt ? new Date(r.startedAt).toISOString() : new Date().toISOString();
      for (const s of stages) {
        if (!s || typeof s.agentId !== "string") continue;
        const startedAt: string = s.startedAt ?? runStarted;
        const completedAt: string | undefined = s.completedAt ?? undefined;
        const durationMs =
          s.startedAt && s.completedAt
            ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
            : undefined;
        out.push({
          id: `${r.id}:${s.agentId}`,
          agentId: s.agentId as AgentId,
          triggeredBy: r.triggeredBy,
          tenantId: r.tenantId,
          jobId: r.jobId,
          triggeredByUserId: r.triggeredByUserId ?? null,
          input: {},
          output: s.output ?? undefined,
          status: mapStageStatus(s.status),
          startedAt,
          completedAt,
          durationMs,
          error: s.error ?? undefined,
        } as AgentRun);
      }
    }
    out.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return out.slice(0, limit);
  } catch (err) {
    logger.error({ err }, "[pipeline-runs] getPersistedRecentRuns failed");
    return [];
  }
}

const t = (iso?: string | null) => (iso ? new Date(iso).getTime() : 0);

/**
 * Merge persisted runs (source of truth) with the in-memory cache. Persisted
 * wins; cache entries are included only when strictly newer than the newest
 * persisted entry (in-flight freshness). When persisted is empty for this scope,
 * fall back entirely to the cache (fresh boot / demo seed).
 */
export function mergeRuns(persisted: AgentRun[], cache: AgentRun[], limit: number): AgentRun[] {
  if (persisted.length === 0) return cache.slice(0, limit);
  const newest = persisted.reduce((m, r) => Math.max(m, t(r.startedAt)), 0);
  // The in-memory buffer briefly holds a TWIN of an in-flight run that is being
  // persisted concurrently (the orchestrator marks the stage "running" — updating
  // pipeline_runs — slightly before it stamps the in-memory run's startedAt), so a
  // twin can sneak past the `> newest` gate and show as a duplicate. Drop only that
  // twin: a persisted run with the SAME jobId+agentId that started within a short
  // window of the cache entry. A genuinely NEW re-run of the same job/agent starts
  // far later (a pipeline takes real time) and is correctly kept.
  const TWIN_WINDOW_MS = 5 * 60_000;
  const persistedMaxStartByKey = new Map<string, number>();
  for (const r of persisted) {
    const k = `${r.jobId ?? ""}:${r.agentId}`;
    persistedMaxStartByKey.set(k, Math.max(persistedMaxStartByKey.get(k) ?? 0, t(r.startedAt)));
  }
  const fresh = cache.filter((r) => {
    if (t(r.startedAt) <= newest) return false; // not newer than persisted → already captured
    const twinStart = persistedMaxStartByKey.get(`${r.jobId ?? ""}:${r.agentId}`);
    if (twinStart != null && Math.abs(t(r.startedAt) - twinStart) < TWIN_WINDOW_MS) return false;
    return true;
  });
  return [...fresh, ...persisted].slice(0, limit);
}

/** Normalized cross-run activity row (matches the run_activity_events contract). */
export interface ActivityEvent {
  id: string;
  runId: string;
  runType: string;
  type: string;
  stepName: string | null;
  message: string;
  payload: unknown;
  timestamp: string;
  tenantId: string;
}

/**
 * Recent cross-run activity from the sanctioned run_activity_events union view
 * (both agent + pipeline event streams), newest-first, tenant-scoped by `allowed`.
 */
export async function getPersistedActivity(
  allowed: string[] | null,
  limit: number,
): Promise<ActivityEvent[]> {
  try {
    if (allowed !== null && allowed.length === 0) return [];
    const rows =
      allowed === null
        ? await dbAdmin.select().from(runActivityEventsView).orderBy(desc(runActivityEventsView.timestamp)).limit(limit)
        : await dbAdmin
            .select()
            .from(runActivityEventsView)
            .where(inArray(runActivityEventsView.tenantId, allowed))
            .orderBy(desc(runActivityEventsView.timestamp))
            .limit(limit);
    return rows.map((r: any) => ({
      id: `${r.runType}:${r.runId}:${r.seq}`,
      runId: r.runId,
      runType: r.runType,
      type: r.eventType,
      stepName: r.stepName ?? null,
      message: r.message,
      payload: r.payload ?? null,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      tenantId: r.tenantId,
    }));
  } catch (err) {
    logger.error({ err }, "[pipeline-runs] getPersistedActivity failed");
    return [];
  }
}

/**
 * Merge persisted activity (source of truth) with the in-memory event cache.
 * Same policy as mergeRuns: persisted wins; cache adds only strictly-newer
 * entries; empty persisted falls back to the mapped cache.
 */
export function mergeActivity(persisted: ActivityEvent[], cache: AgentEvent[], limit: number): ActivityEvent[] {
  const mappedCache: ActivityEvent[] = cache.map((e) => ({
    id: e.id,
    runId: (e.payload as any)?.runId ?? "",
    runType: "memory",
    type: e.type,
    stepName: e.agentId ?? null,
    message: e.type,
    payload: e.payload ?? null,
    timestamp: e.timestamp,
    tenantId: (e.tenantId as string) ?? "",
  }));
  if (persisted.length === 0) return mappedCache.slice(0, limit);
  const newest = persisted.reduce((m, r) => Math.max(m, t(r.timestamp)), 0);
  const fresh = mappedCache.filter((e) => t(e.timestamp) > newest);
  return [...fresh, ...persisted].slice(0, limit);
}
