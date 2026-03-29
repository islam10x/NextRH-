import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { User, UserStatus } from '../users/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthSession } from './entities/auth-session.entity';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

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
        avatarUrl?: string | null;
    };
}

export interface SessionTokenResponse extends AccessTokenResponse {
    refresh_token: string;
    session_id: string;
}

/** @deprecated use AccessTokenResponse — kept for internal use only */
export type AuthResponse = AccessTokenResponse;

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,
        @InjectRepository(AuthSession)
        private readonly sessionRepo: Repository<AuthSession>,
    ) { }

    async login(
        loginDto: LoginDto,
        meta?: { userAgent?: string; ipAddress?: string },
    ): Promise<{ accessToken: string; refreshToken: string; sessionId: string; user: AccessTokenResponse['user'] }> {
        const user = await this.validateUser(loginDto.email, loginDto.password);

        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('Account is inactive or pending invitation');
        }

        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshTokenValue();
        const session = await this.createSession(user, refreshToken, meta);

        return {
            accessToken,
            refreshToken,
            sessionId: session.session_id,
            user: {
                id: user.user_id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                avatarUrl: this.usersService.getAvatarUrl(user.avatarPath),
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

    private generateRefreshTokenValue(): string {
        return randomBytes(48).toString('hex');
    }

    private async createSession(
        user: User,
        refreshToken: string,
        meta?: { userAgent?: string; ipAddress?: string },
    ): Promise<AuthSession> {
        const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const session = this.sessionRepo.create({
            user,
            refreshTokenHash,
            userAgent: meta?.userAgent || null,
            ipAddress: meta?.ipAddress || null,
            lastUsedAt: new Date(),
            expiresAt,
        });
        return this.sessionRepo.save(session);
    }

    async refreshToken(
        sessionId: string,
        refreshToken: string,
        meta?: { userAgent?: string; ipAddress?: string },
    ): Promise<SessionTokenResponse> {
        try {
            const session = await this.sessionRepo.findOne({
                where: { session_id: sessionId },
                relations: ['user'],
            });

            if (!session || !session.user) {
                throw new UnauthorizedException('Invalid or expired refresh token');
            }

            if (session.revokedAt) {
                throw new UnauthorizedException('Session has been revoked');
            }

            if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
                throw new UnauthorizedException('Session has expired');
            }

            const isMatching = await bcrypt.compare(refreshToken, session.refreshTokenHash || '');
            if (!isMatching) {
                throw new UnauthorizedException('Invalid or expired refresh token');
            }

            if (session.user.status !== UserStatus.ACTIVE) {
                throw new UnauthorizedException('Account is inactive or pending invitation');
            }

            const newRefreshToken = this.generateRefreshTokenValue();
            session.refreshTokenHash = await bcrypt.hash(newRefreshToken, 10);
            session.lastUsedAt = new Date();
            session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            session.userAgent = meta?.userAgent || session.userAgent || null;
            session.ipAddress = meta?.ipAddress || session.ipAddress || null;
            await this.sessionRepo.save(session);

            return {
                access_token: this.generateAccessToken(session.user),
                refresh_token: newRefreshToken,
                session_id: session.session_id,
                user: {
                    id: session.user.user_id,
                    email: session.user.email,
                    firstName: session.user.firstName,
                    lastName: session.user.lastName,
                    role: session.user.role,
                    avatarUrl: this.usersService.getAvatarUrl(session.user.avatarPath),
                },
            };
        } catch (error) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
    }

    async logout(user: any, sessionId?: string) {
        if (sessionId) {
            await this.sessionRepo.update(
                { session_id: sessionId },
                { revokedAt: new Date() },
            );
            return { message: 'Logged out successfully' };
        }

        if (user?.user_id || user?.id) {
            await this.sessionRepo.createQueryBuilder()
                .update(AuthSession)
                .set({ revokedAt: new Date() })
                .where('user_id = :userId', { userId: user.user_id || user.id })
                .execute();
        }
        return { message: 'Logged out successfully' };
    }
}
