-- Ensure teams have a persisted display name used across notifications/UI
ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS team_name VARCHAR(255);

-- Backfill missing/blank values from manager first name when possible
UPDATE teams t
SET team_name = CASE
    WHEN NULLIF(TRIM(u.first_name), '') IS NOT NULL THEN CONCAT(TRIM(u.first_name), '''s Team')
    ELSE 'Team'
END
FROM users u
WHERE t.manager_id = u.user_id
  AND (t.team_name IS NULL OR BTRIM(t.team_name) = '');

-- Final fallback for any remaining empty values
UPDATE teams
SET team_name = 'Team'
WHERE team_name IS NULL OR BTRIM(team_name) = '';

-- Keep column mandatory
ALTER TABLE teams
    ALTER COLUMN team_name SET NOT NULL;
