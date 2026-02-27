import { Module } from '@nestjs/common';
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

@Module({
    imports: [
        TypeOrmModule.forFeature([TrainingSession, EmployeeProfile, User]),
        FileStorageModule,
        FileValidationModule,
        NotificationsModule,
        TeamsModule,
        MailModule,
    ],
    controllers: [TrainingController],
    providers: [TrainingService],
})
export class TrainingModule { }
