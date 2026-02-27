import { Controller, Get, Param, Patch, Req, UseGuards, Delete } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) { }

    @Get('me')
    async myNotifications(@Req() req: any) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.notificationsService.listForUser(userId);
    }

    @Patch(':id/read')
    async markRead(@Param('id') id: string, @Req() req: any) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        await this.notificationsService.markRead(id, userId);
        return { message: 'ok' };
    }

    @Delete(':id')
    async delete(@Param('id') id: string, @Req() req: any) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        await this.notificationsService.deleteForUser(id, userId);
        return { message: 'deleted' };
    }
}
