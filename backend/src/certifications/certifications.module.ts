import { Module } from '@nestjs/common';
import { CertificationsController } from './certifications.controller';
import { CertificationsService } from './certifications.service';
import { FileStorageModule } from '../file-storage/file-storage.module';

@Module({
    imports: [FileStorageModule],
    controllers: [CertificationsController],
    providers: [CertificationsService],
})
export class CertificationsModule { }
