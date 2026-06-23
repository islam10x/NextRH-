import { IsInt, IsOptional, IsString, Min } from "class-validator";

export class UpdateProfileBasicsDto {
  @IsString()
  @IsOptional()
  currentPosition?: string;

  @IsString()
  @IsOptional()
  professionalSummary?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  totalExperienceYears?: number;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  address?: string;
}
