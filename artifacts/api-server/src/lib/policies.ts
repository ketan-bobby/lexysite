/**
 * Tenant Policy Engine
 *
 * Configurable decision policies at the tenant, role, and stage level.
 * Policies control which automated actions are allowed, what thresholds trigger
 * each decision, and whether recruiter approval is required before advancing.
 */

import { db } from "@workspace/db";
import { tenantDecisionPoliciesTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

/* ── Types ────────────────────────────────────────────────────────────────── */

export interface StageRule {
  requireApproval: boolean;
  minHireProbability: number;   // 0–100
  minTrustScore: number;        // 0–100
}

export interface TenantPolicy {
  /* ── Trust Rules ─────────────────────────────────────────────────── */
  lowTrustAction: "manual_verification" | "reject";
  lowTrustThreshold: number;         // trust score below this → lowTrustAction

  /* ── Automation Rules ────────────────────────────────────────────── */
  allowAutoOutreach: boolean;        // can outreach be auto-triggered?
  allowAutoSchedule: boolean;        // can scheduling be auto-triggered?
  allowAutoReengage: boolean;        // can anti-ghosting be auto-triggered?
  requireRecruiterApproval: boolean; // all advances need recruiter approval?

  /* ── Score Thresholds ────────────────────────────────────────────── */
  advanceThreshold: number;             // hire_probability >= this → advance
  scheduleThreshold: number;            // hire_probability >= this → schedule
  rejectMinQuality: number;             // quality_score < this → reject
  rejectMinFit: number;                 // fit_score < this → reject
  reengageConversionThreshold: number;  // conversion_score < this → re_engage

  /* ── Stage-Specific Rules ────────────────────────────────────────── */
  stageRules: Record<string, StageRule>;
}

export interface PolicyApplication {
  policyApplied: boolean;
  policyOverrides: string[];         // human-readable list of what was changed
}

/* ── Default Policy ────────────────────────────────────────────────────────── */

/**
 * The baseline policy applied to every tenant that has not configured a custom one.
 * These values represent the recommended Lexy platform defaults — they are
 * intentionally permissive on automation (all auto-actions allowed) and use
 * score thresholds that balance pipeline throughput against quality risk.
 *
 * Threshold rationale:
 *   advanceThreshold: 80   — only move to offer stage if the system is highly confident
 *   scheduleThreshold: 63  — interview anyone the system is reasonably confident about
 *   rejectMinQuality: 25   — only hard-reject if quality is clearly very poor
 *   rejectMinFit: 20       — only hard-reject if there is a fundamental role mismatch
 *   lowTrustThreshold: 45  — flag for manual verification if trust is below this
 *   reengageConversionThreshold: 35 — trigger re-engagement if conversion drops this low
 *
 * Stage rule minimums ensure that candidates must clear a rising bar at each gate:
 *   sourced   → no minimum (anyone in the pipeline is valid)
 *   screening → 40% hire probability + 30 trust before progressing
 *   interview → 55% hire probability + 45 trust before progressing
 *   offer     → 78% hire probability + 65 trust, AND requires recruiter approval
 */
export const DEFAULT_POLICY: TenantPolicy = {
  lowTrustAction:               "manual_verification",
  lowTrustThreshold:            45,
  allowAutoOutreach:            true,
  allowAutoSchedule:            true,
  allowAutoReengage:            true,
  requireRecruiterApproval:     false,
  advanceThreshold:             80,
  scheduleThreshold:            63,
  rejectMinQuality:             25,
  rejectMinFit:                 20,
  reengageConversionThreshold:  35,
  stageRules: {
    sourced:   { requireApproval: false, minHireProbability: 0,  minTrustScore: 0  },
    screening: { requireApproval: false, minHireProbability: 40, minTrustScore: 30 },
    interview: { requireApproval: false, minHireProbability: 55, minTrustScore: 45 },
    offer:     { requireApproval: true,  minHireProbability: 78, minTrustScore: 65 },
  },
};

/* ── Policy Cache ──────────────────────────────────────────────────────────── */

// Simple in-process cache — invalidated after 5 minutes
const policyCache = new Map<string, { policy: TenantPolicy; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(tenantId: string, roleId?: string, stage?: string): string {
  return `${tenantId}::${roleId ?? "*"}::${stage ?? "*"}`;
}

/* ── Getters ───────────────────────────────────────────────────────────────── */

/**
 * Fetch the most specific policy for a tenant/role/stage combination.
 * Resolution order: tenant+role+stage → tenant+role → tenant-level → default.
 * Falls back to DEFAULT_POLICY if nothing is stored.
 */
export async function getPolicy(
  tenantId: string,
  roleId?: string,
  stage?: string,
): Promise<TenantPolicy> {
  const key = cacheKey(tenantId, roleId, stage);
  const cached = policyCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.policy;

  try {
    // Try most-specific first, then progressively broader
    const rows = await db
      .select()
      .from(tenantDecisionPoliciesTable)
      .where(eq(tenantDecisionPoliciesTable.tenantId, tenantId));

    if (rows.length === 0) return DEFAULT_POLICY;

    // Specificity: role+stage > role > stage > tenant-wide (isDefault)
    const specific = rows.find(r => r.roleId === (roleId ?? null) && r.stage === (stage ?? null) && roleId && stage);
    const roleOnly  = rows.find(r => r.roleId === (roleId ?? null) && isNull && !r.stage && roleId);
    const tenantWide = rows.find(r => r.isDefault && !r.roleId && !r.stage);
    const match = specific ?? roleOnly ?? tenantWide ?? rows[0];

    const policy = { ...DEFAULT_POLICY, ...(match.policyJson as Partial<TenantPolicy>) };
    policyCache.set(key, { policy, cachedAt: Date.now() });
    return policy;
  } catch (err) {
    logger.warn({ err, tenantId }, "Failed to fetch tenant policy — using default");
    return DEFAULT_POLICY;
  }
}

/**
 * Persist a policy for a tenant (upserts the is_default policy if no roleId/stage).
 * Invalidates the cache.
 */
export async function savePolicy(
  tenantId: string,
  policyJson: TenantPolicy,
  opts?: { roleId?: string; stage?: string; label?: string },
): Promise<void> {
  const existing = await db
    .select({ id: tenantDecisionPoliciesTable.id })
    .from(tenantDecisionPoliciesTable)
    .where(
      and(
        eq(tenantDecisionPoliciesTable.tenantId, tenantId),
        opts?.roleId
          ? eq(tenantDecisionPoliciesTable.roleId, opts.roleId)
          : isNull(tenantDecisionPoliciesTable.roleId),
        opts?.stage
          ? eq(tenantDecisionPoliciesTable.stage, opts.stage)
          : isNull(tenantDecisionPoliciesTable.stage),
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(tenantDecisionPoliciesTable)
      .set({ policyJson, updatedAt: new Date(), label: opts?.label ?? "Custom Policy" })
      .where(eq(tenantDecisionPoliciesTable.id, existing[0].id));
  } else {
    await db.insert(tenantDecisionPoliciesTable).values({
      tenantId,
      roleId:     opts?.roleId,
      stage:      opts?.stage,
      isDefault:  !opts?.roleId && !opts?.stage,
      label:      opts?.label ?? "Custom Policy",
      policyJson,
    });
  }

  // Invalidate cache
  for (const k of policyCache.keys()) {
    if (k.startsWith(tenantId)) policyCache.delete(k);
  }
}

/* ── Training-data policy guard ──────────────────────────────────────────── */

/**
 * Hard guard: candidate practice content (mock interview answers, transcripts,
 * resume uploads, etc.) must NEVER be funnelled into a model-training pathway.
 * Any code path that exports or persists candidate content for downstream
 * pipelines must call this first. Throws on violation so the request fails
 * loudly in dev and audit log catches it in prod.
 *
 * Brochure promise (slide 9): "What Lexy will not do — Use your interview
 * practice content to train models for anyone else."
 */
export function assertNotForTraining(context: {
  purpose: string;
  candidateId?: string;
  destination?: string;
}): void {
  const banned = ["training", "fine_tune", "fine-tune", "model_training", "dataset_export"];
  const haystack = `${context.purpose} ${context.destination ?? ""}`.toLowerCase();
  for (const word of banned) {
    if (haystack.includes(word)) {
      logger.error(
        { context },
        "[policy] BLOCKED: candidate practice content cannot be used for model training",
      );
      throw new Error(
        "Policy violation: candidate practice content cannot be used for model training " +
        "(see Lexy candidate brochure, slide 9 — 'What Lexy will not do').",
      );
    }
  }
}

/* ── Policy Validation ────────────────────────────────────────────────────── */

export function validatePolicy(raw: unknown): { valid: boolean; errors: string[]; policy?: TenantPolicy } {
  const errors: string[] = [];
  const p = raw as any;

  if (typeof p !== "object" || !p) {
    return { valid: false, errors: ["Policy must be a JSON object"] };
  }

  // Type checks for key fields
  if (p.lowTrustAction && !["manual_verification", "reject"].includes(p.lowTrustAction))
    errors.push("lowTrustAction must be 'manual_verification' or 'reject'");
  if (p.lowTrustThreshold !== undefined && (p.lowTrustThreshold < 0 || p.lowTrustThreshold > 100))
    errors.push("lowTrustThreshold must be 0–100");
  if (p.advanceThreshold !== undefined && (p.advanceThreshold < 0 || p.advanceThreshold > 100))
    errors.push("advanceThreshold must be 0–100");
  if (p.scheduleThreshold !== undefined && (p.scheduleThreshold < 0 || p.scheduleThreshold > 100))
    errors.push("scheduleThreshold must be 0–100");

  if (errors.length > 0) return { valid: false, errors };

  const policy: TenantPolicy = { ...DEFAULT_POLICY, ...p };
  return { valid: true, errors: [], policy };
}

/* ── Policy Application ───────────────────────────────────────────────────── */

/**
 * Returns a list of human-readable strings describing which policy rules were
 * applied that differ from the base (signal-only) decision.
 */
export function describePolicyApplication(
  baseAction: string,
  finalAction: string,
  policy: TenantPolicy,
  context: { trustScore: number; conversionScore: number; requiresApproval: boolean },
): PolicyApplication {
  const overrides: string[] = [];

  if (baseAction !== finalAction) {
    overrides.push(`Decision changed from "${baseAction}" to "${finalAction}" by tenant policy`);
  }
  if (context.trustScore < policy.lowTrustThreshold && policy.lowTrustAction === "reject") {
    overrides.push(`Low-trust rejection enforced (trust ${context.trustScore} < threshold ${policy.lowTrustThreshold})`);
  }
  if (context.requiresApproval) {
    overrides.push("Recruiter approval required before action executes (policy gate)");
  }
  if (!policy.allowAutoOutreach && finalAction === "advance") {
    overrides.push("Auto-outreach disabled — recruiter must send manually");
  }

  return {
    policyApplied: overrides.length > 0 || baseAction !== finalAction,
    policyOverrides: overrides,
  };
}
