import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class GenerateCvDto {
    @IsUUID()
    employeeId: string;

    @IsUUID()
    templateId: string;

    @IsOptional()
    @IsIn(['en', 'fr'])
    language?: 'en' | 'fr';

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

    @IsOptional()
    @IsIn(['primary', 'fallback'])
    engine?: 'primary' | 'fallback';
}
