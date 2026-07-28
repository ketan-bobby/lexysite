/**
 * schema/stt-metrics.ts — Speech-to-Text Transcribe Outcomes
 *
 * ─── What this table holds ───────────────────────────────────────────────────
 * One row per /interviews/transcribe request: the incoming audio format, which
 * provider answered ("azure" | "whisper" | "none"), whether the transcript came
 * back empty (a listening-regression signal), the latency in ms, and when it
 * happened. It's the durable backing store for the STT quality counters that
 * previously lived only in process memory.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The in-memory counters in lib/stt-metrics.ts reset on every api-server
 * restart, so week-over-week trends (rising empty-transcript rate, latency
 * creep, a provider degrading) could never be reviewed across real time
 * horizons. Persisting each outcome means trend queries outlive any single
 * process lifetime.
 *
 * ─── Fire-and-forget insert ──────────────────────────────────────────────────
 * lib/stt-metrics.ts inserts via dbAdmin and never awaits the write on the
 * request path — failures are swallowed so persistence can never slow down or
 * break live transcription.
 *
 * ─── Not RLS-protected / no PII ──────────────────────────────────────────────
 * Rows carry no candidate data — only aggregate-friendly metadata (format,
 * provider, empty flag, latency, timestamp). Reads are exposed through the same
 * unauthenticated metrics endpoint as the live counters.
 */
import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const sttTranscribeEventsTable = pgTable(
  "stt_transcribe_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /* Audio content-type base, e.g. "audio/mp4", "audio/webm". */
    format: text("format").notNull(),
    /* "azure" | "whisper" | "none" — provider that produced the final outcome. */
    provider: text("provider").notNull(),
    /* True when the returned transcript was empty (listening regression signal). */
    empty: boolean("empty").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    /* Requested BCP-47 language tag ("en-US", "hi-IN", …). Nullable — rows
     * written before migration 0054 carry no language. Enables the per-language
     * accuracy breakdown required for EU AI Act Art. 15 monitoring. */
    language: text("language"),
  },
  (t) => ({
    createdAtIdx: index("stt_transcribe_events_created_at_idx").on(t.createdAt),
    providerCreatedIdx: index("stt_transcribe_events_provider_created_idx").on(t.provider, t.createdAt),
    languageCreatedIdx: index("stt_transcribe_events_language_created_idx").on(t.language, t.createdAt),
  }),
);

export type SttTranscribeEvent = typeof sttTranscribeEventsTable.$inferSelect;
