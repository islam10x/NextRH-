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

-- Insert a team_manager user for testing
-- Email: manager2@nextrh.com
-- Password: Manager123!

INSERT INTO users (user_id, email, password, first_name, last_name, role, is_active, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'manager2@nextrh.com',
    '$2b$10$vThr2dFeqZzCTRfkKrqFaerQbaoJQau/FdYBFQ3uAf25c88ywG0vC',
    'Manager',
    'Two',
    'team_manager',
    true,
    NOW(),
    NOW()
);

-- Insert an employee user for testing
-- Email: user4@nextrh.com
-- Password: Password123!

INSERT INTO users (user_id, email, password, first_name, last_name, role, is_active, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'user4@nextrh.com',
    '$2b$10$IOAzp/2qYq3L0dAW.I7Fuu.v3QrZYF3zpPxqv73EIL1xfX5uJ5bMi',
    'User',
    'Four',
    'employee',
    true,
    NOW(),
    NOW()
);
