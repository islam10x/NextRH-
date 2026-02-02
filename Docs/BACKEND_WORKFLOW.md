# Backend Development Workflow (NestJS & TypeORM)

This document outlines the workflow for setting up the backend, managing database migrations, and understanding the project configuration.

## 1. Initial Setup

Before starting, ensure you have Node.js and npm installed.

```bash
# Navigate to backend directory
cd backend

# Install dependencies (Including dev dependencies for TypeORM CLI)
npm install

# Install dotenv (Required for data-source.ts to read .env file during migrations)
npm install dotenv --save-dev
```

## 2. Environment Configuration

Ensure your `.env` file in the root of the project contains the correct database credentials. The backend uses these variables to connect to the database.

Example `.env`:
```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=change_me
DB_NAME=cv_management
```

## 3. Database Migrations (TypeORM)

We use TypeORM for database schema management.

**Why migrations?**
Migrations allow us to version control our database schema changes. Instead of manually running SQL scripts, we generate migration files that instruct the database how to update.

### Commands

All commands should be run from the `backend/` directory.

#### Generate a Migration
Run this command after you have modified an entity file (e.g., `user.entity.ts`). It will compare your code entities with the current database schema and generate a new migration file.

```bash
# Syntax: npm run migration:generate -- src/database/migrations/<MigrationName>
npm run migration:generate -- src/database/migrations/AddUserTable
```

#### Run Pending Migrations
Apply all pending migrations to the database. This updates your local database schema.

```bash
npm run migration:run
```

#### Revert Last Migration
Undo the last applied migration. Useful if you made a mistake or need to rollback changes.

```bash
npm run migration:revert
```

## 4. Database Initialization (Docker)

The files in `database/init-scripts/` (SQL files) are **only** used when the PostgreSQL Docker container is created for the *very first time* to initialize the database structure or seed data.

-   **Development Workflow**: Use TypeORM migrations (above) for ongoing schema changes.
-   **New Setup**: When spinning up the project fresh (e.g., `docker-compose up`), the init scripts run first, followed by any applied migrations.

## 5. Running the Backend

```bash
# Start in development mode (with hot-reload)
npm run start:dev

# Start in debug mode
npm run start:debug

# Build for production
npm run build
```

## 6. Verification & Troubleshooting

### Verify Database Tables
To confirm that your tables were correctly created in the Docker container, run:

```bash
docker exec -it cv-postgres psql -U postgres -d cv_management -c "\dt"
```

### Reset Database (Force Re-initialization)
If the database fails to initialize or if you want to wipe it and start fresh with the `init-scripts`, you must delete the Docker volume:

```bash
# Stop containers and delete all data volumes
docker-compose down -v

# Start everything fresh
docker-compose up -d
```

> [!IMPORTANT]
> The `docker-compose down -v` command is destructive. It will permanently delete all data in your local database. Use it only when resetting your development environment.

