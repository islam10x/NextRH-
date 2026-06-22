import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  IsDateString,
} from "class-validator";
import { TrainingStatus } from "../training-session.entity";

export class UpdateTrainingStatusDto {
  @IsEnum(["assigned", "in_progress", "completed"])
  status: TrainingStatus;

  // Kept for compatibility when status is moved to completed via API without upload
  @IsOptional()
  @IsString()
  @MaxLength(512)
  proofFilePath?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
