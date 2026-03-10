-- Add generated_title column to projects table
-- Stores AI-generated titles for projects with name = 'Unknown Project'
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS generated_title VARCHAR(255) DEFAULT NULL;
