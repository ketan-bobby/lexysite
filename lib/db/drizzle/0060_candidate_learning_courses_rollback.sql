-- Documentation-only. Production migrations are forward-only.
BEGIN;
DROP TABLE IF EXISTS candidate_learning_lesson_progress;
DROP TABLE IF EXISTS candidate_learning_enrollments;
COMMIT;