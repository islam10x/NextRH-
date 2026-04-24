-- Add team_focus column: a short description of what the team specialises in
-- e.g. "Cloud Infrastructure", "Frontend Web", "Data & AI"
ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS team_focus VARCHAR(120) DEFAULT NULL;
