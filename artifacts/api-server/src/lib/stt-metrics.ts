/**
 * stt-metrics.ts — Speech-to-Text quality tracking
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Lightweight, in-memory instrumentation for the /interviews/transcribe
 * endpoint. Every transcription request records:
 *   - the incoming audio format (content-type base, e.g. "audio/mp4")
 *   - which provider handled it ("azure" | "whisper" | "none")
 *   - whether the transcript came back empty (a listening regression signal)
 *   - latency in milliseconds
 *
 * Each request emits a single structured log line (evt: "stt_transcribe") so it
 * can be grepped/aggregated in a log pipeline, and is also folded into an
 * in-process counter that can be reviewed via GET /interviews/transcribe/metrics.
 *
 * The in-memory counters reset on restart and are not a billing source of
 * truth — just enough visibility to spot mobile STT regressions (rising
 * empty-transcript rate, a provider degrading, latency creep) before
 * candidates complain.
 *
 * For trends that outlive a single process, every outcome is ALSO persisted to
 * the `stt_transcribe_events` table (best-effort, never awaited on the request
 * path). getSttTrends() aggregates that table into daily buckets so week-over-
 * week regressions can be reviewed across server restarts.
 */
import { dbAdmin, sttTranscribeEventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export type SttProvider = "azure" | "whisper" | "deepgram" | "elevenlabs" | "sarvam" | "iflytek" | "none";

interface ProviderStats {
  requests: number;
  empty: number;
  totalLatencyMs: number;
}

const since = new Date();
const providerStats: Record<SttProvider, ProviderStats> = {
  azure: { requests: 0, empty: 0, totalLatencyMs: 0 },
  whisper: { requests: 0, empty: 0, totalLatencyMs: 0 },
  deepgram: { requests: 0, empty: 0, totalLatencyMs: 0 },
  elevenlabs: { requests: 0, empty: 0, totalLatencyMs: 0 },
  sarvam: { requests: 0, empty: 0, totalLatencyMs: 0 },
  iflytek: { requests: 0, empty: 0, totalLatencyMs: 0 },
  none: { requests: 0, empty: 0, totalLatencyMs: 0 },
};
const formatCounts: Record<string, number> = {};
let totalRequests = 0;
let totalEmpty = 0;

/* ── Rolling-window ring buffer ──────────────────────────────────────────────
 * The cumulative counters above are great for an at-a-glance dashboard but
 * useless for alerting: a regression that starts NOW is invisible against
 * thousands of healthy historical requests. So we also keep a bounded ring of
 * recent per-request samples, trimmed by age and by count, that the alert
 * scheduler can slice into "the last N minutes". In-memory only, like the
 * counters — it resets on restart and is not a source of truth.
 */
interface SttSample {
  t: number; // epoch ms
  empty: boolean;
  latencyMs: number;
  provider: SttProvider;
  format: string;
}

/** Hard cap on retained samples — bounds memory regardless of window length. */
const MAX_SAMPLES = 5_000;
/** Samples older than this are dropped even if under MAX_SAMPLES. */
const MAX_SAMPLE_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const recentSamples: SttSample[] = [];

function trimSamples(now: number): void {
  const cutoff = now - MAX_SAMPLE_AGE_MS;
  // Samples are appended in time order, so old ones cluster at the front.
  let drop = 0;
  while (drop < recentSamples.length && recentSamples[drop].t < cutoff) drop += 1;
  if (drop > 0) recentSamples.splice(0, drop);
  const overflow = recentSamples.length - MAX_SAMPLES;
  if (overflow > 0) recentSamples.splice(0, overflow);
}

const rate = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;

export function recordSttRequest(args: {
  format: string;
  provider: SttProvider;
  empty: boolean;
  latencyMs: number;
  /* Requested BCP-47 language tag ("en-US", "hi-IN", …). Optional so older
     callers keep working; persisted for the per-language accuracy breakdown. */
  language?: string;
}): void {
  const { format, provider, empty, latencyMs, language } = args;

  const p = providerStats[provider] ?? providerStats.none;
  p.requests += 1;
  p.totalLatencyMs += latencyMs;
  if (empty) p.empty += 1;

  totalRequests += 1;
  if (empty) totalEmpty += 1;
  formatCounts[format] = (formatCounts[format] ?? 0) + 1;

  const now = Date.now();
  recentSamples.push({ t: now, empty, latencyMs, provider, format });
  trimSamples(now);

  logger.info(
    { evt: "stt_transcribe", format, provider, empty, latencyMs, language },
    "[STT] transcribe result",
  );

  /* Persist for cross-restart trends. Best-effort: never awaited on the request
     path and failures are swallowed so a slow/down DB can't slow or break live
     transcription. */
  void persistSttEvent({ format, provider, empty, latencyMs, language });
}

async function persistSttEvent(args: {
  format: string;
  provider: SttProvider;
  empty: boolean;
  latencyMs: number;
  language?: string;
}): Promise<void> {
  try {
    await dbAdmin.insert(sttTranscribeEventsTable).values({
      format: args.format,
      provider: args.provider,
      empty: args.empty,
      latencyMs: args.latencyMs,
      language: args.language ?? null,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      "[STT] failed to persist transcribe event (metrics only, ignored)",
    );
  }
}

/** A per-key (provider or audio format) slice of a rolling window. */
export interface SttGroupSnapshot {
  key: string;
  requests: number;
  empty: number;
  emptyRate: number;
  avgLatencyMs: number;
}

export interface SttWindowSnapshot {
  windowMs: number;
  requests: number;
  empty: number;
  emptyRate: number;
  avgLatencyMs: number;
  /** Per-STT-provider breakdown, sorted by request volume (desc). */
  byProvider: SttGroupSnapshot[];
  /** Per-audio-format breakdown, sorted by request volume (desc). */
  byFormat: SttGroupSnapshot[];
  /**
   * Per provider×format pairing breakdown (key = "provider + format"), sorted
   * by request volume (desc). The per-axis breakdowns above can hide the real
   * culprit when a regression is specific to one combination — e.g. "whisper +
   * audio/mp4" failing while "whisper + audio/webm" is fine. This combined key
   * lets the alert pinpoint that exact pairing.
   */
  byCombo: SttGroupSnapshot[];
}

/** Mutable accumulator while folding samples; finalized into SttGroupSnapshot. */
interface GroupAccum {
  requests: number;
  empty: number;
  totalLatencyMs: number;
}

function finalizeGroups(acc: Map<string, GroupAccum>): SttGroupSnapshot[] {
  return [...acc.entries()]
    .map(([key, g]) => ({
      key,
      requests: g.requests,
      empty: g.empty,
      emptyRate: rate(g.empty, g.requests),
      avgLatencyMs: g.requests === 0 ? 0 : Math.round(g.totalLatencyMs / g.requests),
    }))
    .sort((a, b) => b.requests - a.requests);
}

/**
 * Aggregate only the requests received within the last `windowMs`. Used by the
 * STT alert scheduler to detect a *recent* spike in empty transcripts or
 * latency, rather than a cumulative-since-boot average that masks regressions.
 *
 * In addition to the window-wide aggregate, this returns a per-provider and
 * per-audio-format breakdown so the alert can name WHICH provider or phone
 * codec is responsible, rather than just the blended rate — a regression is
 * usually isolated to one provider degrading or one mobile format.
 */
export function getSttWindowSnapshot(windowMs: number): SttWindowSnapshot {
  const now = Date.now();
  trimSamples(now);
  const cutoff = now - windowMs;

  let requests = 0;
  let empty = 0;
  let totalLatencyMs = 0;
  const byProvider = new Map<string, GroupAccum>();
  const byFormat = new Map<string, GroupAccum>();
  const byCombo = new Map<string, GroupAccum>();

  const bump = (acc: Map<string, GroupAccum>, key: string, s: SttSample): void => {
    let g = acc.get(key);
    if (!g) {
      g = { requests: 0, empty: 0, totalLatencyMs: 0 };
      acc.set(key, g);
    }
    g.requests += 1;
    if (s.empty) g.empty += 1;
    g.totalLatencyMs += s.latencyMs;
  };

  for (let i = recentSamples.length - 1; i >= 0; i -= 1) {
    const s = recentSamples[i];
    if (s.t < cutoff) break; // appended in time order — older ones are all earlier
    requests += 1;
    if (s.empty) empty += 1;
    totalLatencyMs += s.latencyMs;
    const fmt = s.format || "unknown";
    bump(byProvider, s.provider, s);
    bump(byFormat, fmt, s);
    bump(byCombo, `${s.provider} + ${fmt}`, s);
  }

  return {
    windowMs,
    requests,
    empty,
    emptyRate: rate(empty, requests),
    avgLatencyMs: requests === 0 ? 0 : Math.round(totalLatencyMs / requests),
    byProvider: finalizeGroups(byProvider),
    byFormat: finalizeGroups(byFormat),
    byCombo: finalizeGroups(byCombo),
  };
}

export function getSttMetrics() {
  const byProvider = Object.fromEntries(
    (Object.keys(providerStats) as SttProvider[]).map((key) => {
      const s = providerStats[key];
      return [
        key,
        {
          requests: s.requests,
          empty: s.empty,
          emptyRate: rate(s.empty, s.requests),
          avgLatencyMs: s.requests === 0 ? 0 : Math.round(s.totalLatencyMs / s.requests),
        },
      ];
    }),
  );

  return {
    since: since.toISOString(),
    totals: {
      requests: totalRequests,
      empty: totalEmpty,
      emptyRate: rate(totalEmpty, totalRequests),
    },
    byProvider,
    byFormat: { ...formatCounts },
  };
}

interface SttDayBucket {
  day: string;
  requests: number;
  empty: number;
  emptyRate: number;
  avgLatencyMs: number;
}

/**
 * Aggregate the persisted stt_transcribe_events into per-day buckets over the
 * last `days` days. Unlike getSttMetrics() (in-memory, resets on restart) this
 * reflects the full history written to the DB, so longer-term regressions
 * (week-over-week empty rate, latency creep) can be reviewed.
 *
 * Resilient by design: any DB failure returns an empty trend rather than
 * throwing, so the metrics endpoint never depends on the history being readable.
 */
/** Per-language slice of the persisted-history window (EU AI Act Art. 15). */
export interface SttLanguageBucket {
  language: string;
  requests: number;
  empty: number;
  emptyRate: number;
  avgLatencyMs: number;
}

export async function getSttTrends(
  days = 30,
): Promise<{ since: string; days: number; daily: SttDayBucket[]; byLanguage: SttLanguageBucket[] }> {
  const windowDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const rows = await dbAdmin
      .select({
        day: sql<string>`to_char(date_trunc('day', ${sttTranscribeEventsTable.createdAt}), 'YYYY-MM-DD')`,
        requests: sql<number>`count(*)::int`,
        empty: sql<number>`sum(case when ${sttTranscribeEventsTable.empty} then 1 else 0 end)::int`,
        avgLatencyMs: sql<number>`coalesce(round(avg(${sttTranscribeEventsTable.latencyMs})), 0)::int`,
      })
      .from(sttTranscribeEventsTable)
      .where(sql`${sttTranscribeEventsTable.createdAt} >= ${since}`)
      .groupBy(sql`date_trunc('day', ${sttTranscribeEventsTable.createdAt})`)
      .orderBy(sql`date_trunc('day', ${sttTranscribeEventsTable.createdAt})`);

    const daily: SttDayBucket[] = rows.map((r) => ({
      day: r.day,
      requests: Number(r.requests),
      empty: Number(r.empty),
      emptyRate: rate(Number(r.empty), Number(r.requests)),
      avgLatencyMs: Number(r.avgLatencyMs),
    }));

    /* Per-language breakdown over the same window. Pre-migration rows have a
       NULL language — reported as "unknown" rather than silently dropped. */
    const langRows = await dbAdmin
      .select({
        language: sql<string>`coalesce(${sttTranscribeEventsTable.language}, 'unknown')`,
        requests: sql<number>`count(*)::int`,
        empty: sql<number>`sum(case when ${sttTranscribeEventsTable.empty} then 1 else 0 end)::int`,
        avgLatencyMs: sql<number>`coalesce(round(avg(${sttTranscribeEventsTable.latencyMs})), 0)::int`,
      })
      .from(sttTranscribeEventsTable)
      .where(sql`${sttTranscribeEventsTable.createdAt} >= ${since}`)
      .groupBy(sql`coalesce(${sttTranscribeEventsTable.language}, 'unknown')`)
      .orderBy(sql`count(*) desc`);

    const byLanguage: SttLanguageBucket[] = langRows.map((r) => ({
      language: r.language,
      requests: Number(r.requests),
      empty: Number(r.empty),
      emptyRate: rate(Number(r.empty), Number(r.requests)),
      avgLatencyMs: Number(r.avgLatencyMs),
    }));

    return { since, days: windowDays, daily, byLanguage };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      "[STT] failed to read transcribe trends",
    );
    return { since, days: windowDays, daily: [], byLanguage: [] };
  }
}

/**
 * Delete persisted stt_transcribe_events older than `retentionDays`, in bounded
 * batches so a large backlog never locks the table or holds one giant
 * transaction. Used by the retention scheduler to keep the table lean — we only
 * need recent history for trend review (getSttTrends), so anything past the
 * window is disposable.
 *
 * Best-effort and self-limiting:
 *   • `batchSize` caps rows removed per DELETE (default 5,000).
 *   • `maxBatches` caps total DELETEs per call so one tick can't run unbounded
 *     against a pathological backlog (default 100 → up to 500k rows/tick).
 *   • Any DB failure is swallowed and reported via the returned `error` rather
 *     than thrown, so the scheduler tick never crashes on a transient DB issue.
 *
 * Returns how many rows were deleted and whether more likely remain (the last
 * batch came back full and we hit the maxBatches ceiling).
 */
export async function pruneSttEvents(args: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}): Promise<{ deleted: number; batches: number; moreRemaining: boolean; error?: string }> {
  const retentionDays = Math.max(Math.trunc(args.retentionDays) || 0, 1);
  const batchSize = Math.min(Math.max(Math.trunc(args.batchSize ?? 5_000) || 0, 1), 50_000);
  const maxBatches = Math.min(Math.max(Math.trunc(args.maxBatches ?? 100) || 0, 1), 10_000);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let deleted = 0;
  let batches = 0;
  let lastBatchFull = false;

  try {
    for (let i = 0; i < maxBatches; i += 1) {
      /* Postgres has no DELETE ... LIMIT, so delete the ctid of a bounded
         set of old rows. createdAt is indexed, so the inner select is cheap. */
      const result = await dbAdmin.execute(sql`
        DELETE FROM ${sttTranscribeEventsTable}
        WHERE ${sttTranscribeEventsTable.id} IN (
          SELECT ${sttTranscribeEventsTable.id}
          FROM ${sttTranscribeEventsTable}
          WHERE ${sttTranscribeEventsTable.createdAt} < ${cutoff}
          ORDER BY ${sttTranscribeEventsTable.createdAt} ASC
          LIMIT ${batchSize}
        )
      `);
      const rows = (result as { rowCount?: number | null })?.rowCount ?? 0;
      batches += 1;
      deleted += rows;
      lastBatchFull = rows >= batchSize;
      if (rows === 0) break; // nothing left older than the cutoff
      if (!lastBatchFull) break; // drained the backlog for this window
    }

    return { deleted, batches, moreRemaining: lastBatchFull && batches >= maxBatches };
  } catch (err) {
    const message = (err as Error)?.message ?? "unknown error";
    logger.warn(
      { err: message, deleted, batches },
      "[STT] failed to prune transcribe events",
    );
    return { deleted, batches, moreRemaining: true, error: message };
  }
}
