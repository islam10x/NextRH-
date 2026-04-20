-- 17-scoring-system-schema.sql
-- Employee Scoring System: tables for document records, targets, scores, and deduplication

-- =============================================
-- ENUM TYPES
-- =============================================

CREATE TYPE project_complexity AS ENUM ('low', 'medium', 'high');
CREATE TYPE participant_role AS ENUM ('contributor', 'technical_lead', 'project_lead');
CREATE TYPE document_type AS ENUM ('pv', 'training_sheet');

-- =============================================
-- TABLES
-- =============================================

-- 1. document_hashes — Deduplication tracker for uploaded documents
CREATE TABLE IF NOT EXISTS document_hashes (
    hash_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_hash VARCHAR(128) NOT NULL,
    document_type document_type NOT NULL,
    original_filename VARCHAR(512),
    uploaded_by UUID REFERENCES users(user_id),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_file_hash UNIQUE (file_hash)
);

-- 2. project_records — Parsed PV (Attestation de Bonne Exécution) data
--    An employee CAN redo the same project for the same client (different periods),
--    so dedup uses (profile_id, project_name, client_name, completion_date).
CREATE TABLE IF NOT EXISTS project_records (
    record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    project_name VARCHAR(255) NOT NULL,
    client_name VARCHAR(255),
    project_description TEXT,
    completion_date DATE,
    complexity project_complexity DEFAULT 'medium',
    employee_role participant_role DEFAULT 'contributor',
    pv_verified BOOLEAN DEFAULT FALSE,
    submitted_by UUID REFERENCES users(user_id),
    document_hash VARCHAR(128) REFERENCES document_hashes(file_hash),
    source_filename VARCHAR(512),
    parsed_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Semantic dedup: same project+client+date per employee
    CONSTRAINT uq_project_record UNIQUE (profile_id, project_name, client_name, completion_date)
);

CREATE INDEX idx_project_records_profile ON project_records(profile_id);
CREATE INDEX idx_project_records_date ON project_records(completion_date);

-- 3. training_records — Parsed training delivery sheets (employee as trainer)
CREATE TABLE IF NOT EXISTS training_records (
    record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    training_name VARCHAR(255) NOT NULL,
    trainer_name VARCHAR(255),
    client_name VARCHAR(255),
    location VARCHAR(255),
    start_date DATE,
    end_date DATE,
    participant_count INT DEFAULT 0,
    document_hash VARCHAR(128) REFERENCES document_hashes(file_hash),
    source_filename VARCHAR(512),
    parsed_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Dedup: same training+client+dates counted once
    CONSTRAINT uq_training_record UNIQUE (profile_id, training_name, client_name, start_date)
);

CREATE INDEX idx_training_records_profile ON training_records(profile_id);
CREATE INDEX idx_training_records_date ON training_records(start_date);

-- 4. scoring_targets — Annual certification objective set by managers
--    Only certifications have a manager-defined target; projects and trainings
--    are scored purely on impact (complexity/role) and diminishing returns.
CREATE TABLE IF NOT EXISTS scoring_targets (
    target_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    target_year INT NOT NULL,
    certification_target INT DEFAULT 2,
    set_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_target_year UNIQUE (profile_id, target_year)
);

-- 5. scoring_weights — Configurable scoring weights (global or per-team)
CREATE TABLE IF NOT EXISTS scoring_weights (
    weight_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(team_id) ON DELETE CASCADE,
    project_weight DECIMAL(3,2) DEFAULT 0.50,
    certification_weight DECIMAL(3,2) DEFAULT 0.30,
    training_weight DECIMAL(3,2) DEFAULT 0.20,
    updated_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- NULL team_id = global default, otherwise team-specific
    CONSTRAINT uq_team_weight UNIQUE (team_id),
    CONSTRAINT chk_weights_sum CHECK (
        project_weight + certification_weight + training_weight BETWEEN 0.99 AND 1.01
    )
);

-- Insert global default weights
INSERT INTO scoring_weights (team_id, project_weight, certification_weight, training_weight)
VALUES (NULL, 0.50, 0.30, 0.20)
ON CONFLICT DO NOTHING;

-- 6. employee_scores — Computed and cached employee scores
CREATE TABLE IF NOT EXISTS employee_scores (
    score_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    score_year INT NOT NULL,
    project_score DECIMAL(5,2) DEFAULT 0,
    certification_score DECIMAL(5,2) DEFAULT 0,
    training_score DECIMAL(5,2) DEFAULT 0,
    final_score DECIMAL(5,2) DEFAULT 0,
    rank_in_team INT,
    rank_global INT,
    percentile DECIMAL(5,2),
    score_details JSONB,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_employee_score_year UNIQUE (profile_id, score_year)
);

CREATE INDEX idx_employee_scores_year ON employee_scores(score_year);
CREATE INDEX idx_employee_scores_final ON employee_scores(final_score DESC);
CREATE INDEX idx_employee_scores_profile ON employee_scores(profile_id);
