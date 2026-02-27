import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TrainingSession, TrainingStatus } from './training-session.entity';
import { CreateTrainingDto } from './dto/create-training.dto';
import { UpdateTrainingStatusDto } from './dto/update-training-status.dto';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { User } from '../users/entities/user.entity';
import { FileStorageService } from '../file-storage/file-storage.service';
import { FileValidationService } from '../file-validation/file-validation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamsService } from '../teams/teams.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class TrainingService {
    constructor(
        @InjectRepository(TrainingSession)
        private readonly trainingRepo: Repository<TrainingSession>,
        @InjectRepository(EmployeeProfile)
        private readonly profilesRepo: Repository<EmployeeProfile>,
        @InjectRepository(User)
        private readonly usersRepo: Repository<User>,
        private readonly fileStorageService: FileStorageService,
        private readonly fileValidationService: FileValidationService,
        private readonly notificationsService: NotificationsService,
        private readonly teamsService: TeamsService,
        private readonly mailService: MailService,
    ) { }

    async assignTraining(dto: CreateTrainingDto, managerUserId?: string, managerEmail?: string) {
        const profiles = await this.profilesRepo.find({
            where: { profile_id: In(dto.assigneeProfileIds) },
            relations: ['user'],
        });
        if (profiles.length !== dto.assigneeProfileIds.length) {
            throw new NotFoundException('One or more assignee profiles not found');
        }

        const assignedBy = managerUserId ? await this.usersRepo.findOne({ where: { user_id: managerUserId } }) : null;
        const managerName = assignedBy ? [assignedBy.firstName, assignedBy.lastName].filter(Boolean).join(' ') : null;

        const rows = profiles.map((profile) =>
            this.trainingRepo.create({
                profile,
                trainingTitle: dto.trainingTitle,
                provider: dto.provider,
                trainingUrl: dto.trainingUrl,
                dueDate: dto.dueDate,
                description: dto.description,
                status: 'assigned',
                assignedBy: managerEmail || assignedBy?.email || null,
            }),
        );

        const saved = await this.trainingRepo.save(rows);

        // Notifications to assignees
        await Promise.all(
            saved.map((row) =>
                this.notificationsService.create({
                    userId: row.profile?.user?.user_id || '',
                    type: 'training_assigned',
                    title: 'New training assigned',
                    message: `${row.trainingTitle}${row.dueDate ? ` · Due ${row.dueDate}` : ''}`,
                    relatedEntityType: 'training_session',
                    relatedEntityId: row.training_id,
                })
            )
        );

        await Promise.all(
            saved.map((row) => {
                const to = row.profile?.user?.email;
                if (!to) return Promise.resolve();
                return this.mailService.sendTrainingAssignedEmail({
                    to,
                    trainingTitle: row.trainingTitle,
                    trainingUrl: row.trainingUrl,
                    dueDate: row.dueDate || undefined,
                    managerName,
                    managerEmail: managerEmail || assignedBy?.email || undefined,
                });
            })
        );
        return saved;
    }

    async listForEmployee(profileId: string) {
        return this.trainingRepo.find({
            where: { profile: { profile_id: profileId } },
            order: { createdAt: 'DESC' },
        });
    }

    async listForUser(userId: string) {
        const profile = await this.profilesRepo.findOne({
            where: { user: { user_id: userId } },
        });
        if (!profile) {
            throw new NotFoundException('Profile not found for user');
        }
        return this.listForEmployee(profile.profile_id);
    }

    async listAssignedByUser(email?: string, userId?: string) {
        let managerEmail = email;
        if (!managerEmail && userId) {
            const user = await this.usersRepo.findOne({ where: { user_id: userId } });
            managerEmail = user?.email;
        }
        if (!managerEmail) return [];
        return this.trainingRepo.find({
            where: { assignedBy: managerEmail },
            relations: { profile: { user: true } },
            order: { createdAt: 'DESC' },
        });
    }

    async updateStatus(trainingId: string, dto: UpdateTrainingStatusDto, actorProfileId?: string) {
        const training = await this.trainingRepo.findOne({
            where: { training_id: trainingId },
            relations: ['profile', 'profile.user'],
        });
        if (!training) {
            throw new NotFoundException('Training session not found');
        }

        // Optional: simple ownership check if provided
        if (actorProfileId && training.profile?.profile_id !== actorProfileId) {
            throw new NotFoundException('Training session not found for this user');
        }

        training.status = dto.status;
        if (dto.status === 'in_progress') {
            training.startDate = new Date().toISOString().slice(0, 10);
            // Notify managers of this employee
            const employeeUserId = training.profile?.user?.user_id;
            if (employeeUserId) {
                const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
                const employeeName = [training.profile?.user?.firstName, training.profile?.user?.lastName]
                    .filter(Boolean)
                    .join(' ')
                    || training.profile?.user?.email
                    || 'Employee';
                await Promise.all(
                    managers.map((mgrId) =>
                        this.notificationsService.create({
                            userId: mgrId,
                            type: 'training_started',
                            title: 'Training started',
                            message: `${employeeName} started ${training.trainingTitle} training`,
                            relatedEntityType: 'training_session',
                            relatedEntityId: training.training_id,
                        })
                    )
                );
            }
        }
        if (dto.status === 'completed') {
            training.endDate = dto.endDate ?? new Date().toISOString().slice(0, 10);
            training.description = dto.description ?? training.description;
            const employeeUserId = training.profile?.user?.user_id;
            if (employeeUserId) {
                const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
                const employeeName = [training.profile?.user?.firstName, training.profile?.user?.lastName]
                    .filter(Boolean)
                    .join(' ')
                    || training.profile?.user?.email
                    || 'Employee';
                await Promise.all(
                    managers.map((mgrId) =>
                        this.notificationsService.create({
                            userId: mgrId,
                            type: 'training_completed',
                            title: 'Training completed',
                            message: `${employeeName} completed ${training.trainingTitle} training${dto.description ? ` · Comment: ${dto.description}` : ''}`,
                            relatedEntityType: 'training_session',
                            relatedEntityId: training.training_id,
                        })
                    )
                );
            }
        }
        training.proofFilePath = dto.proofFilePath ?? training.proofFilePath;
        return this.trainingRepo.save(training);
    }

    async uploadProof(trainingId: string, file: Express.Multer.File, userId: string, endDate?: string, description?: string) {
        const training = await this.trainingRepo.findOne({
            where: { training_id: trainingId },
            relations: { profile: { user: true } },
        });
        if (!training) {
            throw new NotFoundException('Training session not found');
        }
        if (training.profile?.user?.user_id !== userId) {
            throw new NotFoundException('Training session not found for this user');
        }

        await this.fileValidationService.validate(file, 'certification');
        const storage = await this.fileStorageService.saveEmployeeFile(userId, file, 'Certifications');

        training.proofFilePath = storage.path;
        training.status = 'completed';
        training.endDate = endDate ?? new Date().toISOString().slice(0, 10);
        training.description = description ?? training.description;

        await this.trainingRepo.save(training);

        const employeeUserId = training.profile?.user?.user_id;
        if (employeeUserId) {
            const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
            const employeeName = [training.profile?.user?.firstName, training.profile?.user?.lastName]
                .filter(Boolean)
                .join(' ')
                || training.profile?.user?.email
                || 'Employee';
            await Promise.all(
                managers.map((mgrId) =>
                    this.notificationsService.create({
                        userId: mgrId,
                        type: 'training_completed',
                        title: 'Training completed',
                        message: `${employeeName} completed ${training.trainingTitle} training`,
                        relatedEntityType: 'training_session',
                        relatedEntityId: training.training_id,
                    })
                )
            );
        }

        return {
            trainingId: training.training_id,
            status: training.status,
            proofFilePath: training.proofFilePath,
        };
    }
}


