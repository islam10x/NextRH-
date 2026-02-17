import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MetadataSnapshot } from './entities/metadata-snapshot.entity';
import { User } from '../users/entities/user.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { WorkExperience } from '../employees/entities/work-experience.entity';
import { Education } from '../employees/entities/education.entity';
import { Certification } from '../certifications/entities/certification.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectParticipant } from '../projects/entities/participant.entity';
import { FileStorageService } from '../file-storage/file-storage.service';

@Injectable()
export class CvService {
    private readonly logger = new Logger(CvService.name);
    private readonly aiServiceBaseUrl: string;

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
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    /**
     * Rania's Logic: Physical file storage management
     * Consolidated: Saves file AND triggers parsing
     */
    async saveEmployeeCv(userId: string, file: Express.Multer.File) {
        let updatedUser = null;

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
                // Prefer folder name derived from parsed CV data when available.
                const parsedFirst = parsingResult?.structured_data?.first_name || '';
                const parsedLast = parsingResult?.structured_data?.last_name || '';
                const parsedFullName = [parsedFirst, parsedLast].filter(Boolean).join(' ').trim() || undefined;

                const storageResult = await this.fileStorageService.saveEmployeeFile(
                    userId,
                    file,
                    'CV',
                    parsedFullName,
                );

                // 4. Save the full parsed data to metadata.json
                await this.fileStorageService.saveMetadata(userId, parsingResult);

                // 5. Process and store structured data in database
                await this.processCvData(userId, parsingResult);

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
                newExp.profile = profile;
                newExp.jobTitle = exp.title || 'Unknown Role';
                newExp.companyName = exp.company || 'Unknown Company';
                newExp.description = exp.description || '';
                return newExp;
            });
            await this.experienceRepository.save(experiences);
        }

        // 5. Populate Education
        if (data.structured_data?.education) {
            await this.educationRepository.delete({ profile: { profile_id: profile.profile_id } });

            const educations = data.structured_data.education.map((edu: any) => {
                const newEdu = new Education();
                newEdu.profile = profile;
                newEdu.degree = edu.degree || 'Unknown Degree';
                newEdu.institution = edu.institution || 'Unknown Institution';
                return newEdu;
            });
            await this.educationRepository.save(educations);
        }

        // 6. Populate Certifications
        if (data.structured_data?.certifications) {
            await this.certificationRepository.delete({ profile: { profile_id: profile.profile_id } });

            const certifications = data.structured_data.certifications.map((cert: any) => {
                const newCert = new Certification();
                newCert.profile = profile;
                newCert.certificationName = cert.name || 'Unknown Certification';
                return newCert;
            });
            await this.certificationRepository.save(certifications);
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
                    project = await this.projectRepository.save(project);
                    this.logger.log(`Created new project: ${projectName} for client: ${clientName}`);
                }

                if (processedProjectIds.has(project.project_id)) {
                    continue;
                }

                const participant = this.participantRepository.create({
                    profile: profile,
                    project: project,
                    description: projectDesc,
                    role: projectData.role || 'Contributor'
                });
                await this.participantRepository.save(participant);
                processedProjectIds.add(project.project_id);
            }
        }

        return { message: 'CV processed successfully', profileId: profile.profile_id };
    }
}
