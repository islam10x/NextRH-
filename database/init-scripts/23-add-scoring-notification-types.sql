-- Add scoring-related notification types
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'pv_uploaded';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'score_updated';
