import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { UsersModule } from "../users/users.module";
import { TeamsModule } from "../teams/teams.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvitationsService } from "./invitations.service";
import { User } from "../users/entities/user.entity";

/**
 * Token issuance/verification is delegated to Keycloak (OIDC). This module only
 * verifies incoming Keycloak JWTs (JwtStrategy → JWKS) and keeps the invitation
 * flow. No local JWT signing, sessions or password-reset anymore.
 */
@Module({
  imports: [
    forwardRef(() => UsersModule),
    TeamsModule,
    NotificationsModule,
    PassportModule,
    TypeOrmModule.forFeature([User]),
  ],
  controllers: [AuthController],
  providers: [InvitationsService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [InvitationsService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
