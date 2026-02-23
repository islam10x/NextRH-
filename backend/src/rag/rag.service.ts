import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RagService {
    private readonly logger = new Logger(RagService.name);
    private readonly aiServiceBaseUrl: string;

    constructor(private readonly configService: ConfigService) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    /**
     * Trigger a RAG sync for a specific user.
     * This calls the AI service's /api/v1/rag/sync/{userId} endpoint.
     */
    async triggerUserSync(userId: string): Promise<void> {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/sync/${userId}`;
            this.logger.log(`Triggering RAG sync for user ${userId}...`);

            const response = await fetch(url, {
                method: 'POST',
            });

            if (!response.ok) {
                this.logger.error(`Failed to trigger RAG sync for user ${userId}: ${response.statusText}`);
            } else {
                this.logger.log(`RAG sync triggered successfully for user ${userId}`);
            }
        } catch (error) {
            this.logger.error(`Error triggering RAG sync for user ${userId}: ${error.message}`);
        }
    }

    /**
     * Trigger a full RAG sync for all users.
     */
    async triggerFullSync(): Promise<void> {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/sync-all`;
            this.logger.log('Triggering full RAG sync...');

            const response = await fetch(url, {
                method: 'POST',
            });

            if (!response.ok) {
                this.logger.error(`Failed to trigger full RAG sync: ${response.statusText}`);
            } else {
                this.logger.log('Full RAG sync triggered successfully');
            }
        } catch (error) {
            this.logger.error(`Error triggering full RAG sync: ${error.message}`);
        }
    }

    /**
     * Send a query to the AI RAG system.
     */
    async chat(message: string, sessionId: string) {
        try {
            const url = `${this.aiServiceBaseUrl}/api/v1/rag/chat`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, session_id: sessionId }),
            });

            if (!response.ok) {
                this.logger.error(`AI Chat failed: ${response.statusText}`);
                throw new Error('AI Service connection error');
            }

            return await response.json();
        } catch (error) {
            this.logger.error(`Error in RAG chat: ${error.message}`);
            throw error;
        }
    }
}
