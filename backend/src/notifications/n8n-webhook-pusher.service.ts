import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * Fire-and-forget push to n8n webhook.
 *
 * Every time a notification is created the backend pushes the payload
 * to n8n so the email is sent **immediately** — no polling required.
 *
 * If n8n is down or unreachable the push silently fails; the daily
 * EmailFallbackService sweep will pick up any un-emailed notifications.
 */
@Injectable()
export class N8nWebhookPusher {
    private readonly logger = new Logger(N8nWebhookPusher.name);
    private readonly webhookUrl: string | null;
    private readonly webhookSecret: string;

    constructor(
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

        if (!this.webhookUrl) {
            this.logger.warn(
                'N8N_WEBHOOK_URL is not set — real-time email push is disabled. ' +
                'Emails will only be sent via the daily fallback sweep.',
            );
        }
        if (this.webhookUrl) {
            this.logger.log(`N8N webhook push enabled: ${this.webhookUrl}`);
        }
    }

    /**
     * Push a notification payload to n8n. Returns immediately (fire-and-forget).
     */
    push(payload: {
        notificationId: string;
        userEmail: string;
        userName: string;
        type: string;
        title: string;
        message?: string;
        priority: number;
        createdAt: Date;
    }): void {
        if (!this.webhookUrl) return;

        // Fire-and-forget — do NOT await
        this.logger.log(
            `Pushing notification ${payload.notificationId} to n8n...`,
        );
        firstValueFrom(
            this.httpService.post(this.webhookUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': this.webhookSecret,
                },
                timeout: 5000,
            }),
        )
            .then(() => {
                this.logger.log(
                    `n8n push succeeded for ${payload.notificationId}`,
                );
            })
            .catch((err) => {
            const status = err?.response?.status;
            const data = err?.response?.data;
            const extra = status ? ` (status ${status})` : '';
            this.logger.warn(
                `n8n push failed (will be retried by fallback sweep): ${err.message}${extra}` +
                (data ? ` | response: ${JSON.stringify(data)}` : ''),
            );
        });
    }
}
