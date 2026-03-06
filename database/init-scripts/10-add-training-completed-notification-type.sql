-- 10-add-training-completed-notification-type.sql
-- Add training_completed to notification_type enum

DO 
BEGIN
    BEGIN
        ALTER TYPE notification_type ADD VALUE 'training_completed';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END;
