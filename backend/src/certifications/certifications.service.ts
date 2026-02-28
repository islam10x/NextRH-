import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileStorageService } from '../file-storage/file-storage.service';
import { Certification } from './entities/certification.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { RagService } from '../rag/rag.service';
import { FileValidationService } from '../file-validation/file-validation.service';
import { formatIsoDate, normalizeFlexibleDate } from '../utils/date-normalizer';

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
        private readonly ragService: RagService,
        private readonly fileValidationService: FileValidationService,
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    async saveEmployeeCertification(user: any, file: Express.Multer.File) {
        await this.fileValidationService.validate(file, 'certification');
        const userId = typeof user === 'string' ? user : user.user_id || user.id;

        // 1. Call AI service for OCR parsing
        let parsedData = null;
        try {
            const formData = new FormData();
            formData.append('user_id', userId);

            if (typeof user === 'object' && user) {
                if (user.firstName) formData.append('first_name', user.firstName);
                if (user.lastName) formData.append('last_name', user.lastName);
            }

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

        if (!parsedData || !parsedData.success) {
            throw new BadRequestException(parsedData?.error || 'Failed to parse certification or verify name match.');
        }
        const parsedExpirationDate = normalizeFlexibleDate(parsedData.expiration_date, 'end');
        const parsedIssueDate = normalizeFlexibleDate(parsedData.issue_date, 'start');

        // 2. Save file to storage
        const storageResult = await this.fileStorageService.saveEmployeeFile(userId, file, 'Certifications');

        // 3. Update metadata.json with certification
        await this.fileStorageService.addCertificationToMetadata(userId, {
            name: parsedData.certification_name,
            issuer: parsedData.issuer,
            expiration: formatIsoDate(parsedExpirationDate) || parsedData.expiration_date || null,
        });

        // 4. Save to database
        await this.saveCertificationToDatabase(userId, parsedData, parsedIssueDate, parsedExpirationDate);

        return {
            ...storageResult,
            parsed_data: parsedData,
        };
    }

    private async saveCertificationToDatabase(
        userId: string,
        parsedData: any,
        parsedIssueDate: Date | null,
        parsedExpirationDate: Date | null,
    ) {
        // Find user's profile
        const profile = await this.profileRepository.findOne({
            where: { user: { user_id: userId } },
        });

        if (!profile) {
            this.logger.warn(`No profile found for user ${userId}, skipping DB save`);
            return;
        }

        // Check if a certification with this name already exists for this user (e.g. from a CV parse)
        const certName = parsedData.certification_name || 'Unknown Certification';
        const existingCert = await this.certificationRepository.findOne({
            where: {
                profile: { profile_id: profile.profile_id },
                certificationName: certName,
            }
        });

        if (existingCert) {
            // Upgrade existing CV-parsed cert to a verified uploaded cert
            existingCert.isUploaded = true;
            existingCert.issuingOrganization = parsedData.issuer || existingCert.issuingOrganization;
            existingCert.issueDate = parsedIssueDate || existingCert.issueDate;
            existingCert.expirationDate = parsedExpirationDate || existingCert.expirationDate;
            existingCert.credentialId = parsedData.credential_id || existingCert.credentialId;

            await this.certificationRepository.save(existingCert);
            this.logger.log(`Upgraded existing certification to uploaded status for user ${userId}`);
        } else {
            // Create and save new certification
            const certification = this.certificationRepository.create({
                profile: profile,
                certificationName: certName,
                issuingOrganization: parsedData.issuer,
                issueDate: parsedIssueDate,
                expirationDate: parsedExpirationDate,
                credentialId: parsedData.credential_id,
                isUploaded: true,
            });

            await this.certificationRepository.save(certification);
            this.logger.log(`Saved new verified certification to database for user ${userId}`);
        }

        // Trigger RAG Sync
        await this.ragService.triggerUserSync(userId);
    }
}
