-- Rollback 0027: STT Transcribe Events

DROP INDEX IF EXISTS stt_transcribe_events_provider_created_idx;
DROP INDEX IF EXISTS stt_transcribe_events_created_at_idx;
DROP TABLE IF EXISTS stt_transcribe_events;
