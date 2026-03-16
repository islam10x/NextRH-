-- 07-make-training-description-nullable.sql
-- Allow optional description on training_sessions

ALTER TABLE training_sessions
    ALTER COLUMN description DROP NOT NULL;
