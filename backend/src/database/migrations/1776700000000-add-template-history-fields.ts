import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTemplateHistoryFields1776700000000 implements MigrationInterface {
  name = "AddTemplateHistoryFields1776700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "cv_templates"
            ADD COLUMN IF NOT EXISTS "uploaded_by" UUID NULL,
            ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMP NULL,
            ADD COLUMN IF NOT EXISTS "usage_count" INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "file_hash" CHAR(64) NULL
        `);

    await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE constraint_name = 'fk_cv_templates_uploaded_by'
                ) THEN
                    ALTER TABLE "cv_templates"
                    ADD CONSTRAINT "fk_cv_templates_uploaded_by"
                    FOREIGN KEY ("uploaded_by") REFERENCES "users"("user_id") ON DELETE SET NULL;
                END IF;
            END $$
        `);

    // Per-user dedup index: each bid manager can only have one row per
    // (uploaded_by, file_hash) pair so the same template uploaded twice
    // bumps usage instead of duplicating storage.
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "ux_cv_templates_uploader_hash"
            ON "cv_templates" ("uploaded_by", "file_hash")
            WHERE "file_hash" IS NOT NULL AND "uploaded_by" IS NOT NULL
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX IF EXISTS "ux_cv_templates_uploader_hash"
        `);
    await queryRunner.query(`
            ALTER TABLE "cv_templates"
            DROP CONSTRAINT IF EXISTS "fk_cv_templates_uploaded_by",
            DROP COLUMN IF EXISTS "file_hash",
            DROP COLUMN IF EXISTS "usage_count",
            DROP COLUMN IF EXISTS "last_used_at",
            DROP COLUMN IF EXISTS "uploaded_by"
        `);
  }
}
