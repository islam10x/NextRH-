import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResolvedTemplateToGeneratedCvs1774000000000 implements MigrationInterface {
    name = 'AddResolvedTemplateToGeneratedCvs1774000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE generated_cvs
            ADD COLUMN IF NOT EXISTS resolved_template_id UUID REFERENCES cv_templates(template_id)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE generated_cvs
            DROP COLUMN IF EXISTS resolved_template_id
        `);
    }
}
