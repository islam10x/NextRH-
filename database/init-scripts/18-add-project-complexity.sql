-- Add complexity column to projects table
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS complexity VARCHAR(20) DEFAULT 'medium';
