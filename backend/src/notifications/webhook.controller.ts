import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpException,
    HttpStatus,
    Logger,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './entities/notification.entity';

/**
 * DTO for incoming webhook notification creation from n8n.
 */
interface CreateNotificationWebhookDto {
    userId: string;
    type: NotificationType;
    title: string;
    message?: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
    scheduledAt?: string; // ISO date string
    priority?: number;
}

/**
 * Webhook controller that n8n (or any external system) can call
 * to interact with the notification system.
 *
 * All endpoints are protected by a shared secret passed in the
 * `x-webhook-secret` header. Set `N8N_WEBHOOK_SECRET` in your .env.
 */
@Controller('webhooks')
export class WebhookController {
    private readonly logger = new Logger(WebhookController.name);
    private readonly webhookSecret: string;

    constructor(
        private readonly notificationsService: NotificationsService,
        private readonly configService: ConfigService,
    ) {
        this.webhookSecret =
            this.configService.get<string>('N8N_WEBHOOK_SECRET') || 'nextrh-n8n-secret';
    }

    // ── Guard ───────────────────────────────────────────────────────────
    private validateSecret(secret: string | undefined) {
        if (secret !== this.webhookSecret) {
            throw new HttpException('Invalid webhook secret', HttpStatus.UNAUTHORIZED);
        }
    }

    // ── POST /webhooks/notifications ─────────────────────────────────────
    /**
     * n8n calls this endpoint to create a new in-app notification.
     */
    @Post('notifications')
    @HttpCode(201)
    async createNotification(
        @Headers('x-webhook-secret') secret: string,
        @Body() dto: CreateNotificationWebhookDto,
    ) {
        this.validateSecret(secret);
        this.logger.log(`Webhook: creating notification for user ${dto.userId}`);

        const notif = await this.notificationsService.create({
            userId: dto.userId,
            type: dto.type,
            title: dto.title,
            message: dto.message,
            relatedEntityType: dto.relatedEntityType,
            relatedEntityId: dto.relatedEntityId,
            scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
            priority: dto.priority,
        });

        return { success: true, notificationId: notif?.notification_id };
    }

    // ── GET /webhooks/notifications/pending-emails ──────────────────────
    /**
     * n8n calls this to fetch notifications that need email delivery.
     */
    @Get('notifications/pending-emails')
    async getPendingEmails(
        @Headers('x-webhook-secret') secret: string,
        @Query('limit') limit?: string,
    ) {
        this.validateSecret(secret);
        const notifications = await this.notificationsService.getPendingEmailNotifications(
            limit ? parseInt(limit, 10) : 50,
        );

        return notifications.map((n) => ({
            notificationId: n.notification_id,
            userEmail: n.user?.email,
            userName: n.user ? `${n.user.firstName || ''} ${n.user.lastName || ''}`.trim() : '',
            type: n.notificationType,
            title: n.title,
            message: n.message,
            priority: n.priority,
            createdAt: n.createdAt,
        }));
    }

    // ── PATCH /webhooks/notifications/:id/email-sent ────────────────────
    /**
     * n8n calls this after successfully sending an email to mark that
     * notification so it won't be re-sent.
     */
    @Patch('notifications/:id/email-sent')
    @HttpCode(200)
    async markEmailSent(
        @Headers('x-webhook-secret') secret: string,
        @Param('id') id: string,
    ) {
        this.validateSecret(secret);
        await this.notificationsService.markEmailSent(id);
        return { success: true };
    }

    // ── GET /webhooks/health ────────────────────────────────────────────
    /**
     * Simple health check endpoint for n8n to verify connectivity.
     */
    @Get('health')
    healthCheck() {
        return { status: 'ok', timestamp: new Date().toISOString() };
    }
}
