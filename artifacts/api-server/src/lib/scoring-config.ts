/**
 * scoring-config.ts — Versioned scoring configuration registry
 *
 * The intelligence engine (lib/intelligence.ts) composes four dimension scores
 * (fit, quality, trust, conversion) and a hire-probability from a fixed set of
 * weights. This module lifts those weights into a versioned, persisted config
 * so that:
 *
 *   • every persisted intelligence row records WHICH config produced it
 *     (candidate_job_intelligence.model_version),
 *   • a candidate weight set can be backtested against historical outcomes
 *     before it ships (lib/backtest.ts),
 *   • a scoring change can be rolled back by re-activating an earlier version.
 *
 * The built-in `BUILTIN_LIVE_CONFIG` (version "v3") reproduces the exact
 * literals the engine has always used — switching to config-driven scoring is a
 * pure refactor with zero behaviour change until a different version is made
 * live.
 *
 * Storage is the platform-global `scoring_model_versions` table, managed only
 * through `controlDb` (cross-tenant; this is a platform-admin concern, not a
 * tenant one). When the table has no live row the engine falls back to the
 * built-in default, so scoring never depends on a DB row existing.
 */
import { controlDb, scoringModelVersionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/* ── Config shape ─────────────────────────────────────────────────────────── */

export interface ScoringConfig {
  version: string;
  label: string;
  weights: {
    /** FIT = skills · experience · ICP pattern match */
    fit: { skills: number; experience: number; icp: number };
    /** Interview sub-composite (only when interview signals exist) */
    interviewComposite: {
      communication: number;
      technicalDepth: number;
      behavioral: number;
      answerQuality: number;
    };
    /** QUALITY weights shift depending on whether interview data exists */
    quality: {
      withInterview: { screening: number; interview: number; sourcing: number };
      withoutInterview: { screening: number; sourcing: number };
    };
    /** Verification sub-composite (only when verification signals exist) */
    verificationComposite: {
      identity: number;
      linkedin: number;
      resumeConsistency: number;
    };
    /** TRUST = verification · proctoring integrity · fraud inverse */
    trust: { verification: number; integrity: number; fraud: number };
    /** Outreach sub-composite (only when outreach signals exist) */
    outreachComposite: { openRate: number; replyRate: number; positiveReply: number };
    /** CONVERSION = outreach · ghosting resistance · scheduling ease · no-show safety */
    conversion: { outreach: number; ghostingResistance: number; scheduling: number; noShow: number };
    /** HIRE PROBABILITY = the final composite over the four dimension scores */
    hireProbability: { fit: number; quality: number; trust: number; conversion: number };
  };
}

/* ── Built-in default (v3) — must equal the engine's historical literals ───── */

export const BUILTIN_LIVE_CONFIG: ScoringConfig = {
  version: "v3",
  label: "Built-in baseline (v3)",
  weights: {
    fit: { skills: 0.45, experience: 0.30, icp: 0.25 },
    interviewComposite: { communication: 0.25, technicalDepth: 0.35, behavioral: 0.20, answerQuality: 0.20 },
    quality: {
      withInterview: { screening: 0.40, interview: 0.40, sourcing: 0.20 },
      withoutInterview: { screening: 0.60, sourcing: 0.40 },
    },
    verificationComposite: { identity: 0.40, linkedin: 0.35, resumeConsistency: 0.25 },
    trust: { verification: 0.50, integrity: 0.30, fraud: 0.20 },
    outreachComposite: { openRate: 0.30, replyRate: 0.40, positiveReply: 0.30 },
    conversion: { outreach: 0.30, ghostingResistance: 0.30, scheduling: 0.25, noShow: 0.15 },
    hireProbability: { fit: 0.35, quality: 0.25, trust: 0.20, conversion: 0.20 },
  },
};

/* ── Validation ───────────────────────────────────────────────────────────── */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Validate an arbitrary object as a ScoringConfig. Throws on the first problem.
 * Used when accepting a candidate config from an API caller or reading a row
 * back from the DB. Weights must be present, finite, and non-negative; we do
 * NOT force each group to sum to 1.0 because the engine's `weight()` helper
 * already renormalises over the signals that are actually present.
 */
export function validateScoringConfig(raw: unknown): ScoringConfig {
  if (!raw || typeof raw !== "object") throw new Error("scoring config must be an object");
  const c = raw as any;
  if (typeof c.version !== "string" || !c.version.trim()) throw new Error("scoring config: version is required");
  if (typeof c.label !== "string" || !c.label.trim()) throw new Error("scoring config: label is required");
  const w = c.weights;
  if (!w || typeof w !== "object") throw new Error("scoring config: weights is required");

  const requirePaths: Array<[string, string[]]> = [
    ["fit", ["skills", "experience", "icp"]],
    ["interviewComposite", ["communication", "technicalDepth", "behavioral", "answerQuality"]],
    ["verificationComposite", ["identity", "linkedin", "resumeConsistency"]],
    ["trust", ["verification", "integrity", "fraud"]],
    ["outreachComposite", ["openRate", "replyRate", "positiveReply"]],
    ["conversion", ["outreach", "ghostingResistance", "scheduling", "noShow"]],
    ["hireProbability", ["fit", "quality", "trust", "conversion"]],
  ];
  for (const [group, keys] of requirePaths) {
    if (!w[group] || typeof w[group] !== "object") throw new Error(`scoring config: weights.${group} is required`);
    for (const k of keys) {
      if (!isNum(w[group][k])) throw new Error(`scoring config: weights.${group}.${k} must be a finite number >= 0`);
    }
  }
  // quality has the nested with/without-interview shape
  const q = w.quality;
  if (!q || typeof q !== "object") throw new Error("scoring config: weights.quality is required");
  for (const k of ["screening", "interview", "sourcing"] as const) {
    if (!isNum(q.withInterview?.[k])) throw new Error(`scoring config: weights.quality.withInterview.${k} must be a finite number >= 0`);
  }
  for (const k of ["screening", "sourcing"] as const) {
    if (!isNum(q.withoutInterview?.[k])) throw new Error(`scoring config: weights.quality.withoutInterview.${k} must be a finite number >= 0`);
  }
  return c as ScoringConfig;
}

/* ── Live-config cache ────────────────────────────────────────────────────── */

const CACHE_TTL_MS = 5 * 60 * 1000;
let liveCache: { config: ScoringConfig; at: number } | null = null;

/** Invalidate the in-process live-config cache (call after activate/seed). */
export function invalidateLiveScoringConfigCache(): void {
  liveCache = null;
}

/**
 * Return the currently-live scoring config. Reads the single is_live row from
 * `scoring_model_versions` (cross-tenant, via controlDb), cached for 5 minutes.
 * Falls back to the built-in default when no live row exists or the DB read
 * fails — scoring must never break because the registry is empty/unavailable.
 */
export async function getLiveScoringConfig(): Promise<ScoringConfig> {
  if (liveCache && Date.now() - liveCache.at < CACHE_TTL_MS) return liveCache.config;
  try {
    const [row] = await controlDb
      .select({ configJson: scoringModelVersionsTable.configJson })
      .from(scoringModelVersionsTable)
      .where(eq(scoringModelVersionsTable.isLive, true))
      .limit(1);
    const config = row ? validateScoringConfig(row.configJson) : BUILTIN_LIVE_CONFIG;
    liveCache = { config, at: Date.now() };
    return config;
  } catch (err) {
    logger.warn({ err }, "[scoring-config] live config read failed — using built-in default");
    return BUILTIN_LIVE_CONFIG;
  }
}

/* ── Registry management (platform-admin, controlDb) ──────────────────────── */

export interface ScoringVersionRow {
  version: string;
  label: string;
  isLive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  config: ScoringConfig;
}

/**
 * Ensure the built-in baseline version exists and that exactly one version is
 * live. Idempotent: safe to call on every registry access. If the table is
 * empty the built-in v3 is inserted and made live; if rows exist but none is
 * live, the built-in is activated as a safe default.
 */
export async function seedBuiltinVersions(): Promise<void> {
  await controlDb
    .insert(scoringModelVersionsTable)
    .values({
      version: BUILTIN_LIVE_CONFIG.version,
      label: BUILTIN_LIVE_CONFIG.label,
      configJson: BUILTIN_LIVE_CONFIG,
      isLive: false,
      notes: "Auto-seeded built-in baseline configuration.",
    })
    .onConflictDoNothing({ target: scoringModelVersionsTable.version });

  const [live] = await controlDb
    .select({ version: scoringModelVersionsTable.version })
    .from(scoringModelVersionsTable)
    .where(eq(scoringModelVersionsTable.isLive, true))
    .limit(1);

  if (!live) {
    await controlDb
      .update(scoringModelVersionsTable)
      .set({ isLive: true, updatedAt: new Date() })
      .where(eq(scoringModelVersionsTable.version, BUILTIN_LIVE_CONFIG.version));
    invalidateLiveScoringConfigCache();
  }
}

/** List all registered scoring versions, live first then newest. */
export async function listScoringVersions(): Promise<ScoringVersionRow[]> {
  await seedBuiltinVersions();
  const rows = await controlDb.select().from(scoringModelVersionsTable);
  return rows
    .map((r) => ({
      version: r.version,
      label: r.label,
      isLive: r.isLive,
      notes: r.notes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      config: r.configJson as ScoringConfig,
    }))
    .sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
}

/** Fetch one version's config, or null if it does not exist. */
export async function getScoringVersion(version: string): Promise<ScoringConfig | null> {
  await seedBuiltinVersions();
  const [row] = await controlDb
    .select({ configJson: scoringModelVersionsTable.configJson })
    .from(scoringModelVersionsTable)
    .where(eq(scoringModelVersionsTable.version, version))
    .limit(1);
  return row ? validateScoringConfig(row.configJson) : null;
}

/**
 * Register a new candidate version. The config's own `version` field is the
 * identity; it must be unique. Does NOT make it live — a new version is staged
 * for backtesting and only promoted via {@link activateScoringVersion}.
 */
export async function createScoringVersion(config: ScoringConfig, notes?: string): Promise<ScoringVersionRow> {
  const validated = validateScoringConfig(config);
  const existing = await getScoringVersion(validated.version);
  if (existing) throw new Error(`scoring version "${validated.version}" already exists`);
  const [row] = await controlDb
    .insert(scoringModelVersionsTable)
    .values({
      version: validated.version,
      label: validated.label,
      configJson: validated,
      isLive: false,
      notes: notes ?? null,
    })
    .returning();
  return {
    version: row.version,
    label: row.label,
    isLive: row.isLive,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    config: row.configJson as ScoringConfig,
  };
}

/**
 * Make `version` the live config — this is both "promote a new model" and
 * "roll back to an older one". Demotes the current live row first so the
 * one-live partial-unique index is never violated, then promotes the target
 * in the same transaction.
 */
export async function activateScoringVersion(version: string): Promise<void> {
  await seedBuiltinVersions();
  const target = await getScoringVersion(version);
  if (!target) throw new Error(`scoring version "${version}" not found`);

  await controlDb.transaction(async (tx) => {
    await tx
      .update(scoringModelVersionsTable)
      .set({ isLive: false, updatedAt: new Date() })
      .where(eq(scoringModelVersionsTable.isLive, true));
    await tx
      .update(scoringModelVersionsTable)
      .set({ isLive: true, updatedAt: new Date() })
      .where(eq(scoringModelVersionsTable.version, version));
  });

  invalidateLiveScoringConfigCache();
  logger.info({ version }, "[scoring-config] live scoring version activated");
}
