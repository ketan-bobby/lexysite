/**
 * lib/market-intelligence.ts — Market Intelligence Q&A data tools (Step 1).
 *
 * Four read-only, function-calling tools over REAL platform data. These are
 * plain data-fetch functions — no LLM anywhere. The (future) reasoning layer
 * may ONLY make factual claims that trace back to one of these tool results.
 *
 * ─── Honest-empty doctrine ──────────────────────────────────────────────────
 * Every tool returns a discriminated union:
 *   { status: "ok",      asOf, ...aggregates }   — real data, with sample size
 *   { status: "no_data", asOf, reason }          — explicitly no/insufficient
 * NEVER a zero/null/default substitute for missing data (same discipline as
 * the Conversion-score fix). Callers — human or model — must be able to tell
 * "we measured 0" apart from "we have nothing to measure".
 *
 * ─── Structure ──────────────────────────────────────────────────────────────
 * Each tool = a pure `compute*` function (unit-testable with plain arrays)
 * plus a thin `get*` fetcher that runs the tenant-scoped queries and delegates
 * to the compute step. Tests exercise the compute functions directly.
 *
 * ─── Privacy / scoping rules ────────────────────────────────────────────────
 * • getHiringVelocity / getCandidateSupply: tenant-scoped to the caller via an
 *   explicit tenantScope predicate (fail-closed on []).
 * • getCompSignal: aggregate-only over anonymized desiredSalaryRange values —
 *   never individual rows, and NOTHING is returned below MIN_COMP_SAMPLE
 *   (k-anonymity, same pattern as the self-ID demographics decoupling).
 * • getInternalBench: caller's OWN tenant pool only (pool='tenant' firewall,
 *   same doctrine as searchInternalDatabase) — the "free answer first".
 */
import { db } from "@workspace/db";
import {
  candidateEventsTable,
  applicationsTable,
  jobsTable,
  agentRunsTable,
  candidatesTable,
  candidateCareerProfilesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, ne, or, gte, sql } from "drizzle-orm";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";

/* ── Shared result shapes ─────────────────────────────────────────────────── */

export interface NoData {
  status: "no_data";
  /** ISO timestamp of when the tool ran (all tools must carry one). */
  asOf: string;
  /** Human-readable, honest reason ("no hires recorded for matching roles"). */
  reason: string;
}

export type ToolResult<T> = ({ status: "ok"; asOf: string } & T) | NoData;

export function noData(reason: string, asOf = new Date().toISOString()): NoData {
  return { status: "no_data", asOf, reason };
}

/** Minimum aggregate sample before comp data is returned at all (k-anonymity). */
export const MIN_COMP_SAMPLE = 5;
/** Minimum hires before velocity statistics are considered meaningful. */
export const MIN_VELOCITY_SAMPLE = 3;
/** Default lookback for sourcing-supply history. */
export const SUPPLY_WINDOW_DAYS = 30;

/* ── Matching helpers ─────────────────────────────────────────────────────── */

/** Case-insensitive containment match of a role phrase against a title. */
export function roleMatches(role: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  const r = role.trim().toLowerCase();
  if (!r) return false;
  if (t.includes(r) || r.includes(t)) return true;
  // Token overlap: every significant role token appears in the title
  const tokens = r.split(/[\s/,-]+/).filter(w => w.length > 2);
  return tokens.length > 0 && tokens.every(w => t.includes(w));
}

function locationMatches(location: string | undefined, value: string | null | undefined): boolean {
  if (!location) return true; // no location filter requested
  if (!value) return false;
  return value.toLowerCase().includes(location.trim().toLowerCase());
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ═══════════════════════════════ Tool 1 ═══════════════════════════════════ */

export interface HiringVelocityOk {
  medianDaysToFill: number;
  p25DaysToFill: number;
  p75DaysToFill: number;
  /** hires that entered via sourcing / all sourced pipeline entries (0–1). */
  sourcedToHireRatio: number | null;
  sampleSize: number;
  sourcedSampleSize: number;
  scope: "tenant" | "platform";
}

export interface HireDurationRow {
  days: number;
}

/** Pure aggregation over per-hire durations + sourced funnel counts. */
export function computeHiringVelocity(
  durations: number[],
  sourcedTotal: number,
  sourcedHired: number,
  scope: "tenant" | "platform",
  asOf = new Date().toISOString(),
): ToolResult<HiringVelocityOk> {
  const clean = durations.filter(d => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (clean.length < MIN_VELOCITY_SAMPLE) {
    return noData(
      clean.length === 0
        ? "no completed hires recorded for matching roles"
        : `only ${clean.length} matching hire(s) recorded — below the minimum sample of ${MIN_VELOCITY_SAMPLE}`,
      asOf,
    );
  }
  return {
    status: "ok",
    asOf,
    medianDaysToFill: Math.round(median(clean) * 10) / 10,
    p25DaysToFill: Math.round(clean[Math.floor(clean.length * 0.25)] * 10) / 10,
    p75DaysToFill: Math.round(clean[Math.floor(clean.length * 0.75)] * 10) / 10,
    sourcedToHireRatio: sourcedTotal > 0 ? Math.round((sourcedHired / sourcedTotal) * 1000) / 1000 : null,
    sampleSize: clean.length,
    sourcedSampleSize: sourcedTotal,
    scope,
  };
}

/**
 * Median days-to-fill + sourced-to-hire ratio for roles matching `role`
 * (+ optional location), from HIRED candidate_events joined to applications.
 * Tenant-scoped by default; tenantScope=[] fails closed (matches nothing).
 */
export async function getHiringVelocity(params: {
  role: string;
  skills?: string[];
  location?: string;
  /** Explicit allowed tenant ids; null = platform-wide aggregate (statistics only). */
  tenantScope: string[] | null;
}): Promise<ToolResult<HiringVelocityOk>> {
  const asOf = new Date().toISOString();
  const scope: "tenant" | "platform" = params.tenantScope === null ? "platform" : "tenant";

  // HIRED events + the application (pipeline entry date) + the job (role match).
  // Tenant predicate is built INLINE in the where() span (fail-closed on [])
  // so the classb-read guard can verify the scope inside the query itself.
  const rows = await db
    .select({
      hiredAt: candidateEventsTable.eventTimestamp,
      appCreatedAt: applicationsTable.createdAt,
      entryType: applicationsTable.entryType,
      jobTitle: jobsTable.title,
      jobLocation: jobsTable.location,
    })
    .from(candidateEventsTable)
    .innerJoin(jobsTable, eq(candidateEventsTable.jobId, jobsTable.id))
    .leftJoin(applicationsTable, eq(candidateEventsTable.applicationId, applicationsTable.id))
    .where(and(
      eq(candidateEventsTable.eventType, "HIRED"),
      params.tenantScope === null
        ? undefined
        : inArray(candidateEventsTable.tenantId, params.tenantScope.length ? params.tenantScope : ["__none__"]),
    ));

  const matching = rows.filter(r => roleMatches(params.role, r.jobTitle) && locationMatches(params.location, r.jobLocation));
  const durations = matching
    .filter(r => r.appCreatedAt && r.hiredAt)
    .map(r => (new Date(r.hiredAt as any).getTime() - new Date(r.appCreatedAt as any).getTime()) / 86_400_000);

  // Sourced funnel for the same role scope: sourced entries vs sourced entries hired
  const sourcedRows = await db
    .select({ stage: applicationsTable.stage, jobTitle: jobsTable.title, jobLocation: jobsTable.location })
    .from(applicationsTable)
    .innerJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
    .where(and(
      eq(applicationsTable.entryType, "sourced"),
      params.tenantScope === null
        ? undefined
        : inArray(applicationsTable.tenantId, params.tenantScope.length ? params.tenantScope : ["__none__"]),
    ));
  const sourcedMatching = sourcedRows.filter(r => roleMatches(params.role, r.jobTitle) && locationMatches(params.location, r.jobLocation));
  const sourcedHired = sourcedMatching.filter(r => r.stage === "hired").length;

  return computeHiringVelocity(durations, sourcedMatching.length, sourcedHired, scope, asOf);
}

/* ═══════════════════════════════ Tool 2 ═══════════════════════════════════ */

export interface CandidateSupplyOk {
  searchesInWindow: number;
  totalCandidatesFound: number;
  avgFoundPerSearch: number;
  /** vs the preceding window: "up" | "down" | "flat" | null (no prior data). */
  trend: "up" | "down" | "flat" | null;
  windowDays: number;
  /** Honest staleness statement, e.g. "based on searches in the last 30 days". */
  basedOn: string;
}

export interface SupplyRunRow {
  found: number;
  startedAt: Date | string;
}

/** Pure aggregation over sourcing-run counters in a recency window. */
export function computeCandidateSupply(
  runs: SupplyRunRow[],
  windowDays = SUPPLY_WINDOW_DAYS,
  now = new Date(),
): ToolResult<CandidateSupplyOk> {
  const asOf = now.toISOString();
  const windowStart = now.getTime() - windowDays * 86_400_000;
  const priorStart = now.getTime() - windowDays * 2 * 86_400_000;

  const inWindow = runs.filter(r => new Date(r.startedAt as any).getTime() >= windowStart);
  const prior = runs.filter(r => {
    const t = new Date(r.startedAt as any).getTime();
    return t >= priorStart && t < windowStart;
  });

  if (inWindow.length === 0) {
    return noData(`no comparable sourcing searches ran in the last ${windowDays} days`, asOf);
  }

  const total = inWindow.reduce((s, r) => s + (Number.isFinite(r.found) ? r.found : 0), 0);
  const priorTotal = prior.reduce((s, r) => s + (Number.isFinite(r.found) ? r.found : 0), 0);
  const priorAvg = prior.length ? priorTotal / prior.length : null;
  const avg = total / inWindow.length;

  let trend: CandidateSupplyOk["trend"] = null;
  if (priorAvg != null) {
    trend = avg > priorAvg * 1.15 ? "up" : avg < priorAvg * 0.85 ? "down" : "flat";
  }

  return {
    status: "ok",
    asOf,
    searchesInWindow: inWindow.length,
    totalCandidatesFound: total,
    avgFoundPerSearch: Math.round(avg * 10) / 10,
    trend,
    windowDays,
    basedOn: `based on ${inWindow.length} sourcing search(es) in the last ${windowDays} days`,
  };
}

/**
 * Recent qualified-candidate supply from the sourcing agent's OWN run history
 * (agent_runs.summary.found counters), for jobs whose title matches `role`.
 */
export async function getCandidateSupply(params: {
  role: string;
  skills?: string[];
  location?: string;
  tenantScope: string[] | null;
  windowDays?: number;
}): Promise<ToolResult<CandidateSupplyOk>> {
  const windowDays = params.windowDays ?? SUPPLY_WINDOW_DAYS;
  const tenantCond = params.tenantScope === null
    ? undefined
    : inArray(agentRunsTable.tenantId, params.tenantScope.length ? params.tenantScope : ["__none__"]);
  const since = new Date(Date.now() - windowDays * 2 * 86_400_000); // window + prior window

  const rows = await db
    .select({
      summary: agentRunsTable.summary,
      startedAt: agentRunsTable.createdAt,
      isSimulated: agentRunsTable.isSimulated,
      jobTitle: jobsTable.title,
      jobLocation: jobsTable.location,
    })
    .from(agentRunsTable)
    .innerJoin(jobsTable, eq(agentRunsTable.workOrderId, jobsTable.id))
    .where(and(tenantCond, gte(agentRunsTable.createdAt, since), eq(agentRunsTable.status, "completed")));

  const runs: SupplyRunRow[] = rows
    .filter(r => !r.isSimulated) // demo runs are not market evidence
    .filter(r => roleMatches(params.role, r.jobTitle) && locationMatches(params.location, r.jobLocation))
    .map(r => ({ found: Number((r.summary as any)?.found ?? NaN), startedAt: r.startedAt }))
    .filter(r => Number.isFinite(r.found));

  return computeCandidateSupply(runs, windowDays);
}

/* ═══════════════════════════════ Tool 3 ═══════════════════════════════════ */

export interface CompSignalOk {
  sampleSize: number;
  medianLow: number;
  medianHigh: number;
  p25Low: number;
  p75High: number;
  /** All figures parsed from free-text ranges; unit is whatever candidates wrote (typically annual). */
  note: string;
}

/** Parse a free-text salary range ("$120k–150k", "120000-140000") → [low, high] or null. */
export function parseSalaryRange(text: string | null | undefined): [number, number] | null {
  if (!text) return null;
  const nums = [...text.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map(m => {
      const raw = parseFloat(m[1].replace(/,/g, ""));
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return m[2] ? raw * 1000 : raw < 1000 ? raw * 1000 : raw; // "120" alone ≈ 120k
    })
    .filter((n): n is number => n != null && n >= 10_000 && n <= 5_000_000);
  if (nums.length === 0) return null;
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  return [low, high];
}

/** Pure aggregation over parsed ranges, enforcing the k-anonymity minimum. */
export function computeCompSignal(
  ranges: Array<[number, number]>,
  asOf = new Date().toISOString(),
): ToolResult<CompSignalOk> {
  if (ranges.length < MIN_COMP_SAMPLE) {
    return noData(
      ranges.length === 0
        ? "no candidates with a stated salary expectation match this profile"
        : `insufficient data — only ${ranges.length} matching candidate(s), minimum sample is ${MIN_COMP_SAMPLE}`,
      asOf,
    );
  }
  const lows = ranges.map(r => r[0]).sort((a, b) => a - b);
  const highs = ranges.map(r => r[1]).sort((a, b) => a - b);
  return {
    status: "ok",
    asOf,
    sampleSize: ranges.length,
    medianLow: Math.round(median(lows)),
    medianHigh: Math.round(median(highs)),
    p25Low: Math.round(lows[Math.floor(lows.length * 0.25)]),
    p75High: Math.round(highs[Math.floor(highs.length * 0.75)]),
    note: "aggregated, anonymized self-reported expectations; never individual-level",
  };
}

/**
 * Aggregated, anonymized desired-salary signal from candidate career profiles.
 * Individual rows are NEVER returned; below MIN_COMP_SAMPLE the tool reports
 * insufficient data (identical discipline to the self-ID demographics layer).
 */
export async function getCompSignal(params: {
  role: string;
  skills?: string[];
  location?: string;
}): Promise<ToolResult<CompSignalOk>> {
  /* Intentionally cross-tenant: platform-wide anonymized aggregate with a k≥5
   * minimum sample — individual rows never leave this function. */
  classBRead(CLASS_B_READ_EXEMPTION.CROSS_TENANT_AGGREGATE_ONLY);
  const rows = await db
    .select({
      desired: candidateCareerProfilesTable.desiredSalaryRange,
      title: candidateCareerProfilesTable.currentTitle,
      preferredRoles: candidateCareerProfilesTable.preferredRoles,
      skills: candidateCareerProfilesTable.skills,
      location: candidateCareerProfilesTable.location,
    })
    .from(candidateCareerProfilesTable)
    .where(sql`${candidateCareerProfilesTable.desiredSalaryRange} IS NOT NULL`);

  const wantSkills = (params.skills ?? []).map(s => s.toLowerCase());
  const ranges: Array<[number, number]> = [];
  for (const r of rows) {
    const titleHit =
      roleMatches(params.role, r.title) ||
      ((r.preferredRoles as string[] | null) ?? []).some(p => roleMatches(params.role, p));
    const skillHit =
      wantSkills.length > 0 &&
      ((r.skills as string[] | null) ?? []).some(s => wantSkills.some(w => s.toLowerCase().includes(w)));
    if (!titleHit && !skillHit) continue;
    if (!locationMatches(params.location, r.location)) continue;
    const parsed = parseSalaryRange(r.desired);
    if (parsed) ranges.push(parsed);
  }
  return computeCompSignal(ranges);
}

/* ═══════════════════════════════ Tool 4 ═══════════════════════════════════ */

export interface InternalBenchOk {
  matchCount: number;
  currentEmployeeCount: number;
  topMatches: Array<{ candidateId: string; name: string; title: string; matchScore: number; isCurrentEmployee: boolean }>;
  note: string;
}

export interface BenchCandidateRow {
  id: string;
  firstName: string;
  lastName: string;
  currentTitle: string | null;
  skills: string[] | null;
  isCurrentEmployee: boolean;
}

/** Pure skill/title-overlap scoring — same weighting doctrine as searchInternalDatabase. */
export function computeInternalBench(
  candidates: BenchCandidateRow[],
  role: string,
  skills: string[],
  asOf = new Date().toISOString(),
): ToolResult<InternalBenchOk> {
  const wantSkills = skills.map(s => s.toLowerCase());
  const scored = candidates
    .map(c => {
      const cSkills = (c.skills ?? []).map(s => s.toLowerCase());
      const overlap = wantSkills.filter(s => cSkills.some(cs => cs.includes(s) || s.includes(cs)));
      const skillScore = wantSkills.length > 0 ? overlap.length / wantSkills.length : 0.5;
      const titleScore = roleMatches(role, c.currentTitle) ? 1 : 0.4;
      return { c, score: Math.round((skillScore * 0.6 + titleScore * 0.4) * 100) };
    })
    .filter(x => x.score >= 50) // meaningful matches only — a 40-floor title miss alone doesn't qualify
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return noData("no candidates in your own talent pool match this role profile", asOf);
  }
  return {
    status: "ok",
    asOf,
    matchCount: scored.length,
    currentEmployeeCount: scored.filter(x => x.c.isCurrentEmployee).length,
    topMatches: scored.slice(0, 10).map(x => ({
      candidateId: x.c.id,
      name: `${x.c.firstName} ${x.c.lastName}`.trim(),
      title: x.c.currentTitle ?? "",
      matchScore: x.score,
      isCurrentEmployee: x.c.isCurrentEmployee,
    })),
    note: "internal talent pool only — check these before recommending external sourcing spend",
  };
}

/**
 * Does the caller's OWN tenant pool already contain people for this role?
 * pool='tenant' firewall + DNC/erasure exclusions, identical to the
 * internal-first sourcing gate. The "free answer first" tool.
 */
export async function getInternalBench(params: {
  role: string;
  skills?: string[];
  /** The caller's allowed tenant ids (own subtree). [] fails closed. */
  tenantIds: string[];
}): Promise<ToolResult<InternalBenchOk>> {
  if (params.tenantIds.length === 0) {
    return noData("no tenant scope resolved for caller");
  }
  const rows = await db
    .select({
      id: candidatesTable.id,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
      currentTitle: candidatesTable.currentTitle,
      skills: candidatesTable.skills,
      isCurrentEmployee: candidatesTable.isCurrentEmployee,
    })
    .from(candidatesTable)
    .where(and(
      inArray(candidatesTable.tenantId, params.tenantIds),
      /* PURE FIREWALL: tenant-owned records only — never platform-pool
       * personal profiles (same doctrine as searchInternalDatabase). */
      eq(candidatesTable.pool, "tenant"),
      or(isNull(candidatesTable.doNotContact), ne(candidatesTable.doNotContact, true)),
      isNull(candidatesTable.dataErasedAt),
    ));

  return computeInternalBench(rows as BenchCandidateRow[], params.role, params.skills ?? []);
}
