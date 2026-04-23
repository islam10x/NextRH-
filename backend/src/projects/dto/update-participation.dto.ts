import { IsOptional, IsString } from 'class-validator';

export class UpdateParticipationDto {
    @IsString()
    @IsOptional()
    description?: string;
}
