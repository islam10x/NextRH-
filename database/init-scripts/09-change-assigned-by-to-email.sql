-- 09-change-assigned-by-to-email.sql
-- Store assigning manager's email (text) instead of user_id in training_sessions.assigned_by

ALTER TABLE training_sessions
    DROP CONSTRAINT IF EXISTS training_sessions_assigned_by_fkey;

ALTER TABLE training_sessions
    ALTER COLUMN assigned_by TYPE VARCHAR(255),
    ALTER COLUMN assigned_by DROP NOT NULL;
