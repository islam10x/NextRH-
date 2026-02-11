import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { InvitationToken } from './entities/invitation-token.entity';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class InvitationsService {
    constructor(
        @InjectRepository(User)
        private usersRepository: Repository<User>,
        @InjectRepository(InvitationToken)
        private invitationTokenRepository: Repository<InvitationToken>,
        private usersService: UsersService,
        private mailService: MailService,
    ) { }

    async inviteEmployee(email: string, role: string, invitedByUserId: string) {
        // 1. Check if user exists
        const existingUser = await this.usersService.findByEmail(email);
        if (existingUser) {
            throw new BadRequestException('User with this email already exists');
        }

        // 2. Create User (Pending)
        const newUser = this.usersRepository.create({
            email,
            role: role as UserRole,
            status: UserStatus.PENDING_INVITATION,
            invitedBy: invitedByUserId,
            invitedAt: new Date(),
            // No password, no first/last name yet
        });

        const savedUser = await this.usersRepository.save(newUser);

        // 3. Generate Secret and Hash
        const secret = uuidv4(); // This is the plain secret
        const hash = await bcrypt.hash(secret, 10);
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 48); // 48h expiry

        const invitationToken = this.invitationTokenRepository.create({
            userId: savedUser.user_id,
            tokenHash: hash,
            expiresAt,
            createdBy: invitedByUserId,
        });

        const savedToken = await this.invitationTokenRepository.save(invitationToken);

        // Concatenate tokenId and secret for the actual token sent to user
        const fullToken = `${savedToken.token_id}.${secret}`;

        // 4. Send Email (using BID Manager details)
        const manager = await this.usersRepository.findOne({ where: { user_id: invitedByUserId } });
        const senderName = manager ? `${manager.firstName} ${manager.lastName}` : undefined;
        const senderEmail = manager ? manager.email : undefined;

        try {
            await this.mailService.sendInvitationEmail(email, fullToken, senderName, senderEmail);
        } catch (error) {
            console.error('Failed to send invitation email:', error);
            // We still have the user and token in DB, but the invitation is useless without the email.
            // Optionally we could delete them here, but better to just inform the user.
            throw new BadRequestException('Failed to send invitation email. Please check SMTP configuration.');
        }

        return { message: 'Invitation sent successfully' };
    }

    async validateToken(token: string) {
        // Find all unused logical tokens (This is inefficient in prod, better storing token ID in link if possible, 
        // but requirement says link has token. We'll search or need a way to lookup. 
        // Wait, token is hashed. We can't lookup by hash. 
        // We need the token ID in the URL or the token needs to be the ID?
        // Ah, current requirement: "token=..." 
        // If token is just a random string, we can't look it up if it's hashed.
        // Unless we store the token itself? No, security.
        // Implementation Plan Step 11: "Extract token from URL... Query invitation_tokens... match found"
        // This implies iterating tokens? No, that's bad.
        // BETTER APPROACH: Token = tokenId + '.' + secret.
        // Or store the token plainly? No.
        // Let's use: Link = /setup-password?token=${tokenId}&secret=${randomString}
        // DB stores hash(secret).
        // Let's adjust logic. Token in URL will be `${tokenId}.${secret}`.

        // But let's stick to the simplest securely:
        // Token ID is UUID. Secret is random.
        // URL: ?token=TOKEN_ID.SECRET

        // My previous plan said "token=...".
        // Let's assume the input token is the UUID of the token record for simplicity if the user didn't specify format?
        // User request Step 4: "Generate random 64-character token... Hash it... Store it"
        // User request Step 11: "Query invitation_tokens where is_used=false... For each... compare"
        // THIS IS VERY SLOW. "For each token... compare".
        // I should stick to a more performant way: Token = <UUID>_<RandomSecret>. 
        // Look up by UUID, verify Secret.

        // Let's change the implementation slightly for performance but keep the spirit.
        // I will generate a token that is `userId.randomToken`.
        // Then I can look up by userId.

        // Or better: `tokenId.randomHex`.
        // I will implement `tokenId.randomHex`.

        // Let's split the token.
        // If token doesn't have a dot, it might be the old slow way.
        // I'll implement `tokenId.secret`.
        return this.validateTokenLogic(token);
    }

    private async validateTokenLogic(fullToken: string) {
        if (!fullToken.includes('.')) {
            throw new BadRequestException('Invalid token format');
        }

        const [tokenId, secret] = fullToken.split('.');

        const invitation = await this.invitationTokenRepository.findOne({
            where: { token_id: tokenId },
            relations: ['user'],
        });

        if (!invitation) throw new NotFoundException('Invitation not found');
        if (invitation.isUsed) throw new BadRequestException('Token already used');
        if (invitation.expiresAt < new Date()) throw new BadRequestException('Token expired');

        const isMatch = await bcrypt.compare(secret, invitation.tokenHash);
        if (!isMatch) throw new BadRequestException('Invalid token');

        return {
            valid: true,
            email: invitation.user.email,
            userId: invitation.user.user_id,
            tokenId: invitation.token_id
        };
    }

    async setupPassword(token: string, password: string) {
        const { userId, tokenId } = await this.validateTokenLogic(token);

        const user = await this.usersRepository.findOne({ where: { user_id: userId } });
        if (!user) throw new NotFoundException('User not found');

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Update User
        user.password = hashedPassword;
        user.status = UserStatus.ACTIVE;
        user.activatedAt = new Date();
        await this.usersRepository.save(user);

        // Update Token
        await this.invitationTokenRepository.update(tokenId, {
            isUsed: true,
            usedAt: new Date(),
        }); // simple update

        return { success: true, message: 'Password set successfully' };
    }

    async resendInvitation(userId: string, invitedByUserId: string) {
        const user = await this.usersRepository.findOne({ where: { user_id: userId } });
        if (!user) throw new NotFoundException('User not found');
        if (user.status !== UserStatus.PENDING_INVITATION) {
            throw new BadRequestException('Can only resend invitations for pending users');
        }

        // 1. Invalidate old tokens for this user
        await this.invitationTokenRepository.update({ userId, isUsed: false }, { isUsed: true });

        // 2. Generate new Secret and Hash
        const secret = uuidv4();
        const hash = await bcrypt.hash(secret, 10);
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 48);

        const invitationToken = this.invitationTokenRepository.create({
            userId,
            tokenHash: hash,
            expiresAt,
            createdBy: invitedByUserId,
        });

        const savedToken = await this.invitationTokenRepository.save(invitationToken);
        const fullToken = `${savedToken.token_id}.${secret}`;

        // 3. Send Email
        const manager = await this.usersRepository.findOne({ where: { user_id: invitedByUserId } });
        const senderName = manager ? `${manager.firstName} ${manager.lastName}` : undefined;
        const senderEmail = manager ? manager.email : undefined;

        await this.mailService.sendInvitationEmail(user.email, fullToken, senderName, senderEmail);

        return { message: 'Invitation resent successfully' };
    }

    async cancelInvitation(userId: string) {
        const user = await this.usersRepository.findOne({ where: { user_id: userId } });
        if (!user) throw new NotFoundException('User not found');
        if (user.status !== UserStatus.PENDING_INVITATION) {
            throw new BadRequestException('Only pending invitations can be cancelled');
        }

        // Delete tokens first (Cascade might handle this if configured, but let's be explicit)
        await this.invitationTokenRepository.delete({ userId });

        // Delete user
        await this.usersRepository.delete(userId);

        return { message: 'Invitation cancelled successfully' };
    }
}
