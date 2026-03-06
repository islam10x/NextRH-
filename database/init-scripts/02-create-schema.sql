-- 02-create-schema.sql

-- =============================================
-- ENUM TYPES
-- =============================================

CREATE TYPE user_role AS ENUM ('employee', 'team_manager', 'bid_manager');
CREATE TYPE proficiency_level AS ENUM ('beginner', 'intermediate', 'advanced', 'expert');
CREATE TYPE skill_source AS ENUM ('cv', 'certification', 'training', 'project', 'manual');
CREATE TYPE certification_status AS ENUM ('active', 'expired', 'expiring_soon');
CREATE TYPE parsing_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE template_type AS ENUM ('standard', 'canadian', 'eu', 'client_specific');
CREATE TYPE notification_type AS ENUM ('certification_expiring', 'certification_expired', 'cv_update_needed');
CREATE TYPE alert_type AS ENUM ('expiring_soon', 'expired', 'renewal_reminder');
CREATE TYPE training_status AS ENUM ('assigned', 'in_progress', 'completed');

-- =============================================
-- TABLES
-- =============================================

-- 1. users
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role user_role NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    current_hashed_refresh_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. teams
CREATE TABLE IF NOT EXISTS teams (
    team_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_name VARCHAR(255) NOT NULL,
    manager_id UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. team_members
CREATE TABLE IF NOT EXISTS team_members (
    team_member_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(team_id) ON DELETE CASCADE,
    employee_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    joined_date DATE DEFAULT CURRENT_DATE,
    CONSTRAINT uq_team_employee UNIQUE (team_id, employee_id)
);

-- 4. employee_profiles
CREATE TABLE IF NOT EXISTS employee_profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    total_experience_years INT,
    current_position VARCHAR(255),
    professional_summary TEXT,
    folder_path VARCHAR(512),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. education
CREATE TABLE IF NOT EXISTS education (
    education_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    degree VARCHAR(255) NOT NULL,
    field_of_study VARCHAR(255),
    institution VARCHAR(255),
    end_date DATE
);

-- 6. work_experience
CREATE TABLE IF NOT EXISTS work_experience (
    experience_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    job_title VARCHAR(255) NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    start_date DATE,
    end_date DATE,
    is_current BOOLEAN DEFAULT FALSE,
    description TEXT NOT NULL
);

-- 7. skills
CREATE TABLE IF NOT EXISTS skills (
    skill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_name VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(100)
);

-- 8. employee_skills
CREATE TABLE IF NOT EXISTS employee_skills (
    employee_skill_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
    proficiency_level proficiency_level DEFAULT 'intermediate',
    years_of_experience INT,
    source skill_source DEFAULT 'manual',
    CONSTRAINT uq_profile_skill UNIQUE (profile_id, skill_id)
);

-- 9. certifications
CREATE TABLE IF NOT EXISTS certifications (
    certification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    certification_name VARCHAR(255) NOT NULL,
    issuing_organization VARCHAR(255),
    issue_date DATE,
    expiration_date DATE,
    status certification_status DEFAULT 'active',
    file_path VARCHAR(512),
    credential_id VARCHAR(255),
    is_uploaded BOOLEAN DEFAULT FALSE,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. training_sessions
CREATE TABLE IF NOT EXISTS training_sessions (
    training_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    training_title VARCHAR(255) NOT NULL,
    provider VARCHAR(255),
    training_url TEXT,
    due_date DATE,
    start_date DATE,
    end_date DATE,
    duration_hours INT,
    description TEXT,
    status training_status DEFAULT 'assigned',
    proof_file_path VARCHAR(512),
    assigned_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. projects
CREATE TABLE IF NOT EXISTS projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_name VARCHAR(255) NOT NULL,
    client_name VARCHAR(255),
    project_year VARCHAR(10),
    project_description TEXT
);

-- 12. project_participants
CREATE TABLE IF NOT EXISTS project_participants (
    participant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(project_id) ON DELETE CASCADE,
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    role VARCHAR(255),
    description TEXT NOT NULL,
    CONSTRAINT uq_project_profile UNIQUE (project_id, profile_id)
);

-- 13. project_technologies
CREATE TABLE IF NOT EXISTS project_technologies (
    project_tech_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(project_id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(skill_id) ON DELETE CASCADE,
    CONSTRAINT uq_project_skill UNIQUE (project_id, skill_id)
);

-- 14. cv_documents
CREATE TABLE IF NOT EXISTS cv_documents (
    cv_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    file_type VARCHAR(50),
    is_current BOOLEAN DEFAULT FALSE,
    parsing_status parsing_status DEFAULT 'pending',
    parsed_at TIMESTAMP,
    parsing_errors TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 15. cv_templates
CREATE TABLE IF NOT EXISTS cv_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_name VARCHAR(255) NOT NULL,
    template_type template_type NOT NULL,
    file_path VARCHAR(512),
    font_family VARCHAR(100),
    layout_config JSONB
);

-- 16. generated_cvs
CREATE TABLE IF NOT EXISTS generated_cvs (
    generated_cv_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE SET NULL,
    template_id UUID REFERENCES cv_templates(template_id) ON DELETE SET NULL,
    generated_by UUID REFERENCES users(user_id),
    generation_purpose VARCHAR(100),
    file_path VARCHAR(512),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 17. notifications
CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    notification_type notification_type NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    priority INT DEFAULT 1,
    related_entity_type VARCHAR(100),
    related_entity_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 18. certification_alerts
CREATE TABLE IF NOT EXISTS certification_alerts (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    certification_id UUID REFERENCES certifications(certification_id) ON DELETE CASCADE,
    alert_type alert_type NOT NULL,
    days_until_expiration INT,
    notification_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 19. audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    action_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id UUID,
    ip_address VARCHAR(45),
    user_agent TEXT,
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 20. ai_search_queries
CREATE TABLE IF NOT EXISTS ai_search_queries (
    query_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    query_text TEXT NOT NULL,
    query_intent VARCHAR(100),
    extracted_entities JSONB,
    result_count INT,
    execution_time_ms INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 21. metadata_snapshots
CREATE TABLE IF NOT EXISTS metadata_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE CASCADE,
    metadata_json JSONB NOT NULL,
    is_current BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =============================================
-- FUNCTIONS AND TRIGGERS
-- =============================================

-- Function to automatically update certification status based on expiration date
CREATE OR REPLACE FUNCTION update_certification_status_func() 
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.expiration_date IS NOT NULL THEN
        IF NEW.expiration_date < CURRENT_DATE THEN
            NEW.status := 'expired';
        ELSIF NEW.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN
            NEW.status := 'expiring_soon';
        ELSE
            NEW.status := 'active';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for certifications
DROP TRIGGER IF EXISTS trg_update_cert_status ON certifications;
CREATE TRIGGER trg_update_cert_status
BEFORE INSERT OR UPDATE ON certifications
FOR EACH ROW
EXECUTE FUNCTION update_certification_status_func();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp_func() 
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER trg_update_users_timestamp BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp_func();
CREATE TRIGGER trg_update_profiles_timestamp BEFORE UPDATE ON employee_profiles FOR EACH ROW EXECUTE FUNCTION update_timestamp_func();
