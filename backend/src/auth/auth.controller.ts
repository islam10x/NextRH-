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
import { LoginDto } from './dto/login.dto';
import { InviteDto } from './dto/invite.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    path: '/',
};

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly invitationsService: InvitationsService,
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

    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
        const { accessToken, refreshToken, user } = await this.authService.login(loginDto);
        res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTIONS);
        return { access_token: accessToken, user };
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const token: string | undefined = req.cookies?.[REFRESH_COOKIE];
        if (!token) {
            throw new UnauthorizedException('No refresh token provided');
        }
        const result = await this.authService.refreshToken(token);
        const newRefresh: string | undefined = (result as any)._refreshToken;
        if (newRefresh) {
            res.cookie(REFRESH_COOKIE, newRefresh, COOKIE_OPTIONS);
        }
        const { _refreshToken: _removed, ...response } = result as any;
        return response;
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async logout(@CurrentUser() user: any, @Res({ passthrough: true }) res: Response) {
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        return this.authService.logout(user);
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
