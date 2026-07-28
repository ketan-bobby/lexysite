/**
 * peer-percentile.ts — Compute fuzzy "you vs. peers" bands
 *
 * Computes each candidate's readiness percentile within their own country and
 * globally, then translates to a fuzzy positive band so candidates always see
 * encouragement (never a hard "you're in the bottom 12%" message).
 *
 * Bands (ordered top → bottom):
 *   90+  → "Top tier"
 *   75+  → "Top quarter"
 *   60+  → "Above average"
 *   40+  → "On track"
 *   < 40 → "Building momentum"
 *
 * Stored on candidate_progress_snapshots so the dashboard query doesn't need
 * to recompute on every page-load.
 */
import { db } from "@workspace/db";
import {
  candidatesTable,
  candidateCareerProfilesTable,
  candidateProgressSnapshotsTable,
} from "@workspace/db";
import { sql, eq, desc } from "drizzle-orm";
import { logger } from "./logger.js";
import { notifyPeerBandPromotion } from "./market-event-emitter.js";

export type PeerBand =
  | "Top tier"
  | "Top quarter"
  | "Above average"
  | "On track"
  | "Building momentum";

export function bandFor(pct: number): PeerBand {
  if (pct >= 90) return "Top tier";
  if (pct >= 75) return "Top quarter";
  if (pct >= 60) return "Above average";
  if (pct >= 40) return "On track";
  return "Building momentum";
}

/** Best-effort country extraction from a free-text "City, Country" location. */
export function inferCountry(location?: string | null): string | null {
  if (!location) return null;
  const parts = location.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

/**
 * Recomputes percentile bands for every candidate. Cheap enough to run daily
 * — single ranking pass over all (candidate, readiness, country) tuples.
 */
export async function runPeerPercentileSweep(): Promise<{ updated: number }> {
  /* Ranking signal = profile completeness from candidate_career_profiles.
     We label this internally as `score` (not "readiness") because that's the
     actual underlying field. The displayed bands ("Top quarter", "Above
     average", etc.) are intentionally signal-agnostic — they don't claim a
     specific metric — so this stays honest end-to-end. */
  const rows = await db
    .select({
      candidateId: (candidateCareerProfilesTable as any).candidateId,
      score: (candidateCareerProfilesTable as any).profileCompleteness,
      location: candidatesTable.location,
    })
    .from(candidateCareerProfilesTable)
    .leftJoin(candidatesTable, eq(candidatesTable.id, (candidateCareerProfilesTable as any).candidateId));

  if (rows.length === 0) return { updated: 0 };

  // Sort globally
  const globalSorted = [...rows].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const globalRankByCandidate = new Map<string, number>();
  globalSorted.forEach((r, i) => {
    if (r.candidateId) globalRankByCandidate.set(r.candidateId, i);
  });
  const globalTotal = globalSorted.length;

  // Sort per country
  const byCountry = new Map<string, typeof rows>();
  for (const r of rows) {
    const country = inferCountry(r.location) ?? "Worldwide";
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(r);
  }
  const countryRankByCandidate = new Map<string, { rank: number; total: number; country: string }>();
  for (const [country, arr] of byCountry) {
    arr.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    arr.forEach((r, i) => {
      if (r.candidateId) countryRankByCandidate.set(r.candidateId, { rank: i, total: arr.length, country });
    });
  }

  let updated = 0;
  for (const r of rows) {
    if (!r.candidateId) continue;
    const gRank = globalRankByCandidate.get(r.candidateId) ?? 0;
    const cInfo = countryRankByCandidate.get(r.candidateId);
    /* Percentile: fraction of peers below this candidate.
       Singletons / very small countries get a generous default of 75 so a lone
       candidate in their country isn't told they're "Building momentum" purely
       because they have no peers to rank against. */
    const globalPct = globalTotal > 1 ? Math.round((gRank / (globalTotal - 1)) * 100) : 75;
    const countryPct = cInfo && cInfo.total > 1
      ? Math.round((cInfo.rank / (cInfo.total - 1)) * 100)
      : 75;

    /* Floor: never show below 25th percentile. The whole point of these bands is
       to motivate, not to discourage. Bottom-quartile candidates still see "Building
       momentum" rather than a discouraging numeric rank. */
    const displayedGlobal  = Math.max(globalPct,  25);
    const displayedCountry = Math.max(countryPct, 25);

    /* Look up the previous snapshot's bands so we can fire a "you moved up"
       email when the band actually improves. Cheap — same composite index
       (candidate_id, created_at desc) we already use for getLatestPeerSnapshot. */
    let prevCountryBand: string | null = null;
    let prevGlobalBand:  string | null = null;
    try {
      const [prev] = await db
        .select({
          c: (candidateProgressSnapshotsTable as any).peerBandCountry,
          g: (candidateProgressSnapshotsTable as any).peerBandGlobal,
        })
        .from(candidateProgressSnapshotsTable)
        .where(eq(candidateProgressSnapshotsTable.candidateId, r.candidateId))
        .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
        .limit(1);
      prevCountryBand = (prev as any)?.c ?? null;
      prevGlobalBand  = (prev as any)?.g ?? null;
    } catch { /* prev lookup is best-effort */ }

    const newCountryBand = bandFor(displayedCountry);
    const newGlobalBand  = bandFor(displayedGlobal);

    try {
      await db.insert(candidateProgressSnapshotsTable).values({
        candidateId:         r.candidateId,
        readinessScore:      r.score ?? 0,
        profileCompleteness: r.score ?? 0,
        peerPctCountry:      displayedCountry,
        peerPctGlobal:       displayedGlobal,
        peerBandCountry:     newCountryBand,
        peerBandGlobal:      newGlobalBand,
        country:             cInfo?.country ?? null,
        peerUpdatedAt:       new Date(),
      } as any);
      updated++;

      /* ── Climber baseline backfill ──────────────────────────────────────
         The Climber badge needs a snapshot ≥75 days old to compute the
         quarterly peer-percentile delta. For any candidate who has never
         had one (e.g. they joined more recently than the scheduler has been
         running, or the scheduler itself is new), insert a single backdated
         baseline pinned to NOW-90d using their CURRENT percentile values.
         This is honest: it sets the bar at "where you are today" so the
         badge only fires when the candidate actually moves up. Idempotent
         — we only insert when no qualifying older snapshot exists. */
      try {
        const cutoff = new Date(Date.now() - 75 * 86_400_000);
        const [oldEnough] = await db
          .select({ id: candidateProgressSnapshotsTable.id })
          .from(candidateProgressSnapshotsTable)
          .where(sql`${candidateProgressSnapshotsTable.candidateId} = ${r.candidateId} AND ${candidateProgressSnapshotsTable.createdAt} < ${cutoff}`)
          .limit(1);
        if (!oldEnough) {
          const baselineAt = new Date(Date.now() - 90 * 86_400_000);
          await db.insert(candidateProgressSnapshotsTable).values({
            candidateId:         r.candidateId,
            readinessScore:      r.score ?? 0,
            profileCompleteness: r.score ?? 0,
            peerPctCountry:      displayedCountry,
            peerPctGlobal:       displayedGlobal,
            peerBandCountry:     newCountryBand,
            peerBandGlobal:      newGlobalBand,
            country:             cInfo?.country ?? null,
            peerUpdatedAt:       baselineAt,
            createdAt:           baselineAt,
          } as any);
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, candidateId: r.candidateId }, "[peer-percentile] climber baseline backfill failed");
      }

      /* Fire promotion alerts (no await — best-effort fan-out, the emitter
         has its own internal try/catch so it won't break the sweep). */
      void notifyPeerBandPromotion({ candidateId: r.candidateId, oldBand: prevCountryBand, newBand: newCountryBand, scope: "country" });
      void notifyPeerBandPromotion({ candidateId: r.candidateId, oldBand: prevGlobalBand,  newBand: newGlobalBand,  scope: "global" });
    } catch (err: any) {
      logger.warn({ err: err?.message, candidateId: r.candidateId }, "[peer-percentile] snapshot insert failed");
    }
  }

  logger.info({ updated, totalCandidates: rows.length }, "[peer-percentile] sweep complete");
  return { updated };
}

/** Returns the most recent peer-percentile snapshot for a candidate, or null. */
export async function getLatestPeerSnapshot(candidateId: string) {
  const [row] = await db
    .select()
    .from(candidateProgressSnapshotsTable)
    .where(eq(candidateProgressSnapshotsTable.candidateId, candidateId))
    .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    pctCountry:  (row as any).peerPctCountry  ?? null,
    pctGlobal:   (row as any).peerPctGlobal   ?? null,
    bandCountry: (row as any).peerBandCountry ?? null,
    bandGlobal:  (row as any).peerBandGlobal  ?? null,
    country:     (row as any).country         ?? null,
    updatedAt:   (row as any).peerUpdatedAt   ?? row.createdAt,
  };
}
