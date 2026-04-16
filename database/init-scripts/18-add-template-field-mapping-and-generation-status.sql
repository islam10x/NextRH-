-- 18-add-template-field-mapping-and-generation-status.sql
-- Adds cached field mapping to templates and status tracking to generated CVs.

ALTER TABLE cv_templates
    ADD COLUMN IF NOT EXISTS field_mapping JSONB,
    ADD COLUMN IF NOT EXISTS detected_fields JSONB;

ALTER TABLE generated_cvs
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS error_message TEXT;
