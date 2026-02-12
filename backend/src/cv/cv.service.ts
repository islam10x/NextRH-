import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetadataSnapshot } from './entities/metadata-snapshot.entity';
import { User } from '../users/entities/user.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { WorkExperience } from '../employees/entities/work-experience.entity';
import { Education } from '../employees/entities/education.entity';
import { Certification } from '../certifications/entities/certification.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectParticipant } from '../projects/entities/participant.entity';

@Injectable()
export class CvService {
    private readonly logger = new Logger(CvService.name);

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
        private participantRepository: Repository<ProjectParticipant>
    ) { }

    async processCvData(userId: string, data: any) {
        this.logger.log(`Processing CV data for user ${userId}`);

        // 1. Find User
        const user = await this.userRepository.findOne({ where: { user_id: userId } });
        if (!user) {
            throw new NotFoundException(`User with ID ${userId} not found`);
        }

        // 1.1 Update User Details (First Name, Last Name) if available
        if (data.structured_data?.first_name || data.structured_data?.last_name) {
            let updated = false;
            if (data.structured_data.first_name) {
                user.firstName = data.structured_data.first_name;
                updated = true;
            }
            if (data.structured_data.last_name) {
                user.lastName = data.structured_data.last_name;
                updated = true;
            }
            if (updated) {
                await this.userRepository.save(user);
                this.logger.log(`Updated user ${userId} details: ${user.firstName} ${user.lastName}`);
            }
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
            // Clear existing for this demo/MVP or append? 
            // Better to clear and re-populate if it's a "parse new CV" action
            // But realistically we should merge. For now let's just add new ones.
            // Or delete all linked to this profile and re-add?
            await this.experienceRepository.delete({ profile: { profile_id: profile.profile_id } });

            const experiences = data.structured_data.experience.map((exp: any) => {
                const newExp = new WorkExperience();
                newExp.profile = profile;
                newExp.jobTitle = exp.title || 'Unknown Role';
                newExp.companyName = exp.company || 'Unknown Company';
                newExp.description = exp.description || '';
                // Date parsing logic might be needed if dates are strings like "Jan 2020"
                // For MVP we might skip date parsing or do it in AI service
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
                // Date parsing needed
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
                // Date parsing needed
                return newCert;
            });
            await this.certificationRepository.save(certifications);
        }
        // 7. Populate Projects
        if (data.structured_data?.projects) {
            // Delete existing participation links for this profile
            await this.participantRepository.delete({ profile: { profile_id: profile.profile_id } });

            const processedProjectIds = new Set<string>();

            for (const projectData of data.structured_data.projects) {
                this.logger.debug(`Processing project: ${JSON.stringify(projectData)}`);

                // Fallback: use client as project name if name is missing
                const projectName = projectData.name || 'Unknown Project';
                const projectDesc = projectData.description || '';
                const clientName = projectData.client || null;
                const projectYear = projectData.date || null;

                // Find or create project by name, description, client, and year
                let project = await this.projectRepository.findOne({
                    where: {
                        projectName: projectName,
                        projectDescription: projectDesc,
                        clientName: clientName,
                        projectYear: projectYear
                    }
                });

                if (!project) {
                    project = this.projectRepository.create({
                        projectName: projectName,
                        projectDescription: projectDesc,
                        clientName: clientName,
                        projectYear: projectYear
                    });
                    project = await this.projectRepository.save(project);
                    this.logger.log(`Created new project: ${projectName} for client: ${clientName} (${projectYear})`);
                }

                // Deduplicate participation
                if (processedProjectIds.has(project.project_id)) {
                    continue;
                }

                // Create participation entry linking profile to project
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
