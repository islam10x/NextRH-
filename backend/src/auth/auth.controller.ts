import {
    Controller,
    Post,
    Body,
    Get,
    UseGuards,
    HttpCode,
    HttpStatus,
    Query,
    Param,
    Delete,
    Res,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { InvitationsService } from './invitations.service';
import { PasswordResetService } from './password-reset.service';
import { LoginDto } from './dto/login.dto';
import { InviteDto } from './dto/invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';

const REFRESH_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly invitationsService: InvitationsService,
        private readonly passwordResetService: PasswordResetService,
    ) { }

    @Post('invite')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    @HttpCode(HttpStatus.OK)
    async invite(
        @Body() body: InviteDto,
        @CurrentUser() user: any,
    ) {
        return this.invitationsService.inviteEmployee(
            body.email,
            body.role,
            user.user_id || user.id,
        );
    }

    @Get('validate-token')
    async validateToken(@Query('token') token: string) {
        return this.invitationsService.validateToken(token);
    }

    @Post('setup-password')
    @HttpCode(HttpStatus.OK)
    async setupPassword(@Body() body: { token: string; password: string }) {
        return this.invitationsService.setupPassword(body.token, body.password);
    }

    @Post('forgot-password')
    @HttpCode(HttpStatus.OK)
    async forgotPassword(
        @Body() body: ForgotPasswordDto,
        @Req() req: Request,
    ) {
        return this.passwordResetService.requestPasswordReset(body.email, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
        });
    }

    @Get('reset/validate')
    async validateResetToken(@Query('token') token: string) {
        return this.passwordResetService.validateResetToken(token);
    }

    @Post('reset-password')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() body: ResetPasswordDto) {
        return this.passwordResetService.resetPassword(body.token, body.password);
    }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(
        @Body() loginDto: LoginDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { accessToken, refreshToken, sessionId, user } = await this.authService.login(loginDto, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
        });
        // Clear legacy cookie to avoid cross-tab collisions.
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            session_id: sessionId,
            user,
        };
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(
        @Body() body: { session_id?: string; refresh_token?: string },
        @Req() req: Request,
    ) {
        const sessionId = body?.session_id;
        const refreshToken = body?.refresh_token;
        if (!sessionId || !refreshToken) {
            throw new UnauthorizedException('No refresh token provided');
        }
        return this.authService.refreshToken(sessionId, refreshToken, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
        });
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async logout(
        @CurrentUser() user: any,
        @Body() body: { session_id?: string },
        @Res({ passthrough: true }) res: Response,
    ) {
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        return this.authService.logout(user, body?.session_id);
    }

    @Get('profile')
    @UseGuards(JwtAuthGuard)
    async getProfile(@CurrentUser() user: any) {
        return user;
    }

    @Post('invite/resend/:userId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    @HttpCode(HttpStatus.OK)
    async resendInvitation(
        @Param('userId') userId: string,
        @CurrentUser() user: any,
    ) {
        return this.invitationsService.resendInvitation(userId, user.user_id || user.id);
    }

    @Delete('invite/:userId')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
    @HttpCode(HttpStatus.OK)
    async cancelInvitation(@Param('userId') userId: string) {
        return this.invitationsService.cancelInvitation(userId);
    }
}
