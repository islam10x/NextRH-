-- Add formation_weight to scoring_weights
ALTER TABLE scoring_weights
  ADD COLUMN IF NOT EXISTS formation_weight DECIMAL(3,2) DEFAULT 0.15;

-- Add formation_score to employee_scores
ALTER TABLE employee_scores
  ADD COLUMN IF NOT EXISTS formation_score DECIMAL(5,2) DEFAULT 0;
