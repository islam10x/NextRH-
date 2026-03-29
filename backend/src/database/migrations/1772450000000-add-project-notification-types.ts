import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectNotificationTypes1772450000000 implements MigrationInterface {
    name = 'AddProjectNotificationTypes1772450000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'project_assigned';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'project_updated';
                END IF;
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notifications_notification_type_enum') THEN
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'project_assigned';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'project_updated';
                END IF;
            END$$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No safe down migration for enum value removal.
    }
}
