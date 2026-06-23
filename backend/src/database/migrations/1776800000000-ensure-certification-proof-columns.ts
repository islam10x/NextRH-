import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Ensures the `certifications` table has the columns required by the proof
 * verification flow:
 *   - `is_uploaded` : whether a proof was uploaded (strict gating source of truth)
 *   - `file_path`   : path to the stored proof file (so managers can view it)
 *
 * Both statements are idempotent (`ADD COLUMN IF NOT EXISTS`) because the
 * `certifications` table predates the repo migrations and `is_uploaded` already
 * exists on existing environments. This migration is therefore safe to run on a
 * production database whether or not the columns are already present.
 */
export class EnsureCertificationProofColumns1776800000000 implements MigrationInterface {
  name = "EnsureCertificationProofColumns1776800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "certifications"
      ADD COLUMN IF NOT EXISTS "is_uploaded" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE "certifications"
      ADD COLUMN IF NOT EXISTS "file_path" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only drop the column this migration is the first to introduce. `is_uploaded`
    // predates this migration and is used by existing code, so it is left intact.
    await queryRunner.query(`
      ALTER TABLE "certifications"
      DROP COLUMN IF EXISTS "file_path"
    `);
  }
}
