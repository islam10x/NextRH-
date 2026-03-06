-- 08-add-training-notification-types.sql
-- Extend notification_type enum with training-related events

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
        CREATE TYPE notification_type AS ENUM ('certification_expiring', 'certification_expired', 'cv_update_needed');
    END IF;
END$$;

DO $$
BEGIN
    BEGIN
        ALTER TYPE notification_type ADD VALUE 'training_assigned';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE notification_type ADD VALUE 'training_started';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END$$;
