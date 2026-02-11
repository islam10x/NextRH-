import { IsEmail, IsEnum, IsNotEmpty } from 'class-validator';
import { UserRole } from '../../users/entities/user.entity';

export class InviteDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsEnum(UserRole)
    @IsNotEmpty()
    role: UserRole;
}
