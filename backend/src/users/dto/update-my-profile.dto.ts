import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMyProfileDto {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    firstName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    lastName?: string;
}
