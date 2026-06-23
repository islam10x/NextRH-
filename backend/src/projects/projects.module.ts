import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Project } from "./entities/project.entity";
import { ProjectParticipant } from "./entities/participant.entity";
import { ProjectsService } from "./projects.service";
import { ProjectsController } from "./projects.controller";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { Skill } from "../skills/entities/skill.entity";
import { User } from "../users/entities/user.entity";
import { TeamsModule } from "../teams/teams.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ScoringModule } from "../scoring/scoring.module";
import { CrossTeamAssignmentRequest } from "./entities/cross-team-assignment-request.entity";
import { Team } from "../teams/entities/team.entity";
import { FileStorageModule } from "../file-storage/file-storage.module";
import { RagModule } from "../rag/rag.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectParticipant,
      CrossTeamAssignmentRequest,
      EmployeeProfile,
      Skill,
      User,
      Team,
    ]),
    TeamsModule,
    NotificationsModule,
    forwardRef(() => ScoringModule),
    FileStorageModule,
    RagModule,
  ],
  providers: [ProjectsService],
  controllers: [ProjectsController],
  exports: [ProjectsService],
})
export class ProjectsModule {}
