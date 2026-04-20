import { BadRequestException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Project } from './entities/project.entity';
import { ProjectParticipant, ParticipantRole } from './entities/participant.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { Skill } from '../skills/entities/skill.entity';
import { AssignProjectDto } from './dto/assign-project.dto';
import { UpdateParticipationDto } from './dto/update-participation.dto';
import { TeamsService } from '../teams/teams.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { ScoringService } from '../scoring/scoring.service';

@Injectable()
export class ProjectsService {
    constructor(
        @InjectRepository(Project)
        private readonly projectRepo: Repository<Project>,
        @InjectRepository(ProjectParticipant)
        private readonly participantRepo: Repository<ProjectParticipant>,
        @InjectRepository(EmployeeProfile)
        private readonly profileRepo: Repository<EmployeeProfile>,
        @InjectRepository(Skill)
        private readonly skillRepo: Repository<Skill>,
        @InjectRepository(User)
        private readonly usersRepo: Repository<User>,
        private readonly teamsService: TeamsService,
        private readonly notificationsService: NotificationsService,
        @Inject(forwardRef(() => ScoringService))
        private readonly scoringService: ScoringService,
    ) {
        this.logger = new Logger(ProjectsService.name);
    }

    private logger: Logger;

    async assignProject(dto: AssignProjectDto, managerUserId: string) {
        if (!dto.assigneeProfileIds?.length) {
            throw new BadRequestException('At least one assignee is required.');
        }

        const teamMembers = await this.teamsService.getMembersForManager(managerUserId);
        const allowedProfiles = new Set(teamMembers.map((m) => m.profileId).filter(Boolean));
        const invalidProfile = dto.assigneeProfileIds.find((id) => !allowedProfiles.has(id));
        if (invalidProfile) {
            throw new BadRequestException('One or more assignees are not in your team.');
        }

        const profiles = await this.profileRepo.find({
            where: { profile_id: In(dto.assigneeProfileIds) },
            relations: ['user'],
        });
        if (profiles.length !== dto.assigneeProfileIds.length) {
            throw new NotFoundException('One or more assignee profiles not found.');
        }

        const startDate = dto.startDate ? this.toDate(dto.startDate) : null;
        const endDate = dto.endDate ? this.toDate(dto.endDate) : null;

        const manager = await this.usersRepo.findOne({ where: { user_id: managerUserId } });
        const managerName = manager
            ? [manager.firstName, manager.lastName].filter(Boolean).join(' ')
            : null;

        let project = await this.projectRepo.findOne({
            where: {
                projectName: dto.projectName,
                clientName: dto.clientName || null,
                startDate: startDate ?? null,
                endDate: endDate ?? null,
            },
            relations: ['skills'],
        });

        if (!project) {
            project = this.projectRepo.create({
                projectName: dto.projectName,
                clientName: dto.clientName || null,
                projectDescription: dto.projectDescription || null,
                startDate,
                endDate,
                complexity: dto.complexity || 'medium',
            });
        } else if (!project.projectDescription && dto.projectDescription) {
            project.projectDescription = dto.projectDescription;
            if (dto.complexity) project.complexity = dto.complexity;
        }

        if (dto.technologies?.length) {
            const techNames = dto.technologies
                .map((t) => String(t || '').trim())
                .filter(Boolean);
            if (techNames.length) {
                const existing = await this.skillRepo.find({
                    where: { skillName: In(techNames) },
                });
                const existingNames = new Set(existing.map((s) => s.skillName.toLowerCase()));
                const newSkills = techNames
                    .filter((name) => !existingNames.has(name.toLowerCase()))
                    .map((name) => this.skillRepo.create({ skillName: name }));
                const savedNew = newSkills.length ? await this.skillRepo.save(newSkills) : [];
                project.skills = [...existing, ...savedNew];
            }
        }

        project = await this.projectRepo.save(project);

        const created: ProjectParticipant[] = [];
        for (const profile of profiles) {
            let participant = await this.participantRepo.findOne({
                where: {
                    project: { project_id: project.project_id },
                    profile: { profile_id: profile.profile_id },
                },
                relations: ['project', 'profile'],
            });
            if (!participant) {
                participant = this.participantRepo.create({
                    project,
                    profile,
                    role: (dto.roles?.[profile.profile_id] || dto.role || 'contributor') as ParticipantRole,
                    description: '',
                    assignedBy: managerUserId,
                });
            } else {
                const newRole = dto.roles?.[profile.profile_id] || dto.role;
                if (newRole && !participant.role) {
                    participant.role = newRole as ParticipantRole;
                }
                participant.assignedBy = managerUserId;
            }
            created.push(await this.participantRepo.save(participant));
        }

        const projectLabel = project.projectName;
        const clientLabel = project.clientName ? ` · ${project.clientName}` : '';
        await Promise.all(
            profiles.map((profile) => {
                const userId = profile.user?.user_id;
                if (!userId) return Promise.resolve();
                return this.notificationsService.create({
                    userId,
                    type: 'project_assigned',
                    title: 'New project assigned',
                    message: `${projectLabel}${clientLabel}${managerName ? ` - Assigned by ${managerName}` : ''}`,
                    relatedEntityType: 'project',
                    relatedEntityId: project.project_id,
                });
            }),
        );

        // Auto-recompute scoring for all assigned employees
        const currentYear = new Date().getFullYear();
        for (const profile of profiles) {
            try {
                await this.scoringService.computeScore(profile.profile_id, currentYear);
                this.logger.log(`Auto-recomputed score for profile ${profile.profile_id} after project assignment`);
            } catch (err: any) {
                this.logger.warn(`Failed to auto-recompute score after project assignment for ${profile.profile_id}: ${err.message}`);
            }
        }

        return created;
    }

    async listForUser(userId: string) {
        const profile = await this.profileRepo.findOne({
            where: { user: { user_id: userId } },
        });
        if (!profile) {
            throw new NotFoundException('Profile not found for user');
        }

        const participants = await this.participantRepo.find({
            where: {
                profile: { profile_id: profile.profile_id },
                assignedBy: Not(IsNull()),
            },
            relations: ['project', 'project.skills'],
            order: { participant_id: 'DESC' },
        });

        const managerIds = Array.from(
            new Set(participants.map((p) => p.assignedBy).filter(Boolean) as string[])
        );
        const managers = managerIds.length
            ? await this.usersRepo.find({ where: { user_id: In(managerIds) } })
            : [];
        const managerNameById = new Map(
            managers.map((mgr) => [
                mgr.user_id,
                [mgr.firstName, mgr.lastName].filter(Boolean).join(' ') || mgr.email,
            ]),
        );

        return participants.map((p) => ({
            id: p.participant_id,
            employeeId: userId,
            name: p.project?.projectName ?? '',
            client: p.project?.clientName ?? '',
            startDate: this.toDateString(p.project?.startDate),
            endDate: this.toDateString(p.project?.endDate),
            technologies: (p.project?.skills ?? []).map((s) => s.skillName),
            description: p.description || p.project?.projectDescription || '',
            role: p.role || 'Contributor',
            assignedByName: p.assignedBy ? managerNameById.get(p.assignedBy) || '' : '',
        }));
    }

    async listForManager(managerUserId: string) {
        let teamMembers: Array<{ profileId?: string; userId: string; firstName?: string; lastName?: string; email: string }> = [];
        try {
            teamMembers = await this.teamsService.getMembersForManager(managerUserId);
        } catch (error) {
            if (error instanceof NotFoundException) {
                return [];
            }
            throw error;
        }
        const profileIds = teamMembers.map((m) => m.profileId).filter(Boolean) as string[];
        if (!profileIds.length) {
            return [];
        }

        const memberByProfile = new Map(
            teamMembers
                .filter((m) => m.profileId)
                .map((m) => [
                    m.profileId,
                    {
                        userId: m.userId,
                        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
                        email: m.email,
                    },
                ]),
        );

        const participants = await this.participantRepo.find({
            where: { profile: { profile_id: In(profileIds) }, assignedBy: managerUserId },
            relations: ['project', 'project.skills', 'profile'],
            order: { participant_id: 'DESC' },
        });

        return participants.map((p) => {
            const profileId = p.profile?.profile_id;
            const meta = profileId ? memberByProfile.get(profileId) : undefined;
            return {
                id: p.participant_id,
                employeeId: meta?.userId || '',
                assigneeProfileId: profileId || '',
                assigneeName: meta?.name || '',
                assigneeEmail: meta?.email || '',
                name: p.project?.projectName ?? '',
                client: p.project?.clientName ?? '',
                startDate: this.toDateString(p.project?.startDate),
                endDate: this.toDateString(p.project?.endDate),
                technologies: (p.project?.skills ?? []).map((s) => s.skillName),
                description: p.description || p.project?.projectDescription || '',
                role: p.role || 'Contributor',
            };
        });
    }

    async updateParticipation(participantId: string, userId: string, dto: UpdateParticipationDto, userRole?: string) {
        const participant = await this.participantRepo.findOne({
            where: { participant_id: participantId },
            relations: ['profile', 'profile.user', 'project'],
        });
        if (!participant) {
            throw new NotFoundException('Project participation not found');
        }
        if (participant.profile?.user?.user_id !== userId) {
            throw new NotFoundException('Project participation not found for this user');
        }

        if (dto.description !== undefined) {
            participant.description = String(dto.description || '').trim();
        }
        // Only managers can change role; employees can only update description
        if (dto.role !== undefined && userRole !== 'employee') {
            const role = String(dto.role || '').trim();
            participant.role = (role || 'contributor') as ParticipantRole;
        }

        const saved = await this.participantRepo.save(participant);

        const employeeUserId = participant.profile?.user?.user_id;
        const employeeName =
            [participant.profile?.user?.firstName, participant.profile?.user?.lastName]
                .filter(Boolean)
                .join(' ') ||
            participant.profile?.user?.email ||
            'Employee';
        const projectName = participant.project?.projectName || 'a project';
        const notifyManagerIds = participant.assignedBy
            ? [participant.assignedBy]
            : employeeUserId
                ? await this.teamsService.getManagersForEmployee(employeeUserId)
                : [];

        if (notifyManagerIds.length) {
            await Promise.all(
                notifyManagerIds.map((mgrId) =>
                    this.notificationsService.create({
                        userId: mgrId,
                        type: 'project_updated',
                        title: 'Project updated',
                        message: `${employeeName} updated ${projectName}`,
                        relatedEntityType: 'project',
                        relatedEntityId: participant.project?.project_id,
                    })
                )
            );
        }

        return saved;
    }

    private toDate(value: string): Date {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException('Invalid date format');
        }
        return parsed;
    }

    private toDateString(value?: Date | string | null): string {
        if (!value) return '';
        if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
        }
        if (typeof value === 'string') {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) {
                return value;
            }
            return parsed.toISOString().slice(0, 10);
        }
        return '';
    }
}
