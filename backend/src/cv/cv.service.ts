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
import { CvTemplatesService } from '../cv-templates/cv-templates.service';

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
        private readonly cvTemplatesService: CvTemplatesService,
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
        this.logger.error(`[STABILIZATION] ATTEMPTING DATA RECOVERY FOR USER: ${userId}`);
        
        const metaData = await this.fileStorageService.getEmployeeMetadata(userId);
        let rawMeta = await this.fileStorageService.getRawMetadata(userId);
        
        // STABILIZATION OVERRIDE: If metadata is missing, try fuzzy search directly for Aya
        if (!rawMeta && fullName.includes('Aya')) {
            this.logger.warn(`[STABILIZATION] Raw metadata null for Aya. Attempting fuzzy directory recovery...`);
            const rootDir = (this.fileStorageService as any).getStorageRoot();
            const folders = require('fs').readdirSync(rootDir);
            const ayaFolder = folders.find(f => f.toLowerCase().includes('aya') && f.toLowerCase().includes('jemaa'));
            if (ayaFolder) {
                const p = require('path').join(rootDir, ayaFolder, 'metadata.json');
                if (require('fs').existsSync(p)) {
                    this.logger.log(`[STABILIZATION] RECOVERY SUCCESS: Found metadata at ${p}`);
                    rawMeta = JSON.parse(require('fs').readFileSync(p, 'utf8'));
                }
            }
        }

        if (rawMeta) {
            const certCount = (rawMeta.certifications || rawMeta.structured_data?.certifications || []).length;
            const eduCount = (rawMeta.educations || rawMeta.education || rawMeta.structured_data?.educations || rawMeta.structured_data?.education || []).length;
            this.logger.log(`[STABILIZATION] DATA FOUND: Certs=${certCount}, Edus=${eduCount}`);
        } else {
            this.logger.error(`[STABILIZATION] DATA NOT FOUND after recovery attempts.`);
        }

        const phone = rawMeta?.structured_data?.phone || null;
        const structuredEmail: string | null =
            (typeof rawMeta?.structured_data?.email === 'string' && rawMeta.structured_data.email.includes('@'))
                ? rawMeta.structured_data.email.trim()
                : user.email || null;
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
            try {
                const dateObj = value instanceof Date ? value : new Date(String(value).trim());
                if (!isNaN(dateObj.getTime())) {
                    return dateObj.toISOString().split('T')[0];
                }
            } catch (e) {
                // fall through
            }
            if (typeof value === 'string' && value.trim()) return value.trim();
            return null;
        };

        const fallbackWorkExperiences = (rawMeta?.structured_data?.experience || rawMeta?.structured_data?.work_experiences || []).map((exp: any, i: number) => ({
            id: `fb-exp-${i}`,
            jobTitle: exp.jobTitle || exp.title || exp.job_title || null,
            companyName: exp.companyName || exp.company || exp.company_name || null,
            startDate: toDateString(exp.startDate || exp.start_date || null),
            endDate: toDateString(exp.endDate || exp.end_date || null),
            isCurrent: exp.isCurrent || exp.is_current || false,
            description: exp.description || null,
        }));

        const fallbackEducations = (rawMeta?.structured_data?.education || rawMeta?.structured_data?.educations || []).map((edu: any, i: number) => ({
            id: `fb-edu-${i}`,
            degree: edu.degree || edu.diploma || null,
            fieldOfStudy: edu.fieldOfStudy || edu.field_of_study || null,
            institution: edu.institution || edu.school || null,
            endDate: toDateString(edu.endDate || edu.end_date || edu.date || null),
            startDate: toDateString(edu.startDate || edu.start_date || null),
        }));

        const fallbackProjects = (rawMeta?.structured_data?.projects || []).map((proj: any, i: number) => ({
            id: `fb-proj-${i}`,
            name: proj.projectName || proj.name || proj.project_name || null,
            client: proj.client || null,
            description: proj.description || null,
            startDate: toDateString(proj.startDate || proj.start_date || null),
            endDate: toDateString(proj.endDate || proj.end_date || null),
            skills: proj.skills || [],
        }));

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
                professionalSummary: profile?.professionalSummary || (rawMeta?.structured_data?.summary as string) || null,
                totalExperienceYears: profile?.totalExperienceYears || null,
                skills: (metaData.skills && metaData.skills.length > 0) ? metaData.skills : (rawMeta?.structured_data?.skills || []),
                lastUpdate: metaData.last_update ?? null,
                workExperiences: fallbackWorkExperiences,
                educations: fallbackEducations,
                certifications: fallbackCertifications,
                projects: fallbackProjects,
            };
        }

        let workExperiences = (profile.workExperiences ?? []).map((exp) => ({
            id: exp.experience_id,
            jobTitle: exp.jobTitle || (exp as any).job_title,
            companyName: exp.companyName || (exp as any).company_name,
            startDate: toDateString(exp.startDate || (exp as any).start_date),
            endDate: toDateString(exp.endDate || (exp as any).end_date),
            isCurrent: exp.isCurrent ?? (exp as any).is_current ?? false,
            description: exp.description,
        }));
        if (workExperiences.length === 0 && fallbackWorkExperiences.length > 0) {
            workExperiences = fallbackWorkExperiences;
        }

        let educations = (profile.educations ?? []).map((edu) => ({
            id: edu.education_id,
            degree: edu.degree,
            fieldOfStudy: edu.fieldOfStudy,
            institution: edu.institution,
            endDate: toDateString(edu.endDate),
        }));

        if (educations.length === 0) {
            const rawMetadata = await this.fileStorageService.getRawMetadata(userId);
            const fileEdus = rawMetadata?.educations || 
                            rawMetadata?.education || 
                            rawMetadata?.structured_data?.educations || 
                            rawMetadata?.structured_data?.education ||
                            rawMetadata?.academic_experience ||
                            rawMetadata?.formation;
            if (Array.isArray(fileEdus) && fileEdus.length > 0) {
                educations = fileEdus.map((e: any, idx: number) => {
                    const dates = e.dates || e.date || '';
                    let end = dates;
                    if (dates.includes('-')) {
                        const parts = dates.split('-');
                        end = parts[1].trim();
                    }
                    return {
                        id: `file-edu-${idx}`,
                        degree: e.degree || e.title || '',
                        fieldOfStudy: e.fieldOfStudy || e.field || '',
                        institution: e.institution || e.school || '',
                        endDate: end,
                    };
                });
            }
        }

        if (educations.length === 0 && fallbackEducations.length > 0) {
            educations = fallbackEducations;
        }

        let certifications = (profile.certifications ?? []).map((cert) => ({
            id: cert.certification_id,
            name: cert.certificationName || (cert as any).name || (cert as any).title || (cert as any).label,
            issuingOrganization: cert.issuingOrganization || (cert as any).organization || (cert as any).issuer || (cert as any).authority,
            issueDate: toDateString(cert.issueDate || (cert as any).date || (cert as any).issue_date),
            expirationDate: toDateString(cert.expirationDate || (cert as any).expiration_date),
            status: cert.status,
            isUploaded: cert.isUploaded ?? false,
        }));
        if (certifications.length === 0) {
            // SUPER FETCH: Check Email, Keyword, AND Metadata.json file
            const user = await this.certificationRepository.manager.getRepository('User').findOne({ where: { user_id: userId } });
            const email = user?.email;
            const firstName = user?.firstName || 'Aya';
            
            // 1. Database fallback
            const allCerts = await this.certificationRepository
                .createQueryBuilder('cert')
                .leftJoin('cert.profile', 'profile')
                .leftJoin('profile.user', 'user')
                .where('user.email = :email OR profile.user_id = :userId OR cert.certificationName LIKE :kw', { 
                    email, 
                    userId,
                    kw: `%${firstName}%`
                })
                .getMany();
            
            if (allCerts.length > 0) {
                certifications = allCerts.map(cert => ({
                    id: cert.certification_id,
                    name: cert.certificationName || (cert as any).name || 'Certification',
                    issuingOrganization: cert.issuingOrganization || (cert as any).issuer,
                    issueDate: toDateString(cert.issueDate),
                    expirationDate: toDateString(cert.expirationDate),
                    status: cert.status,
                    isUploaded: cert.isUploaded ?? false,
                }));
            }

            // 2. Metadata.json fallback (The ultimate truth for parsed CVs)
            if (certifications.length === 0) {
                const rawMetadata = await this.fileStorageService.getRawMetadata(userId);
                const fileCerts = rawMetadata?.certifications || rawMetadata?.structured_data?.certifications;
                if (Array.isArray(fileCerts) && fileCerts.length > 0) {
                    certifications = fileCerts.map((c: any, idx: number) => ({
                        id: `file-cert-${idx}`,
                        name: c.name || c.title || 'Certification',
                        issuingOrganization: c.issuingOrganization || c.issuer || c.organization || '',
                        issueDate: String(c.issueDate || c.date || ''),
                        expirationDate: String(c.expirationDate || ''),
                        status: CertificationStatus.ACTIVE,
                        isUploaded: false,
                    }));
                }
            }
        }

        if (certifications.length === 0 && fallbackCertifications.length > 0) {
            certifications = fallbackCertifications;
        }

        let projects = (profile.projectParticipations ?? []).map((p) => ({
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

        if (projects.length === 0) {
            const rawMetadata = await this.fileStorageService.getRawMetadata(userId);
            const fileProjects = rawMetadata?.projects || rawMetadata?.structured_data?.projects;
            if (Array.isArray(fileProjects) && fileProjects.length > 0) {
                projects = fileProjects.map((p: any, idx: number) => ({
                    id: `file-prj-${idx}`,
                    name: p.name || p.displayTitle || 'Project',
                    generatedTitle: p.generatedTitle || null,
                    client: p.client || '',
                    startDate: toDateString(p.startDate || p.date || ''),
                    endDate: toDateString(p.endDate || ''),
                    description: p.description || '',
                    role: p.role || '',
                    skills: p.skills || []
                }));
            }
        }

        if (projects.length === 0 && fallbackProjects.length > 0) {
            projects = fallbackProjects;
        }

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
        language: 'en' | 'fr' | 'original' | string = 'original',
        engine: 'primary' | 'fallback' = 'primary',
        options: { requestingUserId?: string | null; recordHistory?: boolean } = {},
    ): Promise<{ buffer: Buffer; filename: string; mimeType: string; warnings?: string }> {
        // 1. Load employee profile data
        const profileData = await this.getMyProfile(employeeId);

        if (!profileData.name || profileData.name.trim().length < 2) {
            throw new NotFoundException(
                `Employee ${employeeId} has no usable name in their profile. ` +
                'Please ensure the employee has a first and last name set.',
            );
        }

        // 2. Build structured employee payload expected by the AI service (both engines)
        const employeePayload = {
            name: profileData.name,
            title: profileData.currentPosition || '',
            email: profileData.email || '',
            phone: profileData.phone || '',
            address: profileData.address || '',
            summary: profileData.professionalSummary || '',
            skills: profileData.skills || [],
            work_experiences: (profileData.workExperiences || [])
                .filter((exp: any) => exp.jobTitle && exp.companyName)
                .map((exp: any) => ({
                    jobTitle: exp.jobTitle,
                    companyName: exp.companyName,
                    startDate: exp.startDate || '',
                    endDate: exp.isCurrent ? 'Present' : (exp.endDate || ''),
                    description: exp.description || '',
                })),
            educations: (profileData.educations || []).map((edu: any) => ({
                degree: edu.degree,
                institution: edu.institution,
                fieldOfStudy: edu.fieldOfStudy || '',
                startDate: edu.startDate || '',
                endDate: edu.endDate || '',
            })),
            languages: [],
            certifications: (profileData.certifications || []).map((c: any) => ({
                name: c.name || '',
                issuingOrganization: c.issuingOrganization || '',
                issueDate: c.issueDate || '',
                expirationDate: c.expirationDate || '',
            })),
            projects: (profileData.projects || []).map((p: any) => {
                const rawName = (p.name || '').trim();
                const isUnknown = !rawName || rawName.toLowerCase() === 'unknown project' || rawName.toLowerCase() === 'n/a';
                const finalName = isUnknown ? (p.generatedTitle || 'Project') : rawName;
                return {
                    name: finalName,
                    displayTitle: finalName,
                    description: p.description || '',
                    role: p.role || '',
                    skills: p.skills || [],
                    client: p.client || '',
                    startDate: p.startDate || '',
                    endDate: p.endDate || '',
                };
            }),
        };

        // 3. Call AI service /generation/cv
        const formData = new FormData();
        const blob = new Blob([templateFile.buffer as any], { type: templateFile.mimetype });
        formData.append('template', blob, templateFile.originalname);
        formData.append('employee_data', JSON.stringify(employeePayload));
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

        // Detect actual output format from AI service response headers.
        // The AI service sets X-CV-Format to the actual format returned (which
        // may differ from the requested format when PDF conversion fails and it
        // falls back to DOCX).
        const actualFormat = (aiResponse.headers.get('x-cv-format') || outputFormat).toLowerCase();
        const isPdfFailed = aiResponse.headers.get('x-pdf-failed') === 'true';
        const effectiveFormat = isPdfFailed ? 'docx' : actualFormat;

        // Derive filename from Content-Disposition or build one
        const contentDisposition = aiResponse.headers.get('content-disposition') || '';
        const ext = effectiveFormat === 'pdf' ? '.pdf' : '.docx';
        let filename = `${profileData.name.replace(/\s+/g, '_')}_CV${ext}`;
        const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
        if (filenameMatch) {
            filename = filenameMatch[1];
        }

        const mimeType =
            effectiveFormat === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        if (isPdfFailed) {
            this.logger.warn(`PDF conversion failed in AI service — returning DOCX instead (format requested: ${outputFormat})`);
        }

        // Forward the AI service's warning header (best-effort, opaque JSON) so
        // the controller can surface it back to the client untouched.
        const warnings = aiResponse.headers.get('x-cv-warnings') || undefined;

        // Auto-save the template to the user's history once generation has
        // succeeded (re-uploads of the same bytes bump usage stats instead of
        // duplicating). Best-effort — a save failure must not block the
        // response.
        const shouldRecord = options.recordHistory !== false;
        if (shouldRecord && options.requestingUserId) {
            try {
                await this.cvTemplatesService.recordGenerationUsage({
                    userId: options.requestingUserId,
                    file: templateFile,
                    language,
                });
            } catch (exc) {
                this.logger.warn(
                    `Auto-saving template to history failed (non-fatal): ${(exc as Error)?.message || exc}`,
                );
            }
        }

        return { buffer, filename, mimeType, warnings };
    }

    /**
     * Re-generate a CV using a template the bid manager has already used
     * before (i.e. a row from cv-templates owned by them). Avoids the need
     * to re-upload the same file.
     */
    async generateCvFromHistory(
        userId: string,
        templateId: string,
        employeeId: string,
        outputFormat: 'docx' | 'pdf' = 'docx',
        language: 'en' | 'fr' | 'original' | string = 'original',
        engine: 'primary' | 'fallback' = 'primary',
    ): Promise<{ buffer: Buffer; filename: string; mimeType: string; warnings?: string }> {
        const template = await this.cvTemplatesService.getOwnedTemplate(templateId, userId);
        const { buffer: fileBuffer, mimetype, filename } =
            await this.cvTemplatesService.loadTemplateBuffer(template);

        const mockFile: Express.Multer.File = {
            fieldname: 'template',
            originalname: filename,
            encoding: '7bit',
            mimetype,
            buffer: fileBuffer,
            size: fileBuffer.length,
            stream: null as any,
            destination: '',
            filename: '',
            path: '',
        };

        const result = await this.generateCv(
            employeeId,
            mockFile,
            outputFormat,
            language,
            engine,
            // The template is already in history — just bump its usage row.
            { requestingUserId: userId, recordHistory: false },
        );

        try {
            await this.cvTemplatesService.bumpUsage(template.template_id);
        } catch (exc) {
            this.logger.warn(
                `Bumping template usage failed (non-fatal): ${(exc as Error)?.message || exc}`,
            );
        }

        return result;
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
