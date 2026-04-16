import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvTemplatesController } from './cv-templates.controller';
import { CvTemplatesService } from './cv-templates.service';
import { CvTemplate } from './entities/cv-template.entity';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
    imports: [TypeOrmModule.forFeature([CvTemplate]), FileStorageModule],
    controllers: [CvTemplatesController],
    providers: [CvTemplatesService],
    exports: [CvTemplatesService],
})
export class CvTemplatesModule { }
