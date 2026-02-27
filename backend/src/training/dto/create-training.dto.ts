import { IsArray, IsDateString, IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';

export class CreateTrainingDto {
    @IsString()
    @MaxLength(255)
    trainingTitle: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    provider?: string;

    @IsOptional()
    @IsUrl()
    trainingUrl?: string;

    @IsOptional()
    @IsDateString()
    dueDate?: string;

    @IsArray()
    @IsUUID('4', { each: true })
    assigneeProfileIds: string[];

    @IsOptional()
    @IsString()
    description?: string;
}
