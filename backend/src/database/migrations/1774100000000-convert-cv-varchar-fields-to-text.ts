import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConvertCvVarcharFieldsToText1774100000000 implements MigrationInterface {
    name = 'ConvertCvVarcharFieldsToText1774100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "first_name" TYPE TEXT,
            ALTER COLUMN "last_name" TYPE TEXT
        `);

        await queryRunner.query(`
            ALTER TABLE "work_experience"
            ALTER COLUMN "job_title" TYPE TEXT,
            ALTER COLUMN "company_name" TYPE TEXT
        `);

        await queryRunner.query(`
            ALTER TABLE "education"
            ALTER COLUMN "degree" TYPE TEXT,
            ALTER COLUMN "field_of_study" TYPE TEXT,
            ALTER COLUMN "institution" TYPE TEXT
        `);

        await queryRunner.query(`
            ALTER TABLE "certifications"
            ALTER COLUMN "certification_name" TYPE TEXT,
            ALTER COLUMN "issuing_organization" TYPE TEXT
        `);

        await queryRunner.query(`
            ALTER TABLE "projects"
            ALTER COLUMN "project_name" TYPE TEXT,
            ALTER COLUMN "client_name" TYPE TEXT
        `);

        await queryRunner.query(`
            ALTER TABLE "project_participants"
            ALTER COLUMN "role" TYPE TEXT
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "project_participants"
            ALTER COLUMN "role" TYPE character varying(255)
            USING LEFT("role", 255)
        `);

        await queryRunner.query(`
            ALTER TABLE "projects"
            ALTER COLUMN "project_name" TYPE character varying(255)
            USING LEFT("project_name", 255),
            ALTER COLUMN "client_name" TYPE character varying(255)
            USING LEFT("client_name", 255)
        `);

        await queryRunner.query(`
            ALTER TABLE "certifications"
            ALTER COLUMN "certification_name" TYPE character varying(255)
            USING LEFT("certification_name", 255),
            ALTER COLUMN "issuing_organization" TYPE character varying(255)
            USING LEFT("issuing_organization", 255)
        `);

        await queryRunner.query(`
            ALTER TABLE "education"
            ALTER COLUMN "degree" TYPE character varying(255)
            USING LEFT("degree", 255),
            ALTER COLUMN "field_of_study" TYPE character varying(255)
            USING LEFT("field_of_study", 255),
            ALTER COLUMN "institution" TYPE character varying(255)
            USING LEFT("institution", 255)
        `);

        await queryRunner.query(`
            ALTER TABLE "work_experience"
            ALTER COLUMN "job_title" TYPE character varying(255)
            USING LEFT("job_title", 255),
            ALTER COLUMN "company_name" TYPE character varying(255)
            USING LEFT("company_name", 255)
        `);

        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "first_name" TYPE character varying(255)
            USING LEFT("first_name", 255),
            ALTER COLUMN "last_name" TYPE character varying(255)
            USING LEFT("last_name", 255)
        `);
    }
}
