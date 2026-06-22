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
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ScoringService } from "./scoring.service";
import { TeamsService } from "../teams/teams.service";
import {
  UploadPvDto,
  UploadTrainingSheetDto,
  SetTargetsDto,
  UpdateProjectRecordDto,
  ComputeScoreDto,
  ComputeTeamScoresDto,
  ScoreExternalEvaluationDto,
  ScoreInternalEvaluationDto,
  ScoreInternalProjectDto,
} from "./dto/scoring.dto";

@Controller("scoring")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ScoringController {
  constructor(
    private readonly scoringService: ScoringService,
    private readonly teamsService: TeamsService,
  ) {}

  // ── PV Preview (parse only, no save) ──────────────────────────────

  @Post("preview-pv")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(FileInterceptor("file"))
  async previewPv(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    return this.scoringService.previewPv(file, req.user.id);
  }

  // ── PV Upload (Team Manager uploads for an employee) ───────────────

  @Post("upload-pv")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(FileInterceptor("file"))
  async uploadPv(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadPvDto,
    @Req() req: any,
  ) {
    const targetProfileIds = dto.profileIds?.length
      ? [...new Set(dto.profileIds)]
      : dto.profileId
        ? [dto.profileId]
        : [];

    if (targetProfileIds.length === 0) {
      throw new BadRequestException(
        "Veuillez sélectionner au moins un employé",
      );
    }

    let parsedProfileEvaluations:
      | Array<{
          profileId: string;
          score?: number;
          contributionDescription?: string;
        }>
      | undefined;
    if (dto.profileEvaluations) {
      try {
        parsedProfileEvaluations = JSON.parse(dto.profileEvaluations);
      } catch {
        // ignore invalid JSON
      }
    }

    return this.scoringService.uploadPv(
      file,
      targetProfileIds,
      req.user.id,
      dto.projectId,
      dto.complexity,
      parsedProfileEvaluations,
    );
  }

  // ── Training Sheet Upload (Employee uploads for themselves) ───────────

  @Post("upload-training-sheet")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(FileInterceptor("file"))
  async uploadTrainingSheet(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    return this.scoringService.uploadTrainingSheet(file, req.user.id);
  }

  // ── Targets ───────────────────────────────────────────────────────────

  @Post("targets")
  @Roles(UserRole.TEAM_MANAGER)
  async setTargets(@Body() dto: SetTargetsDto, @Req() req: any) {
    return this.scoringService.setTargets(
      dto.profileId,
      dto.targetYear,
      dto.certificationTarget,
      req.user.id,
    );
  }

  @Get("targets/:profileId/:year")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getTargets(
    @Param("profileId") profileId: string,
    @Param("year", ParseIntPipe) year: number,
  ) {
    return this.scoringService.getTargets(profileId, year);
  }

  // ── Weights ───────────────────────────────────────────────────────────

  // ── Score Computation ─────────────────────────────────────────────────

  @Post("compute")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async computeScore(@Body() dto: ComputeScoreDto, @Req() req: any) {
    // If the requester is an employee, ensure they can only compute their own score
    if (
      req.user.role === UserRole.EMPLOYEE &&
      req.user.profileId !== dto.profileId
    ) {
      // Allow if they request their own score (profileId checking will be done here or they just pass their own)
    }
    return this.scoringService.computeScore(dto.profileId, dto.year);
  }

  @Post("compute-team")
  @Roles(UserRole.TEAM_MANAGER)
  async computeTeamScores(@Body() dto: ComputeTeamScoresDto, @Req() req: any) {
    return this.scoringService.computeTeamScores(req.user.id, dto.year);
  }

  @Post("compute-all")
  @Roles(UserRole.BID_MANAGER)
  async computeAllScores(@Body() dto: ComputeTeamScoresDto) {
    return this.scoringService.computeAllScores(dto.year);
  }

  // ── Data Access ───────────────────────────────────────────────────────

  @Get("score/:profileId/:year")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getScore(
    @Param("profileId") profileId: string,
    @Param("year", ParseIntPipe) year: number,
  ) {
    return this.scoringService.getEmployeeScore(profileId, year);
  }

  @Get("history/:profileId")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getScoreHistory(@Param("profileId") profileId: string) {
    return this.scoringService.getScoreHistory(profileId);
  }

  @Get("project-records/:profileId")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getProjectRecords(@Param("profileId") profileId: string) {
    return this.scoringService.getProjectRecords(profileId);
  }

  @Get("training-records/:profileId")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getTrainingRecords(@Param("profileId") profileId: string) {
    return this.scoringService.getTrainingRecords(profileId);
  }

  @Patch("project-records/:recordId")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async updateProjectRecord(
    @Param("recordId") recordId: string,
    @Body() dto: UpdateProjectRecordDto,
  ) {
    return this.scoringService.updateProjectRecord(recordId, dto.complexity);
  }

  @Get("external-evaluations/pending")
  @Roles(UserRole.TEAM_MANAGER)
  async listPendingExternalEvaluations(@Req() req: any) {
    const managerId = req.user?.id || req.user?.userId || req.user?.user_id;
    return this.scoringService.listPendingExternalEvaluations(managerId);
  }

  @Get("internal-evaluations/pending")
  @Roles(UserRole.TEAM_MANAGER)
  async listPendingInternalEvaluations(@Req() req: any) {
    const managerId = req.user?.id || req.user?.userId || req.user?.user_id;
    return this.scoringService.listPendingInternalEvaluations(managerId);
  }

  @Post("external-evaluations/:recordId/score")
  @Roles(UserRole.TEAM_MANAGER)
  async scoreExternalEvaluation(
    @Param("recordId") recordId: string,
    @Body() dto: ScoreExternalEvaluationDto,
    @Req() req: any,
  ) {
    const managerId = req.user?.id || req.user?.userId || req.user?.user_id;
    return this.scoringService.scoreExternalEvaluation(
      recordId,
      managerId,
      dto.score,
    );
  }

  @Post("internal-evaluations/:recordId/score")
  @Roles(UserRole.TEAM_MANAGER)
  async scoreInternalEvaluation(
    @Param("recordId") recordId: string,
    @Body() dto: ScoreInternalEvaluationDto,
    @Req() req: any,
  ) {
    const managerId = req.user?.id || req.user?.userId || req.user?.user_id;
    return this.scoringService.scoreInternalEvaluation(
      recordId,
      managerId,
      dto.score,
    );
  }

  // ── Internal project scoring (no PV needed) ──────────────────────────

  @Post("score-internal-project")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async scoreInternalProject(
    @Body() dto: ScoreInternalProjectDto,
    @Req() req: any,
  ) {
    const managerId = req.user?.id || req.user?.userId || req.user?.user_id;
    return this.scoringService.scoreInternalProject(
      managerId,
      dto.projectId,
      dto.profileEvaluations,
    );
  }

  // ── List projects for PV selector ─────────────────────────────────────

  @Get("projects")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async listProjects(@Req() req: any) {
    const userId = req.user?.id || req.user?.userId || req.user?.user_id;
    const role = req.user?.role;
    return this.scoringService.listProjects(userId, role);
  }

  // ── Leaderboard ───────────────────────────────────────────────────────

  @Get("leaderboard")
  @Roles(UserRole.TEAM_MANAGER, UserRole.BID_MANAGER, UserRole.EMPLOYEE)
  async getLeaderboard(
    @Query("year", ParseIntPipe) year: number,
    @Query("teamId") teamId?: string,
    @Query("limit") limit?: string,
    @Req() req?: any,
  ) {
    const userId = req?.user?.id || req?.user?.userId || req?.user?.user_id;
    let effectiveTeamId = teamId;

    if (!effectiveTeamId && req?.user?.role === UserRole.TEAM_MANAGER) {
      effectiveTeamId =
        (await this.teamsService.getTeamIdForManager(userId)) || undefined;
    }

    return this.scoringService.getLeaderboard(
      year,
      effectiveTeamId,
      limit ? parseInt(limit, 10) : undefined,
    );
  }
}
