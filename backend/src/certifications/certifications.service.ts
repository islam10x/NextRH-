import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileStorageService } from '../file-storage/file-storage.service';
import { Certification } from './entities/certification.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';

@Injectable()
export class CertificationsService {
    private readonly logger = new Logger(CertificationsService.name);

    constructor(
        private readonly fileStorageService: FileStorageService,
        @InjectRepository(Certification)
        private readonly certificationRepository: Repository<Certification>,
        @InjectRepository(EmployeeProfile)
        private readonly profileRepository: Repository<EmployeeProfile>,
    ) { }

    async saveEmployeeCertification(userId: string, file: Express.Multer.File) {
        // 1. Call AI service for OCR parsing
        let parsedData = null;
        try {
            const formData = new FormData();
            formData.append('user_id', userId);
            const blob = new Blob([file.buffer as any], { type: file.mimetype });
            formData.append('file', blob, file.originalname);

            const aiResponse = await fetch('http://localhost:8000/api/v1/parsing/certification', {
                method: 'POST',
                body: formData,
            });

            if (aiResponse.ok) {
                parsedData = await aiResponse.json();
                this.logger.log(`AI parsing successful for certification: ${JSON.stringify(parsedData)}`);
            } else {
                this.logger.error(`AI parsing failed: ${aiResponse.statusText}`);
            }
        } catch (error) {
            this.logger.error(`Error during AI parsing: ${error.message}`);
        }

        // 2. Save file to storage
        const storageResult = await this.fileStorageService.saveEmployeeFile(userId, file, 'Certifications');

        // 3. Update metadata.json with certification
        if (parsedData && parsedData.success) {
            await this.fileStorageService.addCertificationToMetadata(userId, {
                name: parsedData.certification_name,
                issuer: parsedData.issuer,
                expiration: parsedData.expiration_date,
            });
        }

        // 4. Save to database
        if (parsedData && parsedData.success) {
            await this.saveCertificationToDatabase(userId, parsedData);
        }

        return {
            ...storageResult,
            parsed_data: parsedData,
        };
    }

    private async saveCertificationToDatabase(userId: string, parsedData: any) {
        // Find user's profile
        const profile = await this.profileRepository.findOne({
            where: { user: { user_id: userId } },
        });

        if (!profile) {
            this.logger.warn(`No profile found for user ${userId}, skipping DB save`);
            return;
        }

        // Create and save certification
        const certification = this.certificationRepository.create({
            profile: profile,
            certificationName: parsedData.certification_name || 'Unknown Certification',
            issuingOrganization: parsedData.issuer,
            expirationDate: parsedData.expiration_date,
        });

        await this.certificationRepository.save(certification);
        this.logger.log(`Saved certification to database for user ${userId}`);
    }
}
