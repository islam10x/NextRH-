import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectAssignedBy1772455000000 implements MigrationInterface {
  name = "AddProjectAssignedBy1772455000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "project_participants"
            ADD COLUMN IF NOT EXISTS "assigned_by" uuid
        `);

    await queryRunner.query(`
            ALTER TABLE "project_participants"
            DROP CONSTRAINT IF EXISTS "FK_project_participants_assigned_by"
        `);

    await queryRunner.query(`
            ALTER TABLE "project_participants"
            ADD CONSTRAINT "FK_project_participants_assigned_by"
            FOREIGN KEY ("assigned_by") REFERENCES "users"("user_id")
            ON DELETE SET NULL ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_participants" DROP CONSTRAINT IF EXISTS "FK_project_participants_assigned_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_participants" DROP COLUMN IF EXISTS "assigned_by"`,
    );
  }
}
