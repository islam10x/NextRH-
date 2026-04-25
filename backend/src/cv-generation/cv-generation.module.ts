import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvGenerationController } from './cv-generation.controller';
import { CvGenerationService } from './cv-generation.service';
import { GeneratedCv } from './entities/generated-cv.entity';
import { CvTemplate } from '../cv-templates/entities/cv-template.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { CvModule } from '../cv/cv.module';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([GeneratedCv, CvTemplate, EmployeeProfile]),
        CvModule,
        FileStorageModule,
    ],
    controllers: [CvGenerationController],
    providers: [CvGenerationService],
})
export class CvGenerationModule { }
