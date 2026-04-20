-- ============================================================================
-- 21 - Scoring Production Fixes
-- ============================================================================
-- 1. Convert project_participants.role from text to enum
-- 2. Update scoring_weights defaults to fractions (sum = 1.0)
-- 3. Ensure employee_scores.rank_in_team column exists
-- ============================================================================

-- 1. Create the participant_role enum type
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'participant_role') THEN
        CREATE TYPE participant_role AS ENUM ('contributor', 'technical_lead', 'project_lead');
    END IF;
END$$;

-- Migrate existing free-text roles to the enum values
UPDATE project_participants
SET role = CASE
    WHEN LOWER(role) LIKE '%project%lead%' OR LOWER(role) LIKE '%chef%projet%' THEN 'project_lead'
    WHEN LOWER(role) LIKE '%tech%lead%' OR LOWER(role) LIKE '%lead%tech%' THEN 'technical_lead'
    ELSE 'contributor'
END
WHERE role IS NOT NULL
  AND role NOT IN ('contributor', 'technical_lead', 'project_lead');

-- Set NULL roles to default
UPDATE project_participants SET role = 'contributor' WHERE role IS NULL;

-- Convert the column from text to enum
ALTER TABLE project_participants
    ALTER COLUMN role SET DEFAULT 'contributor',
    ALTER COLUMN role SET NOT NULL,
    ALTER COLUMN role TYPE participant_role USING role::participant_role;

-- 2. Update scoring_weights default values to fractions (sum = 1.0)
ALTER TABLE scoring_weights
    ALTER COLUMN project_weight SET DEFAULT 0.35,
    ALTER COLUMN certification_weight SET DEFAULT 0.25,
    ALTER COLUMN training_weight SET DEFAULT 0.20,
    ALTER COLUMN formation_weight SET DEFAULT 0.20;

-- Update existing global weights if they still have the old multiplier values
UPDATE scoring_weights
SET project_weight = 0.35,
    certification_weight = 0.25,
    training_weight = 0.20,
    formation_weight = 0.20
WHERE team_id IS NULL
  AND (project_weight + certification_weight + training_weight + formation_weight) > 2;

-- 3. Ensure rank_in_team column exists on employee_scores
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employee_scores' AND column_name = 'rank_in_team'
    ) THEN
        ALTER TABLE employee_scores ADD COLUMN rank_in_team INTEGER;
    END IF;
END$$;
