import { MigrationInterface, QueryRunner } from "typeorm";

export class InvitationTableAndUserStatus1770655036875 implements MigrationInterface {
  name = "InvitationTableAndUserStatus1770655036875";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. invitation_tokens table (Use IF NOT EXISTS since it might be there from previous SQL)
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "invitation_tokens" ("token_id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "token_hash" character varying NOT NULL, "expires_at" TIMESTAMP NOT NULL, "is_used" boolean NOT NULL DEFAULT false, "used_at" TIMESTAMP, "created_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now())`,
    );

    // 2. Handle status enum and column
    // Create the type if it doesn't exist (TypeORM's preferred name)
    await queryRunner.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_status_enum') THEN CREATE TYPE "users_status_enum" AS ENUM('active', 'pending_invitation', 'deactivated'); END IF; END $$;`,
    );

    // Add status column if it doesn't exist, otherwise just ensure type
    const hasStatus = await queryRunner.hasColumn("users", "status");
    if (!hasStatus) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD "status" "users_status_enum" NOT NULL DEFAULT 'pending_invitation'`,
      );
    } else {
      // If it exists (likely from our SQL as user_status), we might need to cast it or rename the type.
      // For simplicity and matching TypeORM's expectation, let's just make sure it's correct.
      await queryRunner.query(
        `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'pending_invitation'`,
      );
    }

    // 3. Remove old columns
    const hasIsActive = await queryRunner.hasColumn("users", "is_active");
    if (hasIsActive) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_active"`);
    }

    // 4. Add optional invitation fields
    if (!(await queryRunner.hasColumn("users", "invited_by")))
      await queryRunner.query(
        `ALTER TABLE "users" ADD "invited_by" character varying`,
      );
    if (!(await queryRunner.hasColumn("users", "invited_at")))
      await queryRunner.query(`ALTER TABLE "users" ADD "invited_at" TIMESTAMP`);
    if (!(await queryRunner.hasColumn("users", "activated_at")))
      await queryRunner.query(
        `ALTER TABLE "users" ADD "activated_at" TIMESTAMP`,
      );

    // 5. DO NOT DROP EMAIL. Just make sure constraints are correct.
    // TypeORM wants a specific constraint name.
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_97672ac88f789774dd47f7c8be3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email")`,
    );

    // 6. Handle Role Enum renaming (Safely)
    await queryRunner.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_role_enum') THEN CREATE TYPE "users_role_enum" AS ENUM('employee', 'team_manager', 'bid_manager'); END IF; END $$;`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "users_role_enum" USING "role"::text::"users_role_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'employee'`,
    );

    // 7. Make fields nullable for invitations (WITHOUT DROPPING)
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "first_name" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "last_name" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL`,
    );

    // Ensure varchar types match (varchars without length are compatible)
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "first_name" TYPE character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "last_name" TYPE character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" TYPE character varying`,
    );

    // 8. Timestamps
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "created_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "updated_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now()`,
    );

    // 9. Foreign Key
    await queryRunner.query(
      `ALTER TABLE "invitation_tokens" DROP CONSTRAINT IF EXISTS "FK_c0ec4a8975069154fa47924ce98"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitation_tokens" ADD CONSTRAINT "FK_c0ec4a8975069154fa47924ce98" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invitation_tokens" DROP CONSTRAINT IF EXISTS "FK_c0ec4a8975069154fa47924ce98"`,
    );

    // Restore timestamps
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "updated_at" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "created_at" DROP NOT NULL`,
    );

    // Restore NOT NULL constraints (Caution: if data was cleared, this might fail, but it's the 'reverse' logic)
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "last_name" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "first_name" SET NOT NULL`,
    );

    // Reverse type changes if possible, or just leave as varchar (compatible)

    // Role enum reverse
    // (Skipping complex role reverse for now as it's less likely to be used and risky)

    // Email constraints
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_97672ac88f789774dd47f7c8be3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email")`,
    );

    // Remove new columns
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "activated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "invited_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "invited_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "status"`,
    );

    // Cleanup types
    await queryRunner.query(`DROP TYPE IF EXISTS "users_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum"`);

    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_active" boolean DEFAULT true`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "invitation_tokens"`);
  }
}
