import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignProjectDto {
    @IsString()
    @IsNotEmpty()
    projectName: string;

    @IsString()
    @IsOptional()
    clientName?: string;

    @IsString()
    @IsOptional()
    projectDescription?: string;

    @IsString()
    @IsOptional()
    startDate?: string;

    @IsString()
    @IsOptional()
    endDate?: string;

    @IsArray()
    assigneeProfileIds: string[];

    @IsArray()
    @IsOptional()
    technologies?: string[];

    @IsString()
    @IsOptional()
    role?: string;
}
