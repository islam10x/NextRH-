import {
    Controller,
    Post,
    Body,
    Get,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

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

    @Get('profile')
    @UseGuards(JwtAuthGuard)
    async getProfile(@CurrentUser() user: any) {
        return user;
    }
}
