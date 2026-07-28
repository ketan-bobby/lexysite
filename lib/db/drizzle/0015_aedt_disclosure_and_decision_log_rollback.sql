-- 0015 rollback
DROP TABLE IF EXISTS ai_decision_log;
ALTER TABLE jobs DROP COLUMN IF EXISTS aedt_notice_published_at;
ALTER TABLE jobs DROP COLUMN IF EXISTS aedt_enabled;
