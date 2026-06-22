import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ProjectsService } from "./projects.service";
import { AssignProjectDto } from "./dto/assign-project.dto";
import { UpdateParticipationDto } from "./dto/update-participation.dto";
import { RequestCrossTeamMemberDto } from "./dto/request-cross-team-member.dto";
import { RespondCrossTeamRequestDto } from "./dto/respond-cross-team-request.dto";

@Controller("projects")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post("assign")
  @Roles(UserRole.TEAM_MANAGER)
  async assign(@Body() dto: AssignProjectDto, @Req() req: any) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.assignProject(dto, managerId);
  }

  @Get("me")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async listMine(@Req() req: any) {
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.listForUser(userId);
  }

  @Get("team")
  @Roles(UserRole.TEAM_MANAGER)
  async listTeam(@Req() req: any) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.listForManager(managerId);
  }

  @Get("owned")
  @Roles(UserRole.TEAM_MANAGER)
  async listOwned(@Req() req: any) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.listOwnedProjects(managerId);
  }

  @Post("cross-team-requests")
  @Roles(UserRole.TEAM_MANAGER)
  async requestCrossTeamMember(
    @Body() dto: RequestCrossTeamMemberDto,
    @Req() req: any,
  ) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.requestCrossTeamMember(dto, managerId);
  }

  @Get("cross-team-requests/incoming")
  @Roles(UserRole.TEAM_MANAGER)
  async listIncomingCrossTeamRequests(@Req() req: any) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.listIncomingCrossTeamRequests(managerId);
  }

  @Get("cross-team-requests/outgoing")
  @Roles(UserRole.TEAM_MANAGER)
  async listOutgoingCrossTeamRequests(@Req() req: any) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.listOutgoingCrossTeamRequests(managerId);
  }

  @Patch("cross-team-requests/:requestId/respond")
  @Roles(UserRole.TEAM_MANAGER)
  async respondCrossTeamRequest(
    @Param("requestId") requestId: string,
    @Body() dto: RespondCrossTeamRequestDto,
    @Req() req: any,
  ) {
    const managerId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.respondCrossTeamRequest(
      requestId,
      managerId,
      dto,
    );
  }

  @Patch("participations/:participantId")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async updateParticipation(
    @Param("participantId") participantId: string,
    @Body() dto: UpdateParticipationDto,
    @Req() req: any,
  ) {
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.projectsService.updateParticipation(participantId, userId, dto);
  }
}
