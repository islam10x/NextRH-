import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  HttpCode,
  HttpStatus,
  Param,
  Delete,
} from "@nestjs/common";
import { InvitationsService } from "./invitations.service";
import { InviteDto } from "./dto/invite.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { Roles } from "./decorators/roles.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { UsersService } from "../users/users.service";

/**
 * Authentication is delegated to Keycloak (OIDC, LDAP-backed). This controller
 * no longer issues tokens or manages passwords/sessions. What remains:
 *  - /profile  : read the local user behind the verified token
 *  - /invite*  : add an employee to a manager's team (no account creation —
 *                accounts come from LDAP)
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly usersService: UsersService,
  ) {}

  @Post("invite")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
  @HttpCode(HttpStatus.OK)
  async invite(@Body() body: InviteDto, @CurrentUser() user: any) {
    return this.invitationsService.inviteEmployee(
      body.email,
      body.role,
      user.user_id || user.id,
    );
  }

  @Get("profile")
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: any) {
    return this.usersService.getOwnProfile(user.user_id || user.id);
  }

  @Delete("invite/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
  @HttpCode(HttpStatus.OK)
  async cancelInvitation(@Param("userId") userId: string) {
    return this.invitationsService.cancelInvitation(userId);
  }
}
