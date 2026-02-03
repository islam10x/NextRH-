import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        private readonly configService: ConfigService,
        private readonly usersService: UsersService,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<string>('JWT_SECRET') || 'your-super-secret-jwt-key',
        });
    }

    async validate(payload: JwtPayload) {
        const user = await this.usersService.findById(payload.sub);

        if (!user || !user.isActive) {
            throw new UnauthorizedException();
        }

        return {
            id: user.user_id,
            email: user.email,
            role: user.role,
        };
    }
}
