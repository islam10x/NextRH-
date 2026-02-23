import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { RagService } from './rag.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@Controller('rag')
export class RagController {
    constructor(private readonly ragService: RagService) { }

    @Post('chat')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
    async chat(@Body() body: { message: string; session_id?: string }) {
        return this.ragService.chat(body.message, body.session_id || 'default');
    }

    @Post('sync-all')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER)
    async syncAll() {
        return this.ragService.triggerFullSync();
    }
}
