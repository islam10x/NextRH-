import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvService } from './cv.service';
import { CvController } from './cv.controller';
import { MetadataSnapshot } from './entities/metadata-snapshot.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { WorkExperience } from '../employees/entities/work-experience.entity';
import { Education } from '../employees/entities/education.entity';
import { Certification } from '../certifications/entities/certification.entity';
import { User } from '../users/entities/user.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectParticipant } from '../projects/entities/participant.entity';
import { Skill } from '../skills/entities/skill.entity';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { RagModule } from '../rag/rag.module';
import { FileValidationModule } from '../file-validation/file-validation.module';
import { AIGenerationModule } from '../ai-generation/ai-generation.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            MetadataSnapshot,
            EmployeeProfile,
            WorkExperience,
            Education,
            Certification,
            User,
            Project,
            ProjectParticipant,
            Skill
        ]),
        FileStorageModule,
        RagModule,
        FileValidationModule,
        AIGenerationModule,
    ],
    controllers: [CvController],
    providers: [CvService],
    exports: [CvService]
})
export class CvModule { }
