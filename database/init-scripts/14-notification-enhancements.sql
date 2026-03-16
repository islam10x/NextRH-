-- 12: Notification enhancements for n8n integration and scheduled notifications

-- Add scheduled_at column to notifications (allows n8n / cron to schedule future notifications)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifications' AND column_name = 'scheduled_at'
    ) THEN
        ALTER TABLE notifications ADD COLUMN scheduled_at TIMESTAMP DEFAULT NULL;
    END IF;
END $$;

-- Add email_sent flag to notifications (tracks whether n8n has sent an email for this notification)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifications' AND column_name = 'email_sent'
    ) THEN
        ALTER TABLE notifications ADD COLUMN email_sent BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Indexes for faster notification queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id, is_read) WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_notifications_scheduled
    ON notifications (scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_certification_alerts_unsent
    ON certification_alerts (notification_sent) WHERE notification_sent = FALSE;

CREATE INDEX IF NOT EXISTS idx_certifications_expiration
    ON certifications (expiration_date) WHERE expiration_date IS NOT NULL;
