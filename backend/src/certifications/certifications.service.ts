import { Injectable } from '@nestjs/common';
import { FileStorageService } from '../file-storage/file-storage.service';

@Injectable()
export class CertificationsService {
    constructor(private readonly fileStorageService: FileStorageService) { }

    async saveEmployeeCertification(userId: string, file: Express.Multer.File) {
        return this.fileStorageService.saveEmployeeFile(userId, file, 'Certifications');
    }
}
