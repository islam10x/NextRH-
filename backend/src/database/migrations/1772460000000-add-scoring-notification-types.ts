import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoringNotificationTypes1772460000000 implements MigrationInterface {
    name = 'AddScoringNotificationTypes1772460000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'pv_uploaded';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'score_updated';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_requested';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_selected';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cross_team_member_rejected';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'external_member_evaluation_requested';
                    ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'external_member_score_submitted';
                END IF;
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notifications_notification_type_enum') THEN
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'pv_uploaded';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'score_updated';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'cross_team_member_requested';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'cross_team_member_selected';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'cross_team_member_rejected';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'external_member_evaluation_requested';
                    ALTER TYPE notifications_notification_type_enum ADD VALUE IF NOT EXISTS 'external_member_score_submitted';
                END IF;
            END$$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No safe down migration for enum value removal.
    }
}
