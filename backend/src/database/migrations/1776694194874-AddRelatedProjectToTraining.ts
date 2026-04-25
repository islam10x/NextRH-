import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRelatedProjectToTraining1776694194874 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "training_sessions" ADD COLUMN IF NOT EXISTS "related_project_id" uuid`);
        await queryRunner.query(`ALTER TABLE "training_sessions" ADD CONSTRAINT "FK_training_sessions_related_project" FOREIGN KEY ("related_project_id") REFERENCES "projects"("project_id") ON DELETE SET NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "training_sessions" DROP CONSTRAINT IF EXISTS "FK_training_sessions_related_project"`);
        await queryRunner.query(`ALTER TABLE "training_sessions" DROP COLUMN IF EXISTS "related_project_id"`);
    }

}
