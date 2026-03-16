import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Notification } from './entities/notification.entity';
import { CertificationAlert } from './entities/certification-alert.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { WebhookController } from './webhook.controller';
import { CertificationAlertService } from './certification-alert.service';
import { EmailFallbackService } from './email-fallback.service';
import { N8nWebhookPusher } from './n8n-webhook-pusher.service';
import { User } from '../users/entities/user.entity';
import { Certification } from '../certifications/entities/certification.entity';

@Module({
    imports: [
        ConfigModule,
        HttpModule,
        TypeOrmModule.forFeature([Notification, User, CertificationAlert, Certification]),
    ],
    controllers: [NotificationsController, WebhookController],
    providers: [
        N8nWebhookPusher,
        NotificationsService,
        CertificationAlertService,
        EmailFallbackService,
    ],
    exports: [NotificationsService],
})
export class NotificationsModule { }
