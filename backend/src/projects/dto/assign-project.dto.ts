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

    /** Default role for assignees (used when roles map doesn't specify) */
    @IsString()
    @IsOptional()
    role?: string;

    @IsString()
    @IsOptional()
    complexity?: string;

    /** Per-employee roles: { profileId: role } — overrides the default role */
    @IsOptional()
    roles?: Record<string, string>;
}
