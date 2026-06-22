import { MigrationInterface, QueryRunner } from "typeorm";

export class PasswordResetTokens1772270000000 implements MigrationInterface {
  name = "PasswordResetTokens1772270000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
                "token_id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
                "user_id" uuid NOT NULL,
                "token_hash" character varying NOT NULL,
                "expires_at" TIMESTAMP NOT NULL,
                "is_used" boolean NOT NULL DEFAULT false,
                "used_at" TIMESTAMP,
                "requested_ip" character varying,
                "requested_user_agent" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now()
            )
        `);

    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user_id"
            ON "password_reset_tokens" ("user_id")
        `);

    await queryRunner.query(`
            ALTER TABLE "password_reset_tokens"
            DROP CONSTRAINT IF EXISTS "FK_password_reset_tokens_user_id"
        `);

    await queryRunner.query(`
            ALTER TABLE "password_reset_tokens"
            ADD CONSTRAINT "FK_password_reset_tokens_user_id"
            FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
            ON DELETE CASCADE ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DROP CONSTRAINT IF EXISTS "FK_password_reset_tokens_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_password_reset_tokens_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_tokens"`);
  }
}
