import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as http from 'http';
import * as https from 'https';

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
    private readonly isHttps: boolean;
    private readonly retryDelayMs = 750;

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        this.webhookUrl =
            this.configService.get<string>('N8N_WEBHOOK_URL') || null;
        this.webhookSecret =
            this.configService.get<string>('N8N_WEBHOOK_SECRET') || '';
        this.isHttps = Boolean(this.webhookUrl && this.webhookUrl.startsWith('https://'));
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

        this.logger.log(
            `Pushing notification ${payload.notificationId} to n8n...`,
        );

        this.sendWebhook(payload, false);
    }

    private sendWebhook(payload: {
        notificationId: string;
        userEmail: string;
        userName: string;
        type: string;
        title: string;
        message?: string;
        priority: number;
        createdAt: Date;
    }, retried: boolean): void {
        firstValueFrom(
            this.httpService.post(this.webhookUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-webhook-secret': this.webhookSecret,
                    'Connection': 'close',
                },
                httpAgent: this.isHttps ? undefined : new http.Agent({ keepAlive: false }),
                httpsAgent: this.isHttps ? new https.Agent({ keepAlive: false }) : undefined,
                timeout: 5000,
                validateStatus: () => true,
            }),
        )
            .then((response) => {
                if (response.status >= 200 && response.status < 300) {
                    this.logger.log(
                        `n8n push succeeded for ${payload.notificationId}`,
                    );
                    return;
                }

                const responseData = response.data ? ` | response: ${JSON.stringify(response.data)}` : '';
                this.logger.warn(
                    `n8n push failed (will be retried by fallback sweep): unexpected status ${response.status}${responseData}`,
                );
            })
            .catch((err) => {
                const code = err?.code ? ` [${err.code}]` : '';
                if (!retried && (err?.code === 'ECONNRESET' || err?.code === 'ECONNABORTED' || /ECONNRESET/i.test(String(err?.message || '')))) {
                    this.logger.warn(
                        `n8n push hit a transient connection reset${code}; retrying once for ${payload.notificationId}`,
                    );
                    setTimeout(() => this.sendWebhook(payload, true), this.retryDelayMs);
                    return;
                }

                const status = err?.response?.status;
                const data = err?.response?.data;
                const extra = status ? ` (status ${status})` : '';
                this.logger.log(
                    `n8n push failed (will be retried by fallback sweep): ${err.message}${code}${extra}` +
                    (data ? ` | response: ${JSON.stringify(data)}` : ''),
                );
            });
    }
}
