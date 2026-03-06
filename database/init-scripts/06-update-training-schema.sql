-- 06-update-training-schema.sql
-- Extend training_sessions with assignment metadata and status tracking

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'training_status') THEN
        CREATE TYPE training_status AS ENUM ('assigned', 'in_progress', 'completed');
    END IF;
END$$;

ALTER TABLE training_sessions
    ADD COLUMN IF NOT EXISTS training_url TEXT,
    ADD COLUMN IF NOT EXISTS due_date DATE,
    ADD COLUMN IF NOT EXISTS status training_status DEFAULT 'assigned',
    ADD COLUMN IF NOT EXISTS proof_file_path VARCHAR(512),
    ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(user_id);

-- keep existing columns (start_date, end_date, duration_hours, description)
-- existing rows (if any) will default to 'assigned'
