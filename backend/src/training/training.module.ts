import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrainingService } from './training.service';
import { TrainingController } from './training.controller';
import { TrainingSession } from './training-session.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { User } from '../users/entities/user.entity';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { FileValidationModule } from '../file-validation/file-validation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TeamsModule } from '../teams/teams.module';
import { MailModule } from '../mail/mail.module';
import { Certification } from '../certifications/entities/certification.entity';
import { ConfigModule } from '@nestjs/config';
import { ScoringModule } from '../scoring/scoring.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([TrainingSession, EmployeeProfile, User, Certification]),
        ConfigModule,
        FileStorageModule,
        FileValidationModule,
        NotificationsModule,
        TeamsModule,
        MailModule,
        forwardRef(() => ScoringModule),
    ],
    controllers: [TrainingController],
    providers: [TrainingService],
})
export class TrainingModule { }
