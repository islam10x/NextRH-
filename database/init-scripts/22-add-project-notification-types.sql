-- Add project_assigned and project_updated to notification_type enum
-- Each ALTER must be in its own transaction (PostgreSQL requirement)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'project_assigned' AND enumtypid = 'notification_type'::regtype) THEN
    ALTER TYPE notification_type ADD VALUE 'project_assigned';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'project_updated' AND enumtypid = 'notification_type'::regtype) THEN
    ALTER TYPE notification_type ADD VALUE 'project_updated';
  END IF;
END $$;
