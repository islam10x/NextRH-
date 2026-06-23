import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateEducationDto {
  @IsString()
  @IsNotEmpty()
  degree: string;

  @IsString()
  @IsOptional()
  fieldOfStudy?: string;

  @IsString()
  @IsOptional()
  institution?: string;

  @IsString()
  @IsOptional()
  endDate?: string;
}

export class UpdateEducationDto {
  @IsString()
  @IsOptional()
  degree?: string;

  @IsString()
  @IsOptional()
  fieldOfStudy?: string;

  @IsString()
  @IsOptional()
  institution?: string;

  @IsString()
  @IsOptional()
  endDate?: string | null;
}
