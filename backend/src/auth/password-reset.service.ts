import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { User, UserStatus } from '../users/entities/user.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { MailService } from '../mail/mail.service';
import { AuthSession } from './entities/auth-session.entity';

@Injectable()
export class PasswordResetService {
    private readonly logger = new Logger(PasswordResetService.name);
    private readonly tokenTtlMs = 60 * 60 * 1000; // 1 hour
    private readonly cooldownMs = 5 * 60 * 1000; // 5 minutes

    constructor(
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
        @InjectRepository(PasswordResetToken)
        private readonly resetTokenRepository: Repository<PasswordResetToken>,
        @InjectRepository(AuthSession)
        private readonly sessionRepo: Repository<AuthSession>,
        private readonly mailService: MailService,
    ) { }

    async requestPasswordReset(
        email: string,
        meta?: { userAgent?: string; ipAddress?: string },
    ) {
        const normalizedEmail = (email || '').trim().toLowerCase();
        const response = {
            message: 'If an account exists for that email, a reset link has been sent.',
        };

        if (!normalizedEmail) {
            return response;
        }

        const user = await this.usersRepository.findOne({
            where: { email: normalizedEmail },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            return response;
        }

        const cutoff = new Date(Date.now() - this.cooldownMs);
        const recentToken = await this.resetTokenRepository.findOne({
            where: {
                userId: user.user_id,
                isUsed: false,
                createdAt: MoreThan(cutoff),
            },
            order: { createdAt: 'DESC' },
        });

        if (recentToken) {
            return response;
        }

        await this.resetTokenRepository.update(
            { userId: user.user_id, isUsed: false },
            { isUsed: true, usedAt: new Date() },
        );

        const secret = randomBytes(32).toString('hex');
        const tokenHash = await bcrypt.hash(secret, 10);
        const expiresAt = new Date(Date.now() + this.tokenTtlMs);

        const token = this.resetTokenRepository.create({
            userId: user.user_id,
            tokenHash,
            expiresAt,
            requestedIp: meta?.ipAddress || null,
            requestedUserAgent: meta?.userAgent || null,
        });

        const savedToken = await this.resetTokenRepository.save(token);
        const fullToken = `${savedToken.token_id}.${secret}`;

        try {
            await this.mailService.sendPasswordResetEmail(user.email, fullToken);
        } catch (error) {
            this.logger.error(`Failed to send password reset email: ${error?.message ?? error}`);
        }

        return response;
    }

    async validateResetToken(fullToken: string) {
        const { user, token } = await this.resolveToken(fullToken);
        return {
            valid: true,
            email: user.email,
            userId: user.user_id,
            tokenId: token.token_id,
        };
    }

    async resetPassword(fullToken: string, newPassword: string) {
        const { user, token } = await this.resolveToken(fullToken);

        if (!this.isStrongPassword(newPassword)) {
            throw new BadRequestException(
                'Password must be at least 8 characters and include uppercase, lowercase, and a number.',
            );
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.status = UserStatus.ACTIVE;
        user.activatedAt = user.activatedAt || new Date();
        await this.usersRepository.save(user);

        await this.resetTokenRepository.update(token.token_id, {
            isUsed: true,
            usedAt: new Date(),
        });

        await this.sessionRepo.createQueryBuilder()
            .update(AuthSession)
            .set({ revokedAt: new Date() })
            .where('user_id = :userId', { userId: user.user_id })
            .execute();

        return { success: true, message: 'Password reset successfully' };
    }

    private async resolveToken(fullToken: string) {
        if (!fullToken || !fullToken.includes('.')) {
            throw new BadRequestException('Invalid or expired token');
        }

        const [tokenId, secret] = fullToken.split('.');
        const token = await this.resetTokenRepository.findOne({
            where: { token_id: tokenId },
            relations: ['user'],
        });

        if (!token || !token.user) {
            throw new BadRequestException('Invalid or expired token');
        }
        if (token.isUsed) {
            throw new BadRequestException('Token already used');
        }
        if (token.expiresAt.getTime() < Date.now()) {
            throw new BadRequestException('Token expired');
        }

        const isMatch = await bcrypt.compare(secret, token.tokenHash);
        if (!isMatch) {
            throw new BadRequestException('Invalid or expired token');
        }

        if (token.user.status !== UserStatus.ACTIVE) {
            throw new BadRequestException('Invalid or expired token');
        }

        return { user: token.user, token };
    }

    private isStrongPassword(password: string): boolean {
        if (!password || password.length < 8) return false;
        const hasUpper = /[A-Z]/.test(password);
        const hasLower = /[a-z]/.test(password);
        const hasNumber = /\d/.test(password);
        return hasUpper && hasLower && hasNumber;
    }
}
