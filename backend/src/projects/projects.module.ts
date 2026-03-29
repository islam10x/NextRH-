import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { ProjectParticipant } from './entities/participant.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { Skill } from '../skills/entities/skill.entity';
import { TeamsModule } from '../teams/teams.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [TypeOrmModule.forFeature([Project, ProjectParticipant, EmployeeProfile, Skill]), TeamsModule, NotificationsModule],
    providers: [ProjectsService],
    controllers: [ProjectsController],
})
export class ProjectsModule { }
