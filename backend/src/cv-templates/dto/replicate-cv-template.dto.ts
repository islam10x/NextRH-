import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { CvTemplateType } from "../entities/cv-template.entity";

export class ReplicateCvTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  templateName?: string;

  @IsOptional()
  @IsEnum(CvTemplateType)
  templateType?: CvTemplateType;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;
}
