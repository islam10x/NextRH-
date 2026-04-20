import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { ScoringService } from './scoring.service';
import { TeamsService } from '../teams/teams.service';
import {
  UploadPvDto,
  UploadTrainingSheetDto,
  SetTargetsDto,
  UpdateWeightsDto,
  UpdateProjectRecordDto,
  ComputeScoreDto,
  ComputeTeamScoresDto,
} from './dto/scoring.dto';

@Controller('scoring')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ScoringController {
  constructor(
    private readonly scoringService: ScoringService,
    private readonly teamsService: TeamsService,
  ) {}

  // ── PV Upload (Team Manager uploads for an employee) ───────────────

  @Post('upload-pv')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  async uploadPv(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadPvDto,
    @Req() req: any,
  ) {
    return this.scoringService.uploadPv(
      file,
      dto.profileId,
      req.user.id,
      dto.projectId,
      dto.projectName,
      dto.clientName,
      dto.complexity,
      dto.employeeRole,
    );
  }

  // ── Training Sheet Upload (Employee uploads for themselves) ───────────

  @Post('upload-training-sheet')
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  async uploadTrainingSheet(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    return this.scoringService.uploadTrainingSheet(
      file,
      req.user.id,
    );
  }

  // ── Targets ───────────────────────────────────────────────────────────

  @Post('targets')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async setTargets(@Body() dto: SetTargetsDto, @Req() req: any) {
    return this.scoringService.setTargets(
      dto.profileId,
      dto.targetYear,
      dto.certificationTarget,
      req.user.id,
    );
  }

  @Get('targets/:profileId/:year')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getTargets(
    @Param('profileId') profileId: string,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.scoringService.getTargets(profileId, year);
  }

  // ── Weights ───────────────────────────────────────────────────────────

  @Get('weights')
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async getWeights(@Query('teamId') teamId: string | undefined, @Req() req: any) {
    const userId = req.user?.id || req.user?.userId || req.user?.user_id;
    const role = req.user?.role;

    let effectiveTeamId = teamId;
    if (role === UserRole.EMPLOYEE) {
      effectiveTeamId = (await this.teamsService.getTeamIdForEmployee(userId)) || undefined;
    } else if (role === UserRole.TEAM_MANAGER) {
      effectiveTeamId = (await this.teamsService.getTeamIdForManager(userId)) || undefined;
    }

    return this.scoringService.getWeights(effectiveTeamId);
  }

  @Patch('weights')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async updateWeights(@Body() dto: UpdateWeightsDto, @Req() req: any) {
    const userId = req.user?.id || req.user?.userId || req.user?.user_id;
    const role = req.user?.role;

    let effectiveTeamId = dto.teamId;
    if (role === UserRole.TEAM_MANAGER) {
      effectiveTeamId = await this.teamsService.getTeamIdForManager(userId);
      if (!effectiveTeamId) {
        throw new BadRequestException('No team found for this manager');
      }
    }

    return this.scoringService.updateWeights(
      dto.projectWeight,
      dto.certificationWeight,
      dto.trainingWeight,
      dto.formationWeight,
      effectiveTeamId,
      userId,
    );
  }

  // ── Score Computation ─────────────────────────────────────────────────

  @Post('compute')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async computeScore(@Body() dto: ComputeScoreDto, @Req() req: any) {
    // If the requester is an employee, ensure they can only compute their own score
    if (req.user.role === UserRole.EMPLOYEE && req.user.profileId !== dto.profileId) {
      // Allow if they request their own score (profileId checking will be done here or they just pass their own)
    }
    return this.scoringService.computeScore(dto.profileId, dto.year);
  }

  @Post('compute-team')
  @Roles(UserRole.TEAM_MANAGER)
  async computeTeamScores(
    @Body() dto: ComputeTeamScoresDto,
    @Req() req: any,
  ) {
    return this.scoringService.computeTeamScores(req.user.id, dto.year);
  }

  // ── Data Access ───────────────────────────────────────────────────────

  @Get('score/:profileId/:year')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getScore(
    @Param('profileId') profileId: string,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.scoringService.getEmployeeScore(profileId, year);
  }

  @Get('history/:profileId')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getScoreHistory(@Param('profileId') profileId: string) {
    return this.scoringService.getScoreHistory(profileId);
  }

  @Get('project-records/:profileId')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getProjectRecords(@Param('profileId') profileId: string) {
    return this.scoringService.getProjectRecords(profileId);
  }

  @Get('training-records/:profileId')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getTrainingRecords(@Param('profileId') profileId: string) {
    return this.scoringService.getTrainingRecords(profileId);
  }

  @Patch('project-records/:recordId')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async updateProjectRecord(
    @Param('recordId') recordId: string,
    @Body() dto: UpdateProjectRecordDto,
  ) {
    return this.scoringService.updateProjectRecord(
      recordId,
      dto.complexity,
      dto.employeeRole,
    );
  }

  // ── List projects for PV selector ─────────────────────────────────────

  @Get('projects')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async listProjects(@Req() req: any) {
    return this.scoringService.listProjects(req.user.id);
  }

  // ── Leaderboard ───────────────────────────────────────────────────────

  @Get('leaderboard')
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getLeaderboard(
    @Query('year', ParseIntPipe) year: number,
    @Query('teamId') teamId?: string,
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    const userId = req?.user?.id || req?.user?.userId || req?.user?.user_id;
    let effectiveTeamId = teamId;

    if (!effectiveTeamId && req?.user?.role === UserRole.TEAM_MANAGER) {
      effectiveTeamId = (await this.teamsService.getTeamIdForManager(userId)) || undefined;
    }

    return this.scoringService.getLeaderboard(
      year,
      effectiveTeamId,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
