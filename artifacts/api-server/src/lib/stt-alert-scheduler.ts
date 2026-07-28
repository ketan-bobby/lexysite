/**
 * stt-alert-scheduler.ts — Automatic mobile-transcription quality alerts.
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * The /interviews/transcribe endpoint records per-request STT quality
 * (empty-transcript rate + latency) into an in-memory rolling window (see
 * stt-metrics.ts → getSttWindowSnapshot). Without this scheduler, someone has
 * to manually poll GET /interviews/transcribe/metrics to notice a regression.
 *
 * This periodic check reads the rolling window and fires an alert — a
 * logger.warn (always) plus an optional ops email — when, over the window:
 *   • the empty-transcript rate crosses STT_ALERT_EMPTY_RATE_THRESHOLD, or
 *   • the average latency crosses STT_ALERT_LATENCY_MS_THRESHOLD.
 *
 * A minimum sample size avoids false alarms on a handful of requests, and a
 * cooldown prevents the same ongoing regression from alerting every tick.
 *
 * ─── Tuning (all env vars, all optional with sane defaults) ───────────────────
 *   STT_ALERT_INTERVAL_MIN          how often to check        (default 5 min)
 *   STT_ALERT_WINDOW_MIN           rolling window to evaluate  (default 30 min)
 *   STT_ALERT_MIN_SAMPLE          min requests in window to act (default 10)
 *   STT_ALERT_EMPTY_RATE_THRESHOLD empty-rate trip point 0..1  (default 0.4)
 *   STT_ALERT_LATENCY_MS_THRESHOLD avg-latency trip point (ms)  (default 8000)
 *   STT_ALERT_COOLDOWN_MIN        min minutes between alerts    (default 60)
 *   STT_ALERT_BREAKDOWN_MIN_SAMPLE min reqs to blame a provider/format (default 3)
 *   STT_ALERT_EMAIL               ops recipient(s), comma-sep   (default unset)
 *
 * When an alert fires, it also names the worst-offending STT provider and audio
 * format (the breakdown comes from getSttWindowSnapshot) so diagnosis doesn't
 * require manually slicing logs — a regression is usually isolated to one
 * provider degrading or one mobile codec. It additionally names the worst
 * provider×format *pairing* when one clearly dominates (e.g. "whisper +
 * audio/mp4" failing while every other pairing is fine), pinpointing the root
 * cause when neither axis alone is the culprit.
 *
 * In-memory only, like the metrics it watches: cooldown state resets on
 * restart. The heartbeat name is "stt_alert".
 */
import {
  getSttWindowSnapshot,
  type SttGroupSnapshot,
  type SttWindowSnapshot,
} from "./stt-metrics.js";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";
import { sendEmail, plainToHtml } from "./email.js";

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const INTERVAL_MS = numEnv("STT_ALERT_INTERVAL_MIN", 5) * 60_000;
const WINDOW_MS = numEnv("STT_ALERT_WINDOW_MIN", 30) * 60_000;
const MIN_SAMPLE = numEnv("STT_ALERT_MIN_SAMPLE", 10);
const EMPTY_RATE_THRESHOLD = numEnv("STT_ALERT_EMPTY_RATE_THRESHOLD", 0.4);
const LATENCY_MS_THRESHOLD = numEnv("STT_ALERT_LATENCY_MS_THRESHOLD", 8_000);
const COOLDOWN_MS = numEnv("STT_ALERT_COOLDOWN_MIN", 60) * 60_000;
/**
 * A provider/format must have at least this many requests in the window before
 * we'll name it as the worst offender — otherwise a single empty transcript on
 * a rare codec would read as a "100% empty" regression. Tunable so the
 * attribution sensitivity can be dialed independently of the trip thresholds.
 */
const BREAKDOWN_MIN_SAMPLE = numEnv("STT_ALERT_BREAKDOWN_MIN_SAMPLE", 3);

/**
 * A provider×format pairing is only named as the culprit when it's CLEARLY the
 * outlier: its metric must be at least this many times worse than the next-worst
 * qualifying pairing. Without this, we'd finger a pairing that's only marginally
 * worse than its peers — but the real win is calling out "whisper + audio/mp4 is
 * failing while every other pairing is fine", which this ratio captures. When no
 * pairing dominates, the per-provider / per-format lines already tell the story.
 */
const COMBO_OUTLIER_RATIO = 1.5;

/** When we last fired an alert — gates the cooldown. In-memory, resets on boot. */
let lastAlertAt = 0;

/**
 * The thresholds & window this scheduler evaluates, exposed so the metrics
 * endpoint (and the admin dashboard it feeds) can surface the SAME rolling
 * window and trip points the alerts use — letting ops visually confirm a fired
 * alert at a glance, rather than guessing what the scheduler considers "bad".
 */
export function getSttAlertConfig() {
  return {
    intervalMin: Math.round(INTERVAL_MS / 60_000),
    windowMin: Math.round(WINDOW_MS / 60_000),
    minSample: MIN_SAMPLE,
    emptyRateThreshold: EMPTY_RATE_THRESHOLD,
    latencyMsThreshold: LATENCY_MS_THRESHOLD,
    cooldownMin: Math.round(COOLDOWN_MS / 60_000),
  };
}

function alertRecipients(): string[] {
  return (process.env.STT_ALERT_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pick the group (provider or format) that maximizes `metric`, considering only
 * groups with enough traffic to be meaningful. Returns null when no group
 * clears BREAKDOWN_MIN_SAMPLE — better to say nothing than finger a rare codec
 * off a single sample.
 */
function worstBy(
  groups: SttGroupSnapshot[],
  metric: (g: SttGroupSnapshot) => number,
): SttGroupSnapshot | null {
  let worst: SttGroupSnapshot | null = null;
  for (const g of groups) {
    if (g.requests < BREAKDOWN_MIN_SAMPLE) continue;
    if (worst === null || metric(g) > metric(worst)) worst = g;
  }
  return worst;
}

/**
 * Pick the worst provider×format pairing, but only when it's CLEARLY the
 * outlier. Reuses the same BREAKDOWN_MIN_SAMPLE traffic gate as worstBy, then
 * additionally requires (a) at least one OTHER qualifying pairing to compare
 * against — a lone pairing IS the window, not an outlier within it — and (b)
 * the top pairing's metric to be at least COMBO_OUTLIER_RATIO× the next-worst
 * pairing's. Returns null otherwise so we don't blame a pairing that's only
 * marginally worse than its peers (the per-axis lines cover that case).
 */
function worstComboIfOutlier(
  combos: SttGroupSnapshot[],
  metric: (g: SttGroupSnapshot) => number,
): SttGroupSnapshot | null {
  const eligible = combos
    .filter((g) => g.requests >= BREAKDOWN_MIN_SAMPLE)
    .sort((a, b) => metric(b) - metric(a));
  if (eligible.length < 2) return null;
  const [top, next] = eligible;
  if (metric(top) <= 0) return null;
  return metric(top) >= metric(next) * COMBO_OUTLIER_RATIO ? top : null;
}

/** Format a worst-offender group for the empty-rate reason line. */
function describeEmpty(label: string, g: SttGroupSnapshot | null): string | null {
  if (!g) return null;
  return `${label}=${g.key} ${(g.emptyRate * 100).toFixed(1)}% empty [${g.empty}/${g.requests}]`;
}

/** Format a worst-offender group for the latency reason line. */
function describeLatency(label: string, g: SttGroupSnapshot | null): string | null {
  if (!g) return null;
  return `${label}=${g.key} ${g.avgLatencyMs}ms [${g.requests} reqs]`;
}

/** Render the per-provider / per-format table for the alert email body. */
function breakdownLines(groups: SttGroupSnapshot[]): string {
  if (groups.length === 0) return "  • (none)";
  return groups
    .map(
      (g) =>
        `  • ${g.key}: ${g.requests} reqs, ${g.empty} empty (${(g.emptyRate * 100).toFixed(1)}%), ${g.avgLatencyMs}ms avg`,
    )
    .join("\n");
}

async function tick(): Promise<void> {
  const snap = getSttWindowSnapshot(WINDOW_MS);

  // Not enough traffic in the window to draw a conclusion — stay quiet.
  if (snap.requests < MIN_SAMPLE) return;

  const reasons: string[] = [];
  const culprits: {
    metric: "emptyRate" | "latency";
    provider: SttGroupSnapshot | null;
    format: SttGroupSnapshot | null;
    pair: SttGroupSnapshot | null;
  }[] = [];

  if (snap.emptyRate >= EMPTY_RATE_THRESHOLD) {
    const provider = worstBy(snap.byProvider, (g) => g.emptyRate);
    const format = worstBy(snap.byFormat, (g) => g.emptyRate);
    const pair = worstComboIfOutlier(snap.byCombo, (g) => g.emptyRate);
    const offenders = [
      describeEmpty("provider", provider),
      describeEmpty("format", format),
      describeEmpty("pair", pair),
    ].filter(Boolean);
    reasons.push(
      `empty-transcript rate ${(snap.emptyRate * 100).toFixed(1)}% ≥ ${(EMPTY_RATE_THRESHOLD * 100).toFixed(0)}%` +
        (offenders.length ? ` (worst: ${offenders.join(", ")})` : ""),
    );
    culprits.push({ metric: "emptyRate", provider, format, pair });
  }
  if (snap.avgLatencyMs >= LATENCY_MS_THRESHOLD) {
    const provider = worstBy(snap.byProvider, (g) => g.avgLatencyMs);
    const format = worstBy(snap.byFormat, (g) => g.avgLatencyMs);
    const pair = worstComboIfOutlier(snap.byCombo, (g) => g.avgLatencyMs);
    const offenders = [
      describeLatency("provider", provider),
      describeLatency("format", format),
      describeLatency("pair", pair),
    ].filter(Boolean);
    reasons.push(
      `avg latency ${snap.avgLatencyMs}ms ≥ ${LATENCY_MS_THRESHOLD}ms` +
        (offenders.length ? ` (worst: ${offenders.join(", ")})` : ""),
    );
    culprits.push({ metric: "latency", provider, format, pair });
  }
  if (reasons.length === 0) return;

  const now = Date.now();
  const windowMin = Math.round(WINDOW_MS / 60_000);
  const detail = {
    windowMin,
    requests: snap.requests,
    empty: snap.empty,
    emptyRate: snap.emptyRate,
    avgLatencyMs: snap.avgLatencyMs,
    reasons,
    byProvider: snap.byProvider,
    byFormat: snap.byFormat,
    byCombo: snap.byCombo,
    culprits,
  };

  // Cooldown: an ongoing regression shouldn't re-alert every tick. We still
  // log at warn level each tick (cheap, greppable) but suppress the louder
  // email channel until the cooldown elapses.
  const inCooldown = now - lastAlertAt < COOLDOWN_MS;
  logger.warn(
    { evt: "stt_alert", suppressedEmail: inCooldown, ...detail },
    `[stt-alert] mobile transcription degraded: ${reasons.join("; ")}`,
  );
  if (inCooldown) return;
  lastAlertAt = now;

  const recipients = alertRecipients();
  if (recipients.length === 0) return; // log-only mode — nothing more to do.

  const summary = `Lexy interview transcription quality has degraded over the last ${windowMin} minutes.

Triggered checks:
${reasons.map((r) => `  • ${r}`).join("\n")}

Window stats:
  • requests:        ${snap.requests}
  • empty transcripts: ${snap.empty} (${(snap.emptyRate * 100).toFixed(1)}%)
  • avg latency:     ${snap.avgLatencyMs}ms

By provider:
${breakdownLines(snap.byProvider)}

By audio format:
${breakdownLines(snap.byFormat)}

By provider×format pairing:
${breakdownLines(snap.byCombo)}

This usually points at a mobile audio-format or STT-provider regression — often
a specific provider×format pairing (named above when one clearly dominates). The
worst offender is named in each triggered check above. Check
GET /interviews/transcribe/metrics and recent "stt_transcribe" log lines.

— Lexy automated monitoring`;

  for (const to of recipients) {
    const result = await sendEmail({
      to,
      subject: `[Lexy] Transcription quality alert — ${reasons.join("; ")}`,
      text: summary,
      html: plainToHtml(summary),
      audit: {
        actorLabel: "STT Alert Scheduler",
        subjectType: "external",
        subjectLabel: to,
        action: "stt.quality_alert.sent",
        metadata: detail,
      },
    });
    if (!result.ok) {
      logger.error({ to, err: result.error }, "[stt-alert] alert email send failed");
    }
  }
}

export function startSttAlertScheduler(): void {
  logger.info(
    {
      intervalMin: INTERVAL_MS / 60_000,
      windowMin: WINDOW_MS / 60_000,
      minSample: MIN_SAMPLE,
      emptyRateThreshold: EMPTY_RATE_THRESHOLD,
      latencyMsThreshold: LATENCY_MS_THRESHOLD,
      cooldownMin: COOLDOWN_MS / 60_000,
      breakdownMinSample: BREAKDOWN_MIN_SAMPLE,
      emailConfigured: alertRecipients().length > 0,
    },
    `[stt-alert-scheduler] Started — checks every ${INTERVAL_MS / 60_000} min`,
  );
  const run = () =>
    tick()
      .then(() => heartbeat("stt_alert"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[stt-alert] tick failed");
        heartbeat("stt_alert", "fail", err);
      });
  setInterval(run, INTERVAL_MS);
}
