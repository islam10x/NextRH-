import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User, UserRole, UserStatus } from "../users/entities/user.entity";
import { UsersService } from "../users/users.service";
import { TeamsService } from "../teams/teams.service";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * Team membership management. Accounts come from the corporate LDAP (via
 * Keycloak), so this no longer creates passwords, invitation tokens or setup
 * emails. "Inviting" an employee just means adding them to the manager's team:
 *  - if they already logged in (exist locally) → ensure membership;
 *  - if not → create a pending placeholder row that the JIT provisioning
 *    activates (and links to keycloak_sub) on their first login.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private usersService: UsersService,
    private teamsService: TeamsService,
    private notificationsService: NotificationsService,
  ) {}

  async inviteEmployee(email: string, role: string, invitedByUserId: string) {
    const manager = await this.usersRepository.findOne({
      where: { user_id: invitedByUserId },
    });
    const isTeamManager = manager?.role === UserRole.TEAM_MANAGER;
    const managerName = manager
      ? `${manager.firstName || ""} ${manager.lastName || ""}`.trim() ||
        manager.email
      : "your manager";

    const existingUser = await this.usersService.findByEmail(email);

    // Case 1: the user already exists locally (already logged in once).
    if (existingUser) {
      if (existingUser.status === UserStatus.DEACTIVATED) {
        throw new BadRequestException("User account is disabled");
      }
      if (isTeamManager) {
        await this.teamsService.ensureMembership(
          invitedByUserId,
          existingUser.user_id,
        );
        await this.notificationsService.create({
          userId: existingUser.user_id,
          type: "team_added",
          title: `Added to ${managerName}'s Team`,
          message: `You have been added to ${managerName}'s team.`,
        });
      }
      return { message: "User added to your team" };
    }

    // Case 2: unknown user → pending placeholder, no password. Their LDAP
    // account already exists; the JIT provisioning will activate this row
    // (matched by email) and fill keycloak_sub on their first login.
    const newUser = this.usersRepository.create({
      email,
      role: role as UserRole,
      status: UserStatus.PENDING_INVITATION,
      invitedBy: invitedByUserId,
      invitedAt: new Date(),
    });
    const savedUser = await this.usersRepository.save(newUser);

    if (isTeamManager) {
      await this.teamsService.ensureMembership(
        invitedByUserId,
        savedUser.user_id,
      );
    }

    return {
      message: "Employee added — they will gain access at their first login",
    };
  }

  /** Remove a pending placeholder (e.g. wrong email / no longer needed). */
  async cancelInvitation(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { user_id: userId },
    });
    if (!user) throw new NotFoundException("User not found");
    if (user.status !== UserStatus.PENDING_INVITATION) {
      throw new BadRequestException("Only pending entries can be removed");
    }

    await this.usersRepository.delete(userId);
    return { message: "Pending entry removed" };
  }
}
