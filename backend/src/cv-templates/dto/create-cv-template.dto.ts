import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CvTemplateType } from '../entities/cv-template.entity';

export class CreateCvTemplateDto {
    @IsString()
    @MaxLength(255)
    templateName: string;

    @IsEnum(CvTemplateType)
    templateType: CvTemplateType;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    language?: string;
}
