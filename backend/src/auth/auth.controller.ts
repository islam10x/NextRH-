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
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { InvitationsService } from './invitations.service';
import { LoginDto } from './dto/login.dto';
import { InviteDto } from './dto/invite.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';

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
    async login(@Body() loginDto: LoginDto) {
        return this.authService.login(loginDto);
    }

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    async refresh(@Body('refresh_token') refreshToken: string) {
        return this.authService.refreshToken(refreshToken);
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    async logout(@CurrentUser() user: any) {
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
