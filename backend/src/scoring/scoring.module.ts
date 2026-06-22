import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";

import { ScoringController } from "./scoring.controller";
import { ScoringService } from "./scoring.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { TeamsModule } from "../teams/teams.module";

import { DocumentHash } from "./entities/document-hash.entity";
import { ProjectRecord } from "./entities/project-record.entity";
import { TrainingRecord } from "./entities/training-record.entity";
import { ScoringTarget } from "./entities/scoring-target.entity";
import { EmployeeScore } from "./entities/employee-score.entity";

import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { Certification } from "../certifications/entities/certification.entity";
import { User } from "../users/entities/user.entity";
import { TrainingSession } from "../training/training-session.entity";
import { ProjectParticipant } from "../projects/entities/participant.entity";
import { Project } from "../projects/entities/project.entity";

@Module({
  imports: [
    ConfigModule,
    NotificationsModule,
    TeamsModule,
    TypeOrmModule.forFeature([
      DocumentHash,
      ProjectRecord,
      TrainingRecord,
      ScoringTarget,
      EmployeeScore,
      EmployeeProfile,
      Certification,
      User,
      TrainingSession,
      ProjectParticipant,
      Project,
    ]),
  ],
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
