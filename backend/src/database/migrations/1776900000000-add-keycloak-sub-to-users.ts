import { MigrationInterface, QueryRunner } from "typeorm";

export class AddKeycloakSubToUsers1776900000000 implements MigrationInterface {
  name = "AddKeycloakSubToUsers1776900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Identity link to Keycloak. Nullable so existing rows stay valid; filled
    // on first OIDC login (matched by email). Unique to prevent two local
    // users mapping to the same IdP identity.
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS keycloak_sub UUID;`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_keycloak_sub
         ON users (keycloak_sub)
         WHERE keycloak_sub IS NOT NULL;`,
    );
    // Password becomes optional (Keycloak-provisioned users have none).
    await queryRunner.query(
      `ALTER TABLE users ALTER COLUMN password DROP NOT NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ux_users_keycloak_sub;`);
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS keycloak_sub;`,
    );
  }
}
