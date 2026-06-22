import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTemplateFieldMappingAndGenerationStatus1773500000000 implements MigrationInterface {
  name = "AddTemplateFieldMappingAndGenerationStatus1773500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Template field mapping cache: stores computed { pdfFieldName: contextKey } mappings.
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS field_mapping JSONB;`,
    );
    // Detected fields: stores the raw list of placeholder/field names found in the template.
    await queryRunner.query(
      `ALTER TABLE cv_templates ADD COLUMN IF NOT EXISTS detected_fields JSONB;`,
    );

    // Generation status tracking.
    await queryRunner.query(`
            DO $$
            BEGIN
                CREATE TYPE generation_status AS ENUM ('pending', 'processing', 'completed', 'failed');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);
    await queryRunner.query(
      `ALTER TABLE generated_cvs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed';`,
    );
    await queryRunner.query(
      `ALTER TABLE generated_cvs ADD COLUMN IF NOT EXISTS error_message TEXT;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE generated_cvs DROP COLUMN IF EXISTS error_message;`,
    );
    await queryRunner.query(
      `ALTER TABLE generated_cvs DROP COLUMN IF EXISTS status;`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates DROP COLUMN IF EXISTS detected_fields;`,
    );
    await queryRunner.query(
      `ALTER TABLE cv_templates DROP COLUMN IF EXISTS field_mapping;`,
    );
  }
}
