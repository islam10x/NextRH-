import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Body, Patch } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@Controller('teams')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TeamsController {
    constructor(private readonly teamsService: TeamsService) { }

    @Get('count')
    @Roles(UserRole.BID_MANAGER)
    async countTeams() {
        const count = await this.teamsService.countAll();
        return { count };
    }

    @Get('members/me')
    @Roles(UserRole.TEAM_MANAGER)
    async myTeamMembers(@Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.teamsService.getMembersForManager(managerId);
    }

    @Get('other')
    @Roles(UserRole.TEAM_MANAGER)
    async listOtherTeams(@Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.teamsService.listOtherTeamsForManager(managerId);
    }

    @Get('me')
    @Roles(UserRole.TEAM_MANAGER)
    async myTeam(@Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.teamsService.getManagerTeam(managerId);
    }

    @Patch('me')
    @Roles(UserRole.TEAM_MANAGER)
    async updateMyTeam(@Req() req: any, @Body() body: { teamName?: string; teamFocus?: string | null }) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.teamsService.updateManagerTeam(managerId, body?.teamName || '', body?.teamFocus ?? null);
    }

    @Get('my-team')
    @Roles(UserRole.TEAM_MANAGER, UserRole.EMPLOYEE)
    async myTeamInfo(@Req() req: any) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        const role = req.user?.role;
        if (role === UserRole.TEAM_MANAGER) {
            return this.teamsService.getManagerTeam(userId);
        }
        const info = await this.teamsService.getTeamInfoForEmployee(userId);
        if (!info) return null;
        return info;
    }
}
