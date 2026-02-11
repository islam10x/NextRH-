import { Injectable } from '@nestjs/common';
import { FileStorageService } from '../file-storage/file-storage.service';

@Injectable()
export class CvService {
    constructor(private readonly fileStorageService: FileStorageService) { }

    async saveEmployeeCv(userId: string, file: Express.Multer.File) {
        return this.fileStorageService.saveEmployeeFile(userId, file, 'CV');
    }
}
