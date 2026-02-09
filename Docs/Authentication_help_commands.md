# NextRH Backend API Guide

This guide provides step-by-step instructions to run the backend, authenticating users, and testing the API endpoints.

## 1. Prerequisites

- Docker and Docker Compose installed
- Git

## 2. Starting the Application

Since we added new dependencies (`password-jwt`, `bcryptjs`, etc.), you must verify the backend container is built with the latest changes.

```bash
# Navigate to the project root
cd /path/to/NextRH

# Rebuild and start the containers
docker-compose down
docker-compose up -d --build
```

Wait for the containers to start. You can check the logs:
```bash
docker-compose logs -f backend
```

## 3. Database Initialization

The system effectively uses an admin user seeded via the initialization scripts (`database/init-scripts/`).
If you reset your database (`docker-compose down -v`), these scripts run automatically.

**Default Admin Credentials:**
- **Email:** `admin@nextrh.com`
- **Password:** `Admin123!`
- **Role:** `bid_manager`

## 4. Authentication Flow (How to Login)

All API requests (except login) require a **Bearer Token**.

### Step 1: Login to get a Token

Run this command in your terminal (or use Postman):

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@nextrh.com",
    "password": "Admin123!"
  }'
```

**Response Example:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "user_id": "uuid-string",
    "email": "admin@nextrh.com",
    "role": "bid_manager"
  }
}
```

### Step 2: Use the Token

Copy the `access_token` string. You will include it in the `Authorization` header for all subsequent requests.

`Authorization: Bearer <YOUR_ACCESS_TOKEN>`

## 5. Testing Endpoints

### A. Get Your Profile
**Who:** Any authenticated user.

```bash
curl -X GET http://localhost:3000/auth/profile \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"
```

### B. Create a New User (Employee)
**Who:** `bid_manager` only.

```bash
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  -d '{
    "email": "john.doe@Example.com",
    "password": "Password123!",
    "firstName": "John",
    "lastName": "Doe",
    "role": "employee"
  }'
```

### C. List All Users
**Who:** `bid_manager` only.

```bash
curl -X GET http://localhost:3000/users \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"
```

### D. Get Specific User
**Who:** Any authenticated user.

```bash
curl -X GET http://localhost:3000/users/<USER_UUID> \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>"
```

## 6. Role-Based Access Reference

| Endpoint | Method | Allowed Roles |
|----------|--------|---------------|
| `/auth/login` | POST | Public |
| `/auth/profile` | GET | All Authenticated |
| `/users` | GET | `bid_manager` |
| `/users` | POST | `bid_manager` |
| `/users/:id` | GET | All Authenticated |
| `/users/:id` | PATCH | `bid_manager` |
| `/users/:id` | DELETE | `bid_manager` |

## 7. Troubleshooting

**"Error: Connection refused"**
- Ensure backend container is running: `docker ps`
- Check logs: `docker logs cv-backend`

**"401 Unauthorized"**
- Your token might be expired (lasts 15 mins). Login again to get a new one.
- Ensure you copied the full token.

**"403 Forbidden"**
- You are trying to access a `bid_manager` route (like `POST /users`) with a non-admin user (like `employee`).

## 8. Quick Database Check

To see all users directly in the database (bypassing the API), run:

```bash
docker exec -it cv-postgres psql -U postgres -d cv_management -c "SELECT user_id, email, role, status FROM users;"
```

## 9. Manually Create Admin User

If the database was already initialized and you need to add the admin user manually, run:

```bash
docker exec -it cv-postgres psql -U postgres -d cv_management -f /docker-entrypoint-initdb.d/03-insert-admin.sql
```
