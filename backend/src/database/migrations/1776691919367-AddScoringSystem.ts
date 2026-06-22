import { MigrationInterface, QueryRunner } from "typeorm";
import * as fs from "fs";
import * as path from "path";

export class AddScoringSystem1776691919367 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // We read from the init-scripts to keep a single source of truth and apply them
    const scriptsDir = path.join(process.cwd(), "../database/init-scripts");
    const filesToRun = [
      "17-scoring-system-schema.sql",
      "18-add-project-complexity.sql",
      "19-add-formation-scoring.sql",
      "20-scoring-raw-points.sql",
      "21-scoring-production-fixes.sql",
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
    // We skip full rollback as this mirrors init-scripts
    await queryRunner.query(`DROP TABLE IF EXISTS employee_scores CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS scoring_weights CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS scoring_targets CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS training_records CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS project_records CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS document_hashes CASCADE`);
    await queryRunner.query(
      `ALTER TABLE projects DROP COLUMN IF EXISTS complexity`,
    );
  }
}
