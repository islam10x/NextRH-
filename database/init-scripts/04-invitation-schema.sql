-- 04-invitation-schema.sql

-- 1. Create user_status enum
CREATE TYPE user_status AS ENUM ('active', 'pending_invitation', 'deactivated');

-- 2. Update users table structure
ALTER TABLE users 
    ADD COLUMN status user_status DEFAULT 'pending_invitation',
    ADD COLUMN invited_by UUID REFERENCES users(user_id),
    ADD COLUMN invited_at TIMESTAMP,
    ADD COLUMN activated_at TIMESTAMP,
    DROP COLUMN is_active;

-- Make fields nullable for invitation flow
ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

-- Handle existing users (migration)
-- Assuming existing users are all active
UPDATE users SET status = 'active' WHERE status = 'pending_invitation' AND password IS NOT NULL;

-- 3. Create invitation_tokens table
CREATE TABLE IF NOT EXISTS invitation_tokens (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMP,
    created_by UUID REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster token lookups
CREATE INDEX idx_invitation_tokens_user_id ON invitation_tokens(user_id);
