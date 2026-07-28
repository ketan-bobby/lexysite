-- Migration 0027: STT Transcribe Events
-- Persists each /interviews/transcribe outcome so STT quality trends survive
-- api-server restarts (week-over-week empty-transcript rate, latency creep).

CREATE TABLE IF NOT EXISTS stt_transcribe_events (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  format      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  empty       BOOLEAN NOT NULL,
  latency_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS stt_transcribe_events_created_at_idx
  ON stt_transcribe_events (created_at);
CREATE INDEX IF NOT EXISTS stt_transcribe_events_provider_created_idx
  ON stt_transcribe_events (provider, created_at);
