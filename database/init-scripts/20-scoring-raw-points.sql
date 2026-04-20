-- Migration: switch scoring from percentage (0-100) to raw point-based system
-- Weights become point multipliers; scores can exceed 100

-- 0. Drop the old constraint that forced weights to sum to 1.0
ALTER TABLE scoring_weights DROP CONSTRAINT IF EXISTS chk_weights_sum;

-- 1. Increase weight column precision (from DECIMAL(3,2) to DECIMAL(5,2))
ALTER TABLE scoring_weights
  ALTER COLUMN project_weight TYPE DECIMAL(5,2),
  ALTER COLUMN certification_weight TYPE DECIMAL(5,2),
  ALTER COLUMN training_weight TYPE DECIMAL(5,2),
  ALTER COLUMN formation_weight TYPE DECIMAL(5,2);

-- 2. Update existing weight rows to new multiplier defaults
UPDATE scoring_weights
SET project_weight = 5,
    certification_weight = 8,
    training_weight = 4,
    formation_weight = 6;

-- 3. Increase score column precision (from DECIMAL(5,2) to DECIMAL(8,2))
ALTER TABLE employee_scores
  ALTER COLUMN project_score TYPE DECIMAL(8,2),
  ALTER COLUMN certification_score TYPE DECIMAL(8,2),
  ALTER COLUMN training_score TYPE DECIMAL(8,2),
  ALTER COLUMN formation_score TYPE DECIMAL(8,2),
  ALTER COLUMN final_score TYPE DECIMAL(8,2);
