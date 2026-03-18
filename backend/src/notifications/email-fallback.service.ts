import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { Notification } from './entities/notification.entity';

/**
 * Daily fallback sweep.
 *
 * Most emails are sent instantly via the N8nWebhookPusher (push-on-create).
 * This cron job runs **once a day** and re-pushes any notifications whose
 * `email_sent` is still false — covering cases where n8n was temporarily
 * down or the real-time push failed.
 */
@Injectable()
export class EmailFallbackService {
    private readonly logger = new Logger(EmailFallbackService.name);
    private readonly webhookUrl: string | null;
    private readonly webhookSecret: string;

    constructor(
        @InjectRepository(Notification)
        private readonly notificationsRepo: Repository<Notification>,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        this.webhookUrl =
            this.configService.get<string>('N8N_WEBHOOK_URL') || null;
        this.webhookSecret =
            this.configService.get<string>('N8N_WEBHOOK_SECRET') || '';
        if (!this.webhookSecret) {
            throw new Error('N8N_WEBHOOK_SECRET is required');
        }
    }

    /**
     * Runs daily at 7:30 AM (just after the certification-expiry cron at 7:00 AM).
     */
    @Cron('0 30 7 * * *', { name: 'email-fallback-sweep' })
    async handleFallbackSweep() {
        if (!this.webhookUrl) {
            this.logger.warn('N8N_WEBHOOK_URL not set — skipping fallback sweep.');
            return;
        }

        this.logger.log('Running daily email-fallback sweep…');

        try {
            const pending = await this.notificationsRepo
                .createQueryBuilder('n')
                .leftJoinAndSelect('n.user', 'u')
                .where('n.email_sent = false')
                .andWhere('(n.scheduled_at IS NULL OR n.scheduled_at <= :now)', {
                    now: new Date(),
                })
                .orderBy('n.created_at', 'ASC')
                .take(200)
                .getMany();

            if (pending.length === 0) {
                this.logger.log('No pending emails to retry.');
                return;
            }

            this.logger.log(`Found ${pending.length} un-emailed notification(s). Pushing to n8n…`);

            let pushed = 0;
            for (const n of pending) {
                try {
                    await firstValueFrom(
                        this.httpService.post(
                            this.webhookUrl,
                            {
                                notificationId: n.notification_id,
                                userEmail: n.user?.email,
                                userName: n.user
                                    ? `${n.user.firstName || ''} ${n.user.lastName || ''}`.trim()
                                    : '',
                                type: n.notificationType,
                                title: n.title,
                                message: n.message,
                                priority: n.priority,
                                createdAt: n.createdAt,
                            },
                            {
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-webhook-secret': this.webhookSecret,
                                },
                                timeout: 10000,
                            },
                        ),
                    );
                    pushed++;
                } catch (err) {
                    this.logger.warn(
                        `Failed to push notification ${n.notification_id}: ${err.message}`,
                    );
                }
            }

            this.logger.log(`Fallback sweep complete — pushed ${pushed}/${pending.length}.`);
        } catch (error) {
            this.logger.error('Email fallback sweep failed', error.stack);
        }
    }
}
