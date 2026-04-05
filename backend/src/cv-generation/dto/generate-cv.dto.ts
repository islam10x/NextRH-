import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class GenerateCvDto {
    @IsUUID()
    employeeId: string;

    @IsUUID()
    templateId: string;

    @IsOptional()
    @IsString()
    @MaxLength(10)
    language?: string;

    @IsOptional()
    @IsBoolean()
    translate?: boolean;

    @IsOptional()
    @IsArray()
    outputFormats?: Array<'docx' | 'pdf'>;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    generationPurpose?: string;
}
