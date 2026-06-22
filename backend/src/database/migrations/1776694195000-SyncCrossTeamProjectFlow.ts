import { MigrationInterface, QueryRunner } from "typeorm";
import * as fs from "fs";
import * as path from "path";

export class SyncCrossTeamProjectFlow1776694195000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // We read from the init-scripts to keep a single source of truth and apply them
    const scriptsDir = path.join(process.cwd(), "../database/init-scripts");
    const filesToRun = [
      "25-add-team-name-column.sql",
      "26-cross-team-project-flow.sql",
      "27-add-team-focus-column.sql",
    ];

    for (const file of filesToRun) {
      const filePath = path.join(scriptsDir, file);
      if (fs.existsSync(filePath)) {
        const sql = fs.readFileSync(filePath, "utf8");
        // Run the entire sql file contents as a single query
        await queryRunner.query(sql);
        console.log(`Successfully executed ${file}`);
      } else {
        console.warn(`Could not find ${filePath}`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teams" DROP COLUMN IF EXISTS "team_focus"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teams" DROP COLUMN IF EXISTS "team_name"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "cross_team_assignment_requests" CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_participants" DROP COLUMN IF EXISTS "cross_team_request_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_participants" DROP COLUMN IF EXISTS "home_manager_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_participants" DROP COLUMN IF EXISTS "assignment_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "project_type"`,
    );
  }
}
