-- Insert a bid_manager user for testing
-- Email: admin@nextrh.com
-- Password: Admin123!

INSERT INTO users (user_id, email, password, first_name, last_name, role, is_active, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'admin@nextrh.com',
    '$2b$10$SkWDBkN8xJWczvBFNoc0ouCwcA4t9oqyhTpm/xVMAXMbffxbGF1wW',
    'Admin',
    'User',
    'bid_manager',
    true,
    NOW(),
    NOW()
);
