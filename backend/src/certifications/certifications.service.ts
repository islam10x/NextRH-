import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileStorageService } from '../file-storage/file-storage.service';
import { Certification } from './entities/certification.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';

@Injectable()
export class CertificationsService {
    private readonly logger = new Logger(CertificationsService.name);
    private readonly aiServiceBaseUrl: string;

    constructor(
        private readonly fileStorageService: FileStorageService,
        private readonly configService: ConfigService,
        @InjectRepository(Certification)
        private readonly certificationRepository: Repository<Certification>,
        @InjectRepository(EmployeeProfile)
        private readonly profileRepository: Repository<EmployeeProfile>,
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    async saveEmployeeCertification(userId: string, file: Express.Multer.File) {
        // 1. Call AI service for OCR parsing
        let parsedData = null;
        try {
            const formData = new FormData();
            formData.append('user_id', userId);
            const blob = new Blob([file.buffer as any], { type: file.mimetype });
            formData.append('file', blob, file.originalname);

            const aiUrl = `${this.aiServiceBaseUrl}/api/v1/parsing/certification`;
            const aiResponse = await fetch(aiUrl, {
                method: 'POST',
                body: formData,
            });

            if (aiResponse.ok) {
                parsedData = await aiResponse.json();
                this.logger.log(`AI parsing successful for certification: ${JSON.stringify(parsedData)}`);
            } else {
                this.logger.error(`AI parsing failed (${aiResponse.status}) for ${aiUrl}: ${aiResponse.statusText}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cause =
                error && typeof error === 'object' && 'cause' in error
                    ? String((error as { cause?: unknown }).cause)
                    : undefined;
            this.logger.error(
                `Error during AI parsing (base URL: ${this.aiServiceBaseUrl}): ${message}${cause ? ` | cause: ${cause}` : ''}`
            );
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
