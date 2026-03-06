import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { User, UserStatus } from '../users/entities/user.entity';

export interface JwtPayload {
    sub: string;
    email: string;
    role: string;
}

export interface AccessTokenResponse {
    access_token: string;
    user: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
    };
}

/** @deprecated use AccessTokenResponse — kept for internal use only */
export type AuthResponse = AccessTokenResponse;

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,
    ) { }

    async login(loginDto: LoginDto): Promise<{ accessToken: string; refreshToken: string; user: AccessTokenResponse['user'] }> {
        const user = await this.validateUser(loginDto.email, loginDto.password);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Account is inactive or pending invitation');
        }

        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken(user);
        await this.usersService.setCurrentRefreshToken(refreshToken, user.user_id);

        return {
            accessToken,
            refreshToken,
            user: {
                id: user.user_id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
            },
        };
    }

    async validateUser(email: string, password: string): Promise<User | null> {
        const user = await this.usersService.findByEmail(email);

        if (!user || !user.password) {
            return null;
        }

        const isPasswordValid = await this.usersService.validatePassword(
            password,
            user.password,
        );

        if (!isPasswordValid) {
            return null;
        }

        return user;
    }

    generateAccessToken(user: User): string {
        const payload: JwtPayload = {
            sub: user.user_id,
            email: user.email,
            role: user.role,
        };
        return this.jwtService.sign(payload, { expiresIn: '15m' });
    }

    generateRefreshToken(user: User): string {
        const payload: JwtPayload = {
            sub: user.user_id,
            email: user.email,
            role: user.role,
        };
        return this.jwtService.sign(payload, { expiresIn: '7d' });
    }

    async refreshToken(cookieToken: string): Promise<AccessTokenResponse> {
        try {
            const payload = this.jwtService.verify(cookieToken);
            const user = await this.usersService.getUserIfRefreshTokenMatches(cookieToken, payload.sub);

            if (!user || user.status !== UserStatus.ACTIVE) {
                throw new UnauthorizedException('Account is inactive or pending invitation');
            }

            // Rotate: issue new refresh token and update DB
            const newRefreshToken = this.generateRefreshToken(user);
            await this.usersService.setCurrentRefreshToken(newRefreshToken, user.user_id);

            return {
                access_token: this.generateAccessToken(user),
                // newRefreshToken is returned so the controller can set the cookie
                // We store it on the object for the controller to read
                ...(newRefreshToken && { _refreshToken: newRefreshToken } as any),
                user: {
                    id: user.user_id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    role: user.role,
                },
            };
        } catch (error) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
    }

    async logout(user: any) {
        await this.usersService.removeRefreshToken(user.user_id || user.id);
        return { message: 'Logged out successfully' };
    }
}
