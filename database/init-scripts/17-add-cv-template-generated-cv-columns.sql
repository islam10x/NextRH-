-- 17-add-cv-template-generated-cv-columns.sql
-- Keeps init-script schema aligned with latest CV template + generation features.

ALTER TABLE cv_templates
    ADD COLUMN IF NOT EXISTS language VARCHAR(10),
    ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255),
    ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(user_id),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE generated_cvs
    ADD COLUMN IF NOT EXISTS pdf_path VARCHAR(512),
    ADD COLUMN IF NOT EXISTS language VARCHAR(10),
    ADD COLUMN IF NOT EXISTS generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
