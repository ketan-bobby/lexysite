-- 0054_stt_language.sql
-- EU AI Act accuracy monitoring (Art. 15): per-language STT outcome breakdown.
-- Adds the requested BCP-47 language tag to each transcribe event so empty-rate
-- and latency can be reviewed per language (e.g. hi-IN vs en-US) instead of
-- only per provider/format. Nullable — pre-existing rows have no language.

ALTER TABLE stt_transcribe_events
  ADD COLUMN IF NOT EXISTS language text;

CREATE INDEX IF NOT EXISTS stt_transcribe_events_language_created_idx
  ON stt_transcribe_events (language, created_at);
