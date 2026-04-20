import {
  IsString,
  IsOptional,
  IsEnum,
  IsUUID,
  IsInt,
  IsNumber,
  IsArray,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// ── Upload PV DTO (Team Manager uploads for an employee) ─────────────────────────

export class UploadPvDto {
  @IsOptional()
  @IsUUID()
  profileId: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [value];
      } catch {
        return [value];
      }
    }
    return undefined;
  })
  @IsArray()
  @IsUUID(undefined, { each: true })
  profileIds?: string[];

  /** Existing project ID — if provided, links PV to this project */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** If no projectId → new project name */
  @IsOptional()
  @IsString()
  projectName?: string;

  /** If no projectId → new project client */
  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high'])
  complexity?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsEnum(['contributor', 'technical_lead', 'project_lead'])
  employeeRole?: 'contributor' | 'technical_lead' | 'project_lead';
}

// ── Upload Training Sheet DTO (Employee uploads for themselves) ───────────

export class UploadTrainingSheetDto {
  // No profileId needed — derived from the authenticated user
}

// ── Set Targets DTO ─────────────────────────────────────────────────────────

export class SetTargetsDto {
  @IsUUID()
  profileId: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  targetYear: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  certificationTarget?: number;
}

// ── Update Weights DTO ──────────────────────────────────────────────────────

export class UpdateWeightsDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  projectWeight: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  certificationWeight: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  trainingWeight: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  formationWeight: number;
}

// ── Update Record Complexity/Role ───────────────────────────────────────────

export class UpdateProjectRecordDto {
  @IsOptional()
  @IsEnum(['low', 'medium', 'high'])
  complexity?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsEnum(['contributor', 'technical_lead', 'project_lead'])
  employeeRole?: 'contributor' | 'technical_lead' | 'project_lead';
}

// ── Compute Score Request ───────────────────────────────────────────────────

export class ComputeScoreDto {
  @IsUUID()
  profileId: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

// ── Batch Compute ───────────────────────────────────────────────────────────

export class ComputeTeamScoresDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

// ── Leaderboard Query ───────────────────────────────────────────────────────

export class LeaderboardQueryDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
