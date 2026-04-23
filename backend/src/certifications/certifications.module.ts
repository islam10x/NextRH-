import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CertificationsController } from './certifications.controller';
import { CertificationsService } from './certifications.service';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { RagModule } from '../rag/rag.module';
import { TeamsModule } from '../teams/teams.module';
import { Certification } from './entities/certification.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { FileValidationModule } from '../file-validation/file-validation.module';
import { ScoringModule } from '../scoring/scoring.module';

@Module({
    imports: [
        FileStorageModule,
        TypeOrmModule.forFeature([Certification, EmployeeProfile]),
        RagModule,
        FileValidationModule,
        TeamsModule,
        ScoringModule,
    ],
    controllers: [CertificationsController],
    providers: [CertificationsService],
})
export class CertificationsModule { }
