-- Rollback for 0054_stt_language.sql
DROP INDEX IF EXISTS stt_transcribe_events_language_created_idx;
ALTER TABLE stt_transcribe_events DROP COLUMN IF EXISTS language;
