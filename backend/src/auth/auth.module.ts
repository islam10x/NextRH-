import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { UsersModule } from "../users/users.module";
import { TeamsModule } from "../teams/teams.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvitationsService } from "./invitations.service";
import { User } from "../users/entities/user.entity";
import { InvitationToken } from "./entities/invitation-token.entity";
import { AuthSession } from "./entities/auth-session.entity";
import { PasswordResetToken } from "./entities/password-reset-token.entity";
import { PasswordResetService } from "./password-reset.service";

@Module({
  imports: [
    forwardRef(() => UsersModule),
    TeamsModule,
    NotificationsModule,
    PassportModule,
    TypeOrmModule.forFeature([
      User,
      InvitationToken,
      PasswordResetToken,
      AuthSession,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const secret = configService.get<string>("JWT_SECRET");
        if (!secret) {
          throw new Error("JWT_SECRET is required");
        }
        return {
          secret,
          signOptions: {
            expiresIn: "15m",
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    InvitationsService,
    PasswordResetService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    AuthService,
    InvitationsService,
    PasswordResetService,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
