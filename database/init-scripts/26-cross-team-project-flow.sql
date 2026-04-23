-- 26-cross-team-project-flow.sql
-- Project type split, cross-team assignment workflow, and manager-owned evaluation authority

-- 1) Project type (internal/external)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_type') THEN
        CREATE TYPE project_type AS ENUM ('internal', 'external');
    END IF;
END$$;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS project_type project_type DEFAULT 'internal';

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS created_by UUID;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS fk_projects_created_by;

ALTER TABLE projects
    ADD CONSTRAINT fk_projects_created_by
    FOREIGN KEY (created_by) REFERENCES users(user_id)
    ON DELETE SET NULL;

UPDATE projects
SET project_type = COALESCE(project_type, 'internal')
WHERE project_type IS NULL;

ALTER TABLE projects
    ALTER COLUMN project_type SET DEFAULT 'internal',
    ALTER COLUMN project_type SET NOT NULL;

-- 2) Participant assignment type + ownership metadata
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'participant_assignment_type') THEN
        CREATE TYPE participant_assignment_type AS ENUM ('internal', 'external');
    END IF;
END$$;

ALTER TABLE project_participants
    ADD COLUMN IF NOT EXISTS assignment_type participant_assignment_type DEFAULT 'internal';

ALTER TABLE project_participants
    ADD COLUMN IF NOT EXISTS home_manager_id UUID;

ALTER TABLE project_participants
    ADD COLUMN IF NOT EXISTS cross_team_request_id UUID;

ALTER TABLE project_participants
    DROP CONSTRAINT IF EXISTS fk_project_participants_home_manager;

ALTER TABLE project_participants
    ADD CONSTRAINT fk_project_participants_home_manager
    FOREIGN KEY (home_manager_id) REFERENCES users(user_id)
    ON DELETE SET NULL;

UPDATE project_participants
SET assignment_type = COALESCE(assignment_type, 'internal')
WHERE assignment_type IS NULL;

ALTER TABLE project_participants
    ALTER COLUMN assignment_type SET DEFAULT 'internal',
    ALTER COLUMN assignment_type SET NOT NULL;

-- 3) Cross-team assignment request tracking (auditable)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cross_team_request_status') THEN
        CREATE TYPE cross_team_request_status AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS cross_team_assignment_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    requesting_manager_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    target_team_id UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    target_manager_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    selected_profile_id UUID NULL REFERENCES employee_profiles(profile_id) ON DELETE SET NULL,
    status cross_team_request_status NOT NULL DEFAULT 'pending',
    request_note TEXT NULL,
    response_note TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS idx_cross_team_requests_target_manager
    ON cross_team_assignment_requests (target_manager_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_team_requests_requesting_manager
    ON cross_team_assignment_requests (requesting_manager_id, created_at DESC);

ALTER TABLE project_participants
    DROP CONSTRAINT IF EXISTS fk_project_participants_cross_team_request;

ALTER TABLE project_participants
    ADD CONSTRAINT fk_project_participants_cross_team_request
    FOREIGN KEY (cross_team_request_id) REFERENCES cross_team_assignment_requests(request_id)
    ON DELETE SET NULL;

-- 4) Project record evaluation ownership metadata
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_evaluation_status') THEN
        CREATE TYPE project_evaluation_status AS ENUM (
            'scored_by_own_manager',
            'pending_external_manager',
            'scored_by_home_manager'
        );
    END IF;
END$$;

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS individual_score NUMERIC(5,2);

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS evaluation_status project_evaluation_status DEFAULT 'scored_by_own_manager';

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS external_contribution_description TEXT;

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS external_home_manager_id UUID;

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS evaluated_by_manager_id UUID;

ALTER TABLE project_records
    ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMP;

ALTER TABLE project_records
    DROP CONSTRAINT IF EXISTS fk_project_records_external_home_manager;

ALTER TABLE project_records
    ADD CONSTRAINT fk_project_records_external_home_manager
    FOREIGN KEY (external_home_manager_id) REFERENCES users(user_id)
    ON DELETE SET NULL;

ALTER TABLE project_records
    DROP CONSTRAINT IF EXISTS fk_project_records_evaluated_by_manager;

ALTER TABLE project_records
    ADD CONSTRAINT fk_project_records_evaluated_by_manager
    FOREIGN KEY (evaluated_by_manager_id) REFERENCES users(user_id)
    ON DELETE SET NULL;

UPDATE project_records
SET evaluation_status = COALESCE(evaluation_status, 'scored_by_own_manager')
WHERE evaluation_status IS NULL;

ALTER TABLE project_records
    ALTER COLUMN evaluation_status SET DEFAULT 'scored_by_own_manager',
    ALTER COLUMN evaluation_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_records_pending_external_eval
    ON project_records (external_home_manager_id, evaluation_status)
    WHERE evaluation_status = 'pending_external_manager';

-- 5) Notification types for request/evaluation workflow
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_requested';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_selected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_rejected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'external_member_evaluation_requested';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'external_member_score_submitted';
