import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileStorageService } from '../file-storage/file-storage.service';
import { Certification, CertificationStatus } from './entities/certification.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { RagService } from '../rag/rag.service';
import { FileValidationService } from '../file-validation/file-validation.service';
import { formatIsoDate, normalizeFlexibleDate } from '../utils/date-normalizer';
import { TeamsService } from '../teams/teams.service';

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
        private readonly teamsService: TeamsService,
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
        const certName = (parsedData.certification_name || 'Certification').trim();
        const preferredFileName = certName.slice(0, 120);

        // 2. Save file to storage
        const storageResult = await this.fileStorageService.saveEmployeeFile(
            userId,
            file,
            'Certifications',
            { preferredFileName, overwrite: true },
        );

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

    /**
     * Get global certification statistics for BID managers
     */
    async getGlobalCertStats() {
        const today = new Date();
        const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

        const all = await this.certificationRepository
            .createQueryBuilder('cert')
            .leftJoinAndSelect('cert.profile', 'profile')
            .getMany();

        const stats = {
            total: all.length,
            active: 0,
            expiringSoon: 0,
            expired: 0,
            expiringThisMonth: 0,
        };

        const byOrg: Record<string, number> = {};

        for (const cert of all) {
            const status = this.calculateStatus(cert.expirationDate);
            if (status === CertificationStatus.ACTIVE) stats.active++;
            else if (status === CertificationStatus.EXPIRING_SOON) stats.expiringSoon++;
            else if (status === CertificationStatus.EXPIRED) stats.expired++;

            if (cert.expirationDate) {
                const exp = new Date(cert.expirationDate);
                if (exp >= today && exp <= endOfMonth) stats.expiringThisMonth++;
            }

            const org = cert.issuingOrganization?.split(' ')[0] || 'Other';
            byOrg[org] = (byOrg[org] || 0) + 1;
        }

        const byOrgArray = Object.entries(byOrg)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 6);

        return { ...stats, byOrg: byOrgArray };
    }

    /**
     * Get all certifications for team members managed by a specific manager
     */
    async getTeamCertifications(managerUserId: string) {
        // Get team members
        const teamMembers = await this.teamsService.getMembersForManager(managerUserId);
        
        if (teamMembers.length === 0) {
            return [];
        }

        // Get profile IDs for team members
        const profileIds = teamMembers.map(member => member.profileId).filter(Boolean);
        
        if (profileIds.length === 0) {
            return [];
        }

        // Query certifications for all team members with employee details
        const certifications = await this.certificationRepository
            .createQueryBuilder('cert')
            .leftJoinAndSelect('cert.profile', 'profile')
            .leftJoinAndSelect('profile.user', 'user')
            .where('cert.profile.profile_id IN (:...profileIds)', { profileIds })
            .orderBy('cert.expirationDate', 'ASC')
            .getMany();

        // Map to include employee information
        return certifications.map(cert => ({
            certification_id: cert.certification_id,
            certificationName: cert.certificationName,
            issuingOrganization: cert.issuingOrganization,
            issueDate: cert.issueDate,
            expirationDate: cert.expirationDate,
            status: this.calculateStatus(cert.expirationDate),
            credentialId: cert.credentialId,
            employeeId: cert.profile?.user?.user_id,
            employeeName: cert.profile?.user ? 
                `${cert.profile.user.firstName || ''} ${cert.profile.user.lastName || ''}`.trim() || cert.profile.user.email :
                'Unknown',
            employeeEmail: cert.profile?.user?.email,
        }));
    }

    /**
     * Calculate certification status based on expiration date
     */
    private calculateStatus(expirationDate: Date | null): CertificationStatus {
        if (!expirationDate) {
            return CertificationStatus.ACTIVE;
        }

        const now = new Date();
        const expDate = new Date(expirationDate);
        const daysUntilExpiration = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiration < 0) {
            return CertificationStatus.EXPIRED;
        } else if (daysUntilExpiration <= 30) {
            return CertificationStatus.EXPIRING_SOON;
        } else {
            return CertificationStatus.ACTIVE;
        }
    }

    /**
     * Get certification statistics for a team
     */
    async getTeamCertificationStats(managerUserId: string) {
        const certifications = await this.getTeamCertifications(managerUserId);
        
        const stats = {
            total: certifications.length,
            active: 0,
            expiring_soon: 0,
            expired: 0,
        };

        certifications.forEach(cert => {
            switch (cert.status) {
                case CertificationStatus.ACTIVE:
                    stats.active++;
                    break;
                case CertificationStatus.EXPIRING_SOON:
                    stats.expiring_soon++;
                    break;
                case CertificationStatus.EXPIRED:
                    stats.expired++;
                    break;
            }
        });

        return stats;
    }
}
