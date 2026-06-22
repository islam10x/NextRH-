import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCvTemplatesAndGeneratedCvs1773000000000 implements MigrationInterface {
  name = "AddCvTemplatesAndGeneratedCvs1773000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DO $$
            BEGIN
                CREATE TYPE template_type AS ENUM ('standard', 'canadian', 'eu', 'client_specific');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);

    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS cv_templates (
                template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                template_name VARCHAR(255) NOT NULL,
                template_type template_type NOT NULL,
                file_path VARCHAR(512),
                font_family VARCHAR(100),
                layout_config JSONB,
                language VARCHAR(10),
                original_filename VARCHAR(255),
                uploaded_by UUID REFERENCES users(user_id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS language VARCHAR(10);`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255);`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(user_id);`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
    );

    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS generated_cvs (
                generated_cv_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                profile_id UUID REFERENCES employee_profiles(profile_id) ON DELETE SET NULL,
                template_id UUID REFERENCES cv_templates(template_id) ON DELETE SET NULL,
                generated_by UUID REFERENCES users(user_id),
                generation_purpose VARCHAR(100),
                file_path VARCHAR(512),
                pdf_path VARCHAR(512),
                language VARCHAR(10),
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    await queryRunner.query(
      `ALTER TABLE generated_cvs ADD COLUMN IF NOT EXISTS pdf_path VARCHAR(512);`,
    );
    await queryRunner.query(
      `ALTER TABLE generated_cvs ADD COLUMN IF NOT EXISTS language VARCHAR(10);`,
    );
    await queryRunner.query(
      `ALTER TABLE generated_cvs ADD COLUMN IF NOT EXISTS generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS generated_cvs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS cv_templates;`);
  }
}
