-- Migration to add is_uploaded column to certifications table
ALTER TABLE certifications ADD COLUMN IF NOT EXISTS is_uploaded BOOLEAN DEFAULT FALSE;
