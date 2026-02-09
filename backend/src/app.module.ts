import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { EmployeesModule } from './employees/employees.module';
import { SkillsModule } from './skills/skills.module';
import { CertificationsModule } from './certifications/certifications.module';
import { TrainingModule } from './training/training.module';
import { ProjectsModule } from './projects/projects.module';
import { TeamsModule } from './teams/teams.module';
import { CvModule } from './cv/cv.module';
import { FileStorageModule } from './file-storage/file-storage.module';
import { RagModule } from './rag/rag.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MailModule } from './mail/mail.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => ({
                type: 'postgres',
                host: configService.get<string>('DB_HOST', 'postgres'),
                port: parseInt(configService.get<string>('DB_PORT', '5432')),
                username: configService.get<string>('DB_USER', 'postgres'),
                password: configService.get<string>('DB_PASSWORD', 'change_me'),
                database: configService.get<string>('DB_NAME', 'cv_management'),
                entities: [__dirname + '/**/*.entity{.ts,.js}'],
                synchronize: false, // Using migrations, but for dev true is convenient? User schema provided via SQL -> keep false/manual
            }),
            inject: [ConfigService],
        }),
        AuthModule,
        UsersModule,
        EmployeesModule,
        SkillsModule,
        CertificationsModule,
        TrainingModule,
        ProjectsModule,
        TeamsModule,
        CvModule,
        FileStorageModule,
        RagModule,
        NotificationsModule,
        MailModule,
    ],
    controllers: [],
    providers: [],
})
export class AppModule { }
