import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { ProjectsService } from './projects.service';
import { AssignProjectDto } from './dto/assign-project.dto';
import { UpdateParticipationDto } from './dto/update-participation.dto';

@Controller('projects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProjectsController {
    constructor(private readonly projectsService: ProjectsService) { }

    @Post('assign')
    @Roles(UserRole.TEAM_MANAGER)
    async assign(@Body() dto: AssignProjectDto, @Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.projectsService.assignProject(dto, managerId);
    }

    @Get('me')
    @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
    async listMine(@Req() req: any) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.projectsService.listForUser(userId);
    }

    @Get('team')
    @Roles(UserRole.TEAM_MANAGER)
    async listTeam(@Req() req: any) {
        const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
        return this.projectsService.listForManager(managerId);
    }

    @Patch('participations/:participantId')
    @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
    async updateParticipation(
        @Param('participantId') participantId: string,
        @Body() dto: UpdateParticipationDto,
        @Req() req: any,
    ) {
        const userId = req.user?.userId || req.user?.user_id || req.user?.id;
        const userRole = req.user?.role;
        return this.projectsService.updateParticipation(participantId, userId, dto, userRole);
    }
}
