import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

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

  @IsUUID()
  projectId: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high'])
  complexity?: 'low' | 'medium' | 'high';

  @IsOptional()
  @IsString()
  profileEvaluations?: string;
}

export class UploadTrainingSheetDto {
  // profile is derived from authenticated user
}

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

export class UpdateProjectRecordDto {
  @IsOptional()
  @IsEnum(['low', 'medium', 'high'])
  complexity?: 'low' | 'medium' | 'high';
}

export class ComputeScoreDto {
  @IsUUID()
  profileId: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

export class ComputeTeamScoresDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}

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

export class ScoreExternalEvaluationDto {
  @IsNumber()
  @Min(0)
  @Max(20)
  score: number;
}

export class ScoreInternalEvaluationDto {
  @IsNumber()
  @Min(0)
  @Max(20)
  score: number;
}
