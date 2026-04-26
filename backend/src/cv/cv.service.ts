import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MetadataSnapshot } from './entities/metadata-snapshot.entity';
import { User } from '../users/entities/user.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { WorkExperience } from '../employees/entities/work-experience.entity';
import { Education } from '../employees/entities/education.entity';
import { Certification, CertificationStatus } from '../certifications/entities/certification.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectParticipant } from '../projects/entities/participant.entity';
import { FileStorageService } from '../file-storage/file-storage.service';
import { RagService } from '../rag/rag.service';
import { FileValidationService } from '../file-validation/file-validation.service';
import { normalizeFlexibleDate, parseFlexibleDateRange } from '../utils/date-normalizer';
import { AIGenerationService } from '../ai-generation/ai-generation.service';

@Injectable()
export class CvService {
    private readonly logger = new Logger(CvService.name);
    private readonly aiServiceBaseUrl: string;
    private static readonly NEXT_STEP_COMPANY_KEYS = new Set(['nextstepit', 'nextstep']);

    constructor(
        @InjectRepository(MetadataSnapshot)
        private metadataRepository: Repository<MetadataSnapshot>,
        @InjectRepository(EmployeeProfile)
        private profileRepository: Repository<EmployeeProfile>,
        @InjectRepository(User)
        private userRepository: Repository<User>,
        @InjectRepository(WorkExperience)
        private experienceRepository: Repository<WorkExperience>,
        @InjectRepository(Education)
        private educationRepository: Repository<Education>,
        @InjectRepository(Certification)
        private certificationRepository: Repository<Certification>,
        @InjectRepository(Project)
        private projectRepository: Repository<Project>,
        @InjectRepository(ProjectParticipant)
        private participantRepository: Repository<ProjectParticipant>,
        private readonly fileStorageService: FileStorageService,
        private readonly configService: ConfigService,
        private readonly ragService: RagService,
        private readonly fileValidationService: FileValidationService,
        private readonly aiGenerationService: AIGenerationService,
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    /**
     * Returns a flat DTO of the employee's full CV profile pulled from the DB
     * plus skills from the metadata.json file.
     */
    async getMyProfile(userId: string) {
        const user = await this.userRepository.findOne({ where: { user_id: userId } });
        if (!user) throw new NotFoundException(`User ${userId} not found`);

        const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

        const profile = await this.profileRepository.findOne({
            where: { user: { user_id: userId } },
            relations: [
                'workExperiences',
                'educations',
                'certifications',
                'projectParticipations',
                'projectParticipations.project',
                'projectParticipations.project.skills',
            ],
        });

        // Skills live in the metadata.json file (populated during CV parse)
        const metaData = await this.fileStorageService.getEmployeeMetadata(userId);
        const rawMeta = await this.fileStorageService.getRawMetadata(userId);
        const phone = rawMeta?.structured_data?.phone || null;
        // Prefer email from parsed CV (structured_data.email) over the NextRH system account email
        const structuredEmail: string | null =
            typeof rawMeta?.structured_data?.email === 'string' &&
            rawMeta.structured_data.email.includes('@')
                ? rawMeta.structured_data.email.trim()
                : null;
        // Address often has trailing parser artifacts — cut at common section headers
        const rawAddress: string = rawMeta?.structured_data?.address || '';
        const address = rawAddress
            ? rawAddress
                  .split(
                      /\s+(?:Exp[eé]riences?|Formation|Certif|Comp[eé]tences?|Skills|Education|Projects?|P[eé]riode|Organisme|Fonction\s+occup)/i,
                  )[0]
                  .trim() || null
            : null;
        const cvFilename = rawMeta?.filename || null;
        const fallbackCertifications = this.extractCertificationsFromMetadata(rawMeta);
        const toDateString = (value: Date | string | null | undefined) => {
            if (!value) return null;
            if (value instanceof Date) {
                return isNaN(value.getTime()) ? null : value.toISOString().split('T')[0];
            }
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (!trimmed) return null;
                const parsed = new Date(trimmed);
                if (!isNaN(parsed.getTime())) {
                    return parsed.toISOString().split('T')[0];
                }
                return trimmed;
            }
            return null;
        };

        if (!profile) {
            return {
                profileId: null,
                profile_id: null,
                name: fullName,
                email: structuredEmail || user.email,
                phone,
                address,
                cvFilename,
                currentPosition: null,
                professionalSummary: null,
                totalExperienceYears: null,
                skills: metaData.skills ?? [],
                lastUpdate: metaData.last_update ?? null,
                workExperiences: [],
                educations: [],
                certifications: fallbackCertifications,
                projects: [],
            };
        }

        const workExperiences = (profile.workExperiences ?? []).map((exp) => ({
            id: exp.experience_id,
            jobTitle: exp.jobTitle,
            companyName: exp.companyName,
            startDate: toDateString(exp.startDate),
            endDate: toDateString(exp.endDate),
            isCurrent: exp.isCurrent,
            description: exp.description,
        }));

        const educations = (profile.educations ?? []).map((edu) => ({
            id: edu.education_id,
            degree: edu.degree,
            fieldOfStudy: edu.fieldOfStudy,
            institution: edu.institution,
            endDate: toDateString(edu.endDate),
        }));

        let certifications = (profile.certifications ?? []).map((cert) => ({
            id: cert.certification_id,
            name: cert.certificationName,
            issuingOrganization: cert.issuingOrganization,
            issueDate: toDateString(cert.issueDate),
            expirationDate: toDateString(cert.expirationDate),
            status: cert.status,
            isUploaded: cert.isUploaded ?? false,
        }));
        if (certifications.length === 0 && fallbackCertifications.length > 0) {
            certifications = fallbackCertifications;
        }

        const projects = (profile.projectParticipations ?? []).map((p) => ({
            id: p.participant_id,
            name: p.project?.projectName ?? '',
            generatedTitle: p.project?.generatedTitle ?? null,
            client: p.project?.clientName ?? null,
            description: p.description || p.project?.projectDescription || '',
            role: null,
            skills: (p.project?.skills ?? []).map((s) => s.skillName),
            startDate: toDateString(p.project?.startDate),
            endDate: toDateString(p.project?.endDate),
        }));

        return {
            profileId: profile.profile_id,
            profile_id: profile.profile_id,
            name: fullName,
            email: structuredEmail || user.email,
            phone,
            address,
            cvFilename,
            currentPosition: profile.currentPosition ?? null,
            professionalSummary: profile.professionalSummary ?? null,
            totalExperienceYears: profile.totalExperienceYears ?? null,
            skills: metaData.skills ?? [],
            lastUpdate: metaData.last_update ?? null,
            workExperiences,
            educations,
            certifications,
            projects,
        };
    }

    private extractCertificationsFromMetadata(rawMeta: any) {
        const structuredCerts = rawMeta?.structured_data?.certifications;
        const topLevelCerts = rawMeta?.certifications;
        const rawCerts = [
            ...(Array.isArray(structuredCerts) ? structuredCerts : []),
            ...(Array.isArray(topLevelCerts) ? topLevelCerts : []),
        ];
        if (rawCerts.length === 0) {
            return [];
        }

        const formatDate = (value: Date | null) => (value ? value.toISOString().split('T')[0] : null);
        const deduped = new Map<
            string,
            { name: string; issuer: string | null; issue: Date | null; expiration: Date | null; isUploaded: boolean }
        >();

        rawCerts.forEach((cert: any) => {
            if (cert == null) return;
            if (typeof cert === 'string') {
                const name = cert.trim();
                if (!name) return;
                if (!deduped.has(name)) {
                    deduped.set(name, { name, issuer: null, issue: null, expiration: null, isUploaded: false });
                }
                return;
            }
            if (typeof cert !== 'object') return;

            const name = String(cert.name || cert.certification_name || '').trim();
            if (!name) return;

            const issuer =
                String(cert.issuer || cert.issuing_organization || cert.issuingOrganization || '').trim() ||
                null;
            const issueDate = normalizeFlexibleDate(
                cert.date_obtained || cert.issue_date || cert.issueDate,
                'start',
            );
            const expirationDate = normalizeFlexibleDate(
                cert.expiration_date || cert.expiry_date || cert.expirationDate || cert.expiration,
                'end',
            );
            const isUploaded = Boolean(cert.is_uploaded ?? cert.isUploaded);

            const existing = deduped.get(name);
            if (!existing) {
                deduped.set(name, { name, issuer, issue: issueDate, expiration: expirationDate, isUploaded });
                return;
            }
            if (!existing.issuer && issuer) existing.issuer = issuer;
            if (!existing.issue && issueDate) existing.issue = issueDate;
            if (!existing.expiration && expirationDate) existing.expiration = expirationDate;
            if (!existing.isUploaded && isUploaded) existing.isUploaded = true;
        });

        const now = new Date();
        const expiringSoonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        return Array.from(deduped.values()).map((cert, index) => {
            let status: CertificationStatus = CertificationStatus.ACTIVE;
            if (cert.expiration) {
                if (cert.expiration < now) {
                    status = CertificationStatus.EXPIRED;
                } else if (cert.expiration <= expiringSoonCutoff) {
                    status = CertificationStatus.EXPIRING_SOON;
                }
            }
            return {
                id: `meta-${index}`,
                name: cert.name,
                issuingOrganization: cert.issuer,
                issueDate: formatDate(cert.issue),
                expirationDate: formatDate(cert.expiration),
                status,
                isUploaded: cert.isUploaded,
            };
        });
    }

    /**
     * Rania's Logic: Physical file storage management
     * Consolidated: Saves file AND triggers parsing
     */
    async saveEmployeeCv(userId: string, file: Express.Multer.File) {
        let updatedUser = null;

        await this.fileValidationService.validate(file, 'cv');

        // 1. Parse CV FIRST to get the name
        try {
            const formData = new FormData();
            formData.append('user_id', userId);
            const blob = new Blob([file.buffer as any], { type: file.mimetype });
            formData.append('file', blob, file.originalname);

            const aiUrl = `${this.aiServiceBaseUrl}/api/v1/parsing/cv`;
            const aiResponse = await fetch(aiUrl, {
                method: 'POST',
                body: formData,
            });

            if (aiResponse.ok) {
                const parsingResult = await aiResponse.json();
                this.logger.log(`AI parsing successful for user ${userId}`);

                // 2. Update user names in DB BEFORE creating folder
                await this.updateUserNames(userId, parsingResult);

                // Fetch the updated user
                updatedUser = await this.userRepository.findOne({ where: { user_id: userId } });

                // 3. NOW save the file (folder will use updated name from DB)
                const storageResult = await this.fileStorageService.saveEmployeeFile(userId, file, 'CV');

                // 4. Save the full parsed data to metadata.json
                await this.fileStorageService.saveMetadata(userId, parsingResult);

                // 5. Process and store structured data in database
                const processingResult = await this.processCvData(userId, parsingResult);

                // 6. Keep metadata summary aligned with computed profile experience.
                await this.fileStorageService.updateExperienceYearsInMetadata(
                    userId,
                    processingResult.totalExperienceYears,
                );

                return {
                    ...storageResult,
                    user: updatedUser
                };
            } else {
                this.logger.error(`AI parsing failed (${aiResponse.status}) for ${aiUrl}: ${aiResponse.statusText}`);
                throw new Error('AI parsing failed');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cause =
                error && typeof error === 'object' && 'cause' in error
                    ? String((error as { cause?: unknown }).cause)
                    : undefined;
            this.logger.error(
                `Error during AI parsing orchestration (base URL: ${this.aiServiceBaseUrl}): ${message}${cause ? ` | cause: ${cause}` : ''}`
            );
            throw error;
        }
    }

    /**
     * Update user's firstName and lastName from parsed CV data
     */
    private async updateUserNames(userId: string, data: any) {
        const user = await this.userRepository.findOne({ where: { user_id: userId } });
        if (!user) {
            throw new NotFoundException(`User with ID ${userId} not found`);
        }

        let updated = false;
        if (data.structured_data?.first_name) {
            user.firstName = data.structured_data.first_name;
            updated = true;
        }
        if (data.structured_data?.last_name) {
            user.lastName = data.structured_data.last_name;
            updated = true;
        }

        if (updated) {
            await this.userRepository.save(user);
            this.logger.log(`Updated user ${userId} names: ${user.firstName} ${user.lastName}`);
        }
    }

    /**
     * Your Logic: Advanced CV data parsing into database
     */
    async processCvData(userId: string, data: any) {
        this.logger.log(`Processing CV data for user ${userId}`);

        // 1. Find User
        const user = await this.userRepository.findOne({ where: { user_id: userId } });
        if (!user) {
            throw new NotFoundException(`User with ID ${userId} not found`);
        }

        // 2. Find or Create Profile
        let profile = await this.profileRepository.findOne({
            where: { user: { user_id: userId } },
            relations: ['workExperiences', 'educations', 'certifications']
        });

        if (!profile) {
            this.logger.log(`Creating new profile for user ${userId}`);
            profile = this.profileRepository.create({
                user: user,
            });
            profile = await this.profileRepository.save(profile);
        }

        // 3. Save Metadata Snapshot
        await this.metadataRepository
            .createQueryBuilder()
            .update(MetadataSnapshot)
            .set({ isCurrent: false })
            .where('profile_id = :profileId', { profileId: profile.profile_id })
            .andWhere('is_current = true')
            .execute();

        const snapshot = this.metadataRepository.create({
            profile: profile,
            metadataJson: data,
            isCurrent: true,
        });
        await this.metadataRepository.save(snapshot);


        // 4. Populate Work Experience
        if (data.structured_data?.experience) {
            await this.experienceRepository.delete({ profile: { profile_id: profile.profile_id } });

            const experiences = data.structured_data.experience.map((exp: any) => {
                const newExp = new WorkExperience();
                const rawRange =
                    exp.date_range ||
                    exp.period ||
                    exp.date ||
                    exp.start_date ||
                    '';
                const parsedRange = parseFlexibleDateRange(rawRange);
                const explicitStart = normalizeFlexibleDate(exp.start_date, 'start');
                const explicitEnd = normalizeFlexibleDate(exp.end_date, 'end');

                newExp.profile = profile;
                newExp.jobTitle = exp.title || 'Unknown Role';
                newExp.companyName = exp.company || 'Unknown Company';
                newExp.startDate = parsedRange.startDate || explicitStart;
                newExp.endDate = explicitEnd || parsedRange.endDate;
                newExp.isCurrent = Boolean(exp.is_current) || parsedRange.isCurrent;
                newExp.description = exp.description || '';
                return newExp;
            });

            this.applyLatestNextStepAsCurrent(experiences);
            await this.experienceRepository.save(experiences);

            profile.totalExperienceYears = this.calculateTotalExperienceYears(experiences);
            await this.profileRepository.save(profile);
        }

        // 5. Populate Education
        if (data.structured_data?.education) {
            await this.educationRepository.delete({ profile: { profile_id: profile.profile_id } });

            const educations = data.structured_data.education.map((edu: any) => {
                const newEdu = new Education();
                const rawEducationDate = edu.end_date || edu.graduation_date || edu.date || '';
                const parsedEducationRange = parseFlexibleDateRange(rawEducationDate);
                newEdu.profile = profile;
                newEdu.degree = edu.degree || 'Unknown Degree';
                newEdu.institution = edu.institution || 'Unknown Institution';
                // For education ranges (e.g. 2011-2014), keep the largest date as graduation date.
                newEdu.endDate =
                    parsedEducationRange.endDate ||
                    normalizeFlexibleDate(rawEducationDate, 'end') ||
                    parsedEducationRange.startDate;
                return newEdu;
            });
            await this.educationRepository.save(educations);
        }

        // 6. Populate Certifications
        await this.certificationRepository
            .createQueryBuilder()
            .delete()
            .from(Certification)
            .where('profile_id = :profileId', { profileId: profile.profile_id })
            .andWhere('is_uploaded = false')
            .execute();

        const normalizeCertName = (value: string) =>
            (value || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-zA-Z0-9]+/g, ' ')
                .trim()
                .toLowerCase();

        const uploadedCerts = await this.certificationRepository.find({
            where: { profile: { profile_id: profile.profile_id }, isUploaded: true },
        });
        const uploadedNames = new Set(
            uploadedCerts.map((cert) => normalizeCertName(cert.certificationName || ''))
        );

        if (Array.isArray(data.structured_data?.certifications)) {
            const certifications = data.structured_data.certifications
                .map((cert: any) => {
                    const name = cert?.name || 'Unknown Certification';
                    if (uploadedNames.has(normalizeCertName(name))) {
                        return null;
                    }
                    const newCert = new Certification();
                    newCert.profile = profile;
                    newCert.certificationName = name;
                    newCert.issuingOrganization = cert.issuer || cert.issuing_organization || null;
                    newCert.issueDate = normalizeFlexibleDate(
                        cert.date_obtained || cert.issue_date || cert.issueDate,
                        'start',
                    );
                    newCert.expirationDate = normalizeFlexibleDate(
                        cert.expiration_date || cert.expiry_date || cert.expirationDate,
                        'end',
                    );
                    newCert.isUploaded = false;
                    return newCert;
                })
                .filter(Boolean) as Certification[];

            if (certifications.length > 0) {
                await this.certificationRepository.save(certifications);
            }
        }

        // 7. Populate Projects
        if (data.structured_data?.projects) {
            await this.participantRepository.delete({ profile: { profile_id: profile.profile_id } });

            const processedProjectIds = new Set<string>();

            for (const projectData of data.structured_data.projects) {
                const projectName = projectData.name || 'Unknown Project';
                const projectDesc = projectData.description || '';
                const clientName = projectData.client || null;

                let project = await this.projectRepository.findOne({
                    where: {
                        projectName: projectName,
                        projectDescription: projectDesc,
                        clientName: clientName
                    }
                });

                if (!project) {
                    project = this.projectRepository.create({
                        projectName: projectName,
                        projectDescription: projectDesc,
                        clientName: clientName
                    });
                }

                // Parse and store project dates
                const rawDate = projectData.date || projectData.dates || null;
                if (rawDate) {
                    const dateRange = parseFlexibleDateRange(rawDate);
                    if (dateRange.startDate) project.startDate = dateRange.startDate;
                    if (dateRange.endDate) project.endDate = dateRange.endDate;
                }

                project = await this.projectRepository.save(project);

                if (processedProjectIds.has(project.project_id)) {
                    continue;
                }

                // Do not block CV upload on AI title generation.
                // Title backfill runs asynchronously here (and also via cron).
                if (project.projectName?.toLowerCase() === 'unknown project' && !project.generatedTitle && projectDesc) {
                    void this.aiGenerationService
                        .generateAndStoreTitle(project)
                        .catch((err) => {
                            this.logger.warn(
                                `Failed to generate title for project ${project.project_id}: ${err?.message ?? err}`,
                            );
                        });
                }

                const participant = this.participantRepository.create({
                    profile: profile,
                    project: project,
                    description: projectDesc,
                });
                await this.participantRepository.save(participant);
                processedProjectIds.add(project.project_id);
            }
        }

        // 8. Trigger RAG Sync
        await this.ragService.triggerUserSync(userId);

        return {
            message: 'CV processed successfully',
            profileId: profile.profile_id,
            totalExperienceYears: profile.totalExperienceYears ?? null,
        };
    }

    private normalizeCompanyName(value: string): string {
        return (value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private isNextStepCompany(value: string): boolean {
        const normalized = this.normalizeCompanyName(value);
        const compact = normalized.replace(/\s+/g, '');
        return CvService.NEXT_STEP_COMPANY_KEYS.has(compact);
    }

    private applyLatestNextStepAsCurrent(experiences: WorkExperience[]) {
        if (!experiences?.length) {
            return;
        }

        const now = new Date();
        let latestIndex = -1;
        let latestTimestamp = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < experiences.length; i += 1) {
            const exp = experiences[i];
            const referenceDate =
                exp.endDate ||
                exp.startDate ||
                (exp.isCurrent ? now : null);
            if (!referenceDate) {
                continue;
            }
            const ts = referenceDate.getTime();
            if (ts > latestTimestamp) {
                latestTimestamp = ts;
                latestIndex = i;
            }
        }

        if (latestIndex < 0) {
            return;
        }

        const latestExp = experiences[latestIndex];
        if (this.isNextStepCompany(latestExp.companyName || '')) {
            latestExp.isCurrent = true;
            latestExp.endDate = null;
        }
    }

    /**
     * Backfill project dates from stored metadata.json files.
     * Matches projects via the user's project_participants, comparing by
     * normalized client name to handle encoding mismatches between metadata and DB.
     */
    async backfillProjectDates(): Promise<{ updated: number; skipped: number }> {
        const users = await this.userRepository.find();
        let updated = 0;
        let skipped = 0;

        for (const user of users) {
            try {
                const rawMeta = await this.fileStorageService.getRawMetadata(user.user_id);
                const metaProjects = rawMeta?.structured_data?.projects;
                if (!metaProjects?.length) continue;

                // Load this user's profile with project participations
                const profile = await this.profileRepository.findOne({
                    where: { user: { user_id: user.user_id } },
                    relations: ['projectParticipations', 'projectParticipations.project'],
                });
                if (!profile?.projectParticipations?.length) continue;

                // For each DB project, try to find a matching metadata entry by client name
                for (const participation of profile.projectParticipations) {
                    const project = participation.project;
                    if (!project || (project.startDate && project.endDate)) {
                        skipped++;
                        continue;
                    }

                    const dbClient = this.normalizeCompanyName(project.clientName || '');

                    // Find matching metadata project by normalized client name
                    const metaMatch = metaProjects.find((mp: any) => {
                        const metaClient = this.normalizeCompanyName(mp.client || '');
                        return metaClient && dbClient && metaClient === dbClient;
                    });

                    if (!metaMatch) {
                        skipped++;
                        continue;
                    }

                    const rawDate = metaMatch.date || metaMatch.dates || null;
                    if (!rawDate) {
                        skipped++;
                        continue;
                    }

                    const dateRange = parseFlexibleDateRange(rawDate);
                    if (dateRange.startDate || dateRange.endDate) {
                        if (dateRange.startDate) project.startDate = dateRange.startDate;
                        if (dateRange.endDate) project.endDate = dateRange.endDate;
                        await this.projectRepository.save(project);
                        updated++;
                        this.logger.log(`Backfilled dates for project "${project.projectName}" (client: ${project.clientName}): ${rawDate}`);
                    } else {
                        skipped++;
                    }
                }
            } catch (err) {
                this.logger.warn(`Backfill error for user ${user.user_id}: ${err?.message ?? err}`);
            }
        }

        this.logger.log(`Backfill complete: ${updated} updated, ${skipped} skipped`);
        return { updated, skipped };
    }

    private calculateTotalExperienceYears(experiences: WorkExperience[]): number | null {
        if (!experiences?.length) {
            return null;
        }

        const now = new Date();
        const intervals: Array<{ start: number; end: number }> = [];

        for (const exp of experiences) {
            if (!exp.startDate) {
                continue;
            }

            let start = new Date(exp.startDate.getTime());
            let end = exp.endDate ? new Date(exp.endDate.getTime()) : null;
            if (exp.isCurrent) {
                end = now;
            } else if (!end) {
                // If parser did not provide an end date and role is not marked current,
                // avoid inflating totals by treating it as a point-in-time entry.
                end = new Date(start.getTime());
            }

            if (end.getTime() < start.getTime()) {
                const tmp = start;
                start = end;
                end = tmp;
            }

            intervals.push({ start: start.getTime(), end: end.getTime() });
        }

        if (!intervals.length) {
            return null;
        }

        intervals.sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const interval of intervals) {
            const last = merged[merged.length - 1];
            if (!last || interval.start > last.end) {
                merged.push({ ...interval });
                continue;
            }
            last.end = Math.max(last.end, interval.end);
        }

        const totalMs = merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
        const years = Math.floor(totalMs / (1000 * 60 * 60 * 24 * 365.25));
        return Math.max(0, years);
    }

    /**
     * Generate a CV from a template file and employee profile data.
     * Sends the template + employee data to the AI service which replaces
     * personal fields while preserving the original template formatting.
     */
    async generateCv(
        employeeId: string,
        templateFile: Express.Multer.File,
        outputFormat: 'docx' | 'pdf' = 'docx',
        language: string = 'en',
        engine: 'primary' | 'fallback' = 'primary',
    ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
        // 1. Load employee profile data
        const profileData = await this.getMyProfile(employeeId);

        if (!profileData.name || profileData.name.trim().length < 2) {
            throw new NotFoundException(
                `Employee ${employeeId} has no usable name in their profile. ` +
                'Please ensure the employee has a first and last name set.',
            );
        }

        // 2. Call AI service /generation/cv
        const formData = new FormData();
        const blob = new Blob([templateFile.buffer as any], { type: templateFile.mimetype });
        formData.append('template', blob, templateFile.originalname);
        // Keep this payload raw (islam-branch behavior): the AI service is the source of truth
        // for normalization/mapping in primary engine.
        formData.append('employee_data', JSON.stringify(profileData));
        formData.append('output_format', outputFormat);
        formData.append('language', language);
        formData.append('engine', engine);

        const aiUrl = `${this.aiServiceBaseUrl}/api/v1/generation/cv`;
        this.logger.log(`Calling AI generation service: ${aiUrl} (format: ${outputFormat})`);

        // 180s timeout: complex templates with Groq calls can take up to ~30s,
        // but LibreOffice PDF conversion can take longer on cold start.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180_000);

        let aiResponse: globalThis.Response;
        try {
            aiResponse = await fetch(aiUrl, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error('CV generation timed out (180s). The template may be too complex.');
            }
            throw new Error(`AI service unreachable: ${err.message}`);
        } finally {
            clearTimeout(timeout);
        }

        if (!aiResponse.ok) {
            const errorText = await aiResponse.text().catch(() => 'Unknown error');
            this.logger.error(`AI generation failed (${aiResponse.status}): ${errorText}`);
            if (aiResponse.status === 400) {
                throw new Error(`Invalid input: ${errorText}`);
            }
            throw new Error(`CV generation failed: ${errorText}`);
        }

        const arrayBuffer = await aiResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Derive filename from Content-Disposition or build one
        const contentDisposition = aiResponse.headers.get('content-disposition') || '';
        const ext = outputFormat === 'pdf' ? '.pdf' : '.docx';
        let filename = `${profileData.name.replace(/\s+/g, '_')}_CV${ext}`;
        const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
        if (filenameMatch) {
            filename = filenameMatch[1];
        }

        const mimeType =
            outputFormat === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        return { buffer, filename, mimeType };
    }

    /**
     * Generate a CV using the employee's own uploaded CV as the template.
     * Finds the stored CV file and uses it as the template.
     */
    async generateCvFromStoredTemplate(
        employeeId: string,
        targetEmployeeId: string,
        outputFormat: 'docx' | 'pdf' = 'docx',
        language: string = 'en',
    ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
        // Find the template employee's stored CV
        const baseDir = await this.fileStorageService.findBaseDirByOwner(employeeId);
        if (!baseDir) {
            throw new NotFoundException(`No stored CV found for employee ${employeeId}`);
        }

        // Look for CV file - only .docx is supported for reliable processing
        const possibleFiles = ['CV.docx'];
        let cvFilePath: string | null = null;
        for (const fname of possibleFiles) {
            const fullPath = require('path').join(baseDir, fname);
            if (require('fs').existsSync(fullPath)) {
                cvFilePath = fullPath;
                break;
            }
        }

        if (!cvFilePath) {
            throw new NotFoundException(`No DOCX CV file found for employee ${employeeId}`);
        }

        // Read the file into a buffer and create a mock Multer file
        const fileBuffer = await require('fs/promises').readFile(cvFilePath);

        const mockFile: Express.Multer.File = {
            fieldname: 'template',
            originalname: require('path').basename(cvFilePath),
            encoding: '7bit',
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer: fileBuffer,
            size: fileBuffer.length,
            stream: null as any,
            destination: '',
            filename: '',
            path: '',
        };

        return this.generateCv(targetEmployeeId, mockFile, outputFormat, language);
    }
}
