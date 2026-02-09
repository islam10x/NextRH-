import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { User } from '../users/entities/user.entity';

export interface JwtPayload {
    sub: string;
    email: string;
    role: string;
}

export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    user: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: string;
    };
}

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,
    ) { }

    async login(loginDto: LoginDto): Promise<AuthResponse> {
        const user = await this.validateUser(loginDto.email, loginDto.password);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.status !== 'active') { // Check status instead of isActive
            throw new UnauthorizedException('Account is inactive or pending invitation');
        }

        const tokens = await this.generateTokens(user);
        await this.usersService.setCurrentRefreshToken(tokens.refresh_token, user.user_id);
        return tokens;
    }

    async validateUser(email: string, password: string): Promise<User | null> {
        const user = await this.usersService.findByEmail(email);

        if (!user) {
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

    async generateTokens(user: User): Promise<AuthResponse> {
        const payload: JwtPayload = {
            sub: user.user_id,
            email: user.email,
            role: user.role,
        };

        const access_token = this.jwtService.sign(payload, {
            expiresIn: '15m',
        });

        const refresh_token = this.jwtService.sign(payload, {
            expiresIn: '7d',
        });

        return {
            access_token,
            refresh_token,
            user: {
                id: user.user_id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
            },
        };
    }

    async refreshToken(token: string): Promise<AuthResponse> {
        try {
            const payload = this.jwtService.verify(token);
            const user = await this.usersService.getUserIfRefreshTokenMatches(token, payload.sub);

            if (!user || user.status !== 'active') { // Check status instead of isActive
                throw new UnauthorizedException('Account is inactive or pending invitation');
            }

            const tokens = await this.generateTokens(user);
            await this.usersService.setCurrentRefreshToken(tokens.refresh_token, user.user_id);
            return tokens;
        } catch (error) {
            throw new UnauthorizedException('Invalid token');
        }
    }

    async logout(user: any) {
        await this.usersService.removeRefreshToken(user.user_id || user.id);
        return { message: 'Logged out successfully' };
    }
}
