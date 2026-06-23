import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds editable contact fields to `employee_profiles` so an employee can
 * correct phone/address parsed from their CV. Until now these lived only in
 * the per-employee metadata.json file; they now have a DB column that is the
 * source of truth (metadata.json + RAG are kept in sync from the DB).
 *
 * Both statements are idempotent (`ADD COLUMN IF NOT EXISTS`), so this is safe
 * to run on a production database whether or not the columns already exist.
 */
export class AddProfileContactFields1776800000001 implements MigrationInterface {
  name = "AddProfileContactFields1776800000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "employee_profiles"
      ADD COLUMN IF NOT EXISTS "phone" text
    `);

    await queryRunner.query(`
      ALTER TABLE "employee_profiles"
      ADD COLUMN IF NOT EXISTS "address" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "employee_profiles"
      DROP COLUMN IF EXISTS "address"
    `);

    await queryRunner.query(`
      ALTER TABLE "employee_profiles"
      DROP COLUMN IF EXISTS "phone"
    `);
  }
}
