-- Allow training to be linked to a project
ALTER TABLE training_sessions
    ADD COLUMN IF NOT EXISTS related_project_id UUID REFERENCES projects(project_id) ON DELETE SET NULL;
