import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@Controller('teams')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TeamsController {
    constructor(private readonly teamsService: TeamsService) { }

    @Get('members/me')
    @Roles(UserRole.TEAM_MANAGER)
    async myTeamMembers(@Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.teamsService.getMembersForManager(managerId);
    }
}
