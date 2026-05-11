import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { User, UserRole } from '../users/entities/user.entity';

@Injectable()
export class TeamsService {
    constructor(
        @InjectRepository(Team)
        private readonly teamRepo: Repository<Team>,
        @InjectRepository(TeamMember)
        private readonly teamMemberRepo: Repository<TeamMember>,
        @InjectRepository(EmployeeProfile)
        private readonly profileRepo: Repository<EmployeeProfile>,
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
    ) { }

    private normalizeTeamName(value: string): string {
        return String(value || '')
            .trim()
            .replace(/\s+/g, ' ');
    }

    private defaultTeamNameForManager(manager?: User | null): string {
        const firstName = (manager?.firstName || '').trim();
        if (firstName) return `${firstName}'s Team`;
        return 'Team';
    }

    private async findOrCreateManagerTeam(managerUserId: string, manager?: User | null): Promise<Team> {
        let team = await this.teamRepo.findOne({
            where: { manager: { user_id: managerUserId } },
            relations: ['manager'],
        });

        if (!team) {
            team = this.teamRepo.create({
                teamName: this.defaultTeamNameForManager(manager),
                manager: { user_id: managerUserId } as any,
            });
            team = await this.teamRepo.save(team);
        }

        return team;
    }

    async getManagerTeam(managerUserId: string) {
        const manager = await this.userRepo.findOne({ where: { user_id: managerUserId } });
        if (!manager || manager.role !== UserRole.TEAM_MANAGER) {
            throw new BadRequestException('Only team managers can manage team settings');
        }

        const team = await this.findOrCreateManagerTeam(managerUserId, manager);
        return {
            teamId: team.team_id,
            teamName: team.teamName,
            teamFocus: team.teamFocus ?? null,
            managerId: managerUserId,
        };
    }

    async updateManagerTeam(managerUserId: string, teamName: string, teamFocus?: string | null) {
        const manager = await this.userRepo.findOne({ where: { user_id: managerUserId } });
        if (!manager || manager.role !== UserRole.TEAM_MANAGER) {
            throw new BadRequestException('Only team managers can manage team settings');
        }

        const normalized = this.normalizeTeamName(teamName);
        if (normalized.length < 2 || normalized.length > 80) {
            throw new BadRequestException('Team name must be between 2 and 80 characters');
        }

        const normalizedFocus = teamFocus != null
            ? String(teamFocus).trim().replace(/\s+/g, ' ').slice(0, 120) || null
            : null;

        const team = await this.findOrCreateManagerTeam(managerUserId, manager);
        team.teamName = normalized;
        team.teamFocus = normalizedFocus;
        const saved = await this.teamRepo.save(team);

        return {
            teamId: saved.team_id,
            teamName: saved.teamName,
            teamFocus: saved.teamFocus ?? null,
            managerId: managerUserId,
        };
    }

    /** Kept for backward compat — delegates to updateManagerTeam */
    async updateManagerTeamName(managerUserId: string, teamName: string) {
        return this.updateManagerTeam(managerUserId, teamName, undefined);
    }

    async getTeamInfoForEmployee(memberUserId: string) {
        // Find the team the employee belongs to
        const member = await this.teamMemberRepo.findOne({
            where: { employee: { user_id: memberUserId } },
            relations: ['team', 'team.manager'],
        });
        if (!member?.team) return null;
        return {
            teamId: member.team.team_id,
            teamName: member.team.teamName,
            teamFocus: member.team.teamFocus ?? null,
            managerName: member.team.manager
                ? `${member.team.manager.firstName || ''} ${member.team.manager.lastName || ''}`.trim() || member.team.manager.email
                : null,
        };
    }

    async getMembersForManager(managerUserId: string) {
        const team = await this.teamRepo.findOne({
            where: { manager: { user_id: managerUserId } },
        });

        if (!team) {
            throw new NotFoundException('No team found for this manager');
        }

        // join members and fetch profile_id
        const rows = await this.teamMemberRepo
            .createQueryBuilder('tm')
            .innerJoinAndSelect('tm.employee', 'u')
            .innerJoinAndSelect('tm.team', 't')
            .leftJoin(EmployeeProfile, 'ep', 'ep.user_id = u.user_id')
            .where('t.team_id = :teamId', { teamId: team.team_id })
            .select([
                'tm.team_member_id as team_member_id',
                'u.user_id as user_id',
                'u.first_name as first_name',
                'u.last_name as last_name',
                'u.email as email',
                'ep.profile_id as profile_id',
            ])
            .getRawMany();

        return rows.map((r) => ({
            teamMemberId: r.team_member_id,
            userId: r.user_id,
            firstName: r.first_name,
            lastName: r.last_name,
            email: r.email,
            profileId: r.profile_id,
        }));
    }

    async countAll(): Promise<number> {
        return this.teamRepo.count();
    }

    async listAllWithMembers(): Promise<{ teamId: string; teamName: string; memberUserIds: string[] }[]> {
        const teams = await this.teamRepo.find({ relations: ['members', 'members.employee'] });
        return teams.map((t) => ({
            teamId: t.team_id,
            teamName: t.teamName || 'Team',
            memberUserIds: (t.members || []).map((m) => m.employee?.user_id).filter(Boolean) as string[],
        }));
    }

    async getTeamIdForManager(managerUserId: string): Promise<string | null> {
        const team = await this.teamRepo.findOne({
            where: { manager: { user_id: managerUserId } },
        });

        return team?.team_id || null;
    }

    async getTeamIdForEmployee(employeeUserId: string): Promise<string | null> {
        const row = await this.teamMemberRepo
            .createQueryBuilder('tm')
            .where('tm.employee_id = :employeeUserId', { employeeUserId })
            .select('tm.team_id', 'team_id')
            .getRawOne();

        return row?.team_id || null;
    }

    async getManagersForEmployee(employeeUserId: string): Promise<string[]> {
        const rows = await this.teamMemberRepo
            .createQueryBuilder('tm')
            .innerJoin('tm.team', 't')
            .innerJoin('t.manager', 'm')
            .where('tm.employee_id = :emp', { emp: employeeUserId })
            .select(['m.user_id as manager_id'])
            .getRawMany();
        return rows.map((r) => r.manager_id);
    }

    async isProfileInManagerTeam(managerUserId: string, profileId: string): Promise<boolean> {
        const row = await this.profileRepo
            .createQueryBuilder('ep')
            .innerJoin('team_members', 'tm', 'tm.employee_id = ep.user_id')
            .innerJoin('teams', 't', 't.team_id = tm.team_id')
            .where('t.manager_id = :managerId', { managerId: managerUserId })
            .andWhere('ep.profile_id = :profileId', { profileId })
            .select('ep.profile_id', 'profile_id')
            .getRawOne();
        return Boolean(row?.profile_id);
    }

    async listOtherTeamsForManager(managerUserId: string) {
        const rows = await this.teamRepo
            .createQueryBuilder('t')
            .innerJoin('t.manager', 'm')
            .where('m.user_id != :managerId', { managerId: managerUserId })
            .select([
                't.team_id as team_id',
                't.team_name as team_name',
                'm.user_id as manager_id',
                'm.first_name as manager_first_name',
                'm.last_name as manager_last_name',
                'm.email as manager_email',
            ])
            .orderBy('t.team_name', 'ASC')
            .getRawMany();

        return rows.map((row) => ({
            teamId: row.team_id,
            teamName: row.team_name || 'Team',
            managerId: row.manager_id,
            managerName:
                [row.manager_first_name, row.manager_last_name]
                    .filter(Boolean)
                    .join(' ')
                    .trim() || row.manager_email,
            managerEmail: row.manager_email,
        }));
    }

    async getTeamNameForManager(managerUserId: string): Promise<string> {
        const team = await this.teamRepo.findOne({
            where: { manager: { user_id: managerUserId } },
            relations: ['manager'],
        });
        if (team?.teamName?.trim()) return team.teamName.trim();

        const manager = await this.userRepo.findOne({ where: { user_id: managerUserId } });
        return this.defaultTeamNameForManager(manager);
    }

    async getTeamNamesForManagers(managerUserIds: string[]): Promise<Map<string, string>> {
        const ids = Array.from(new Set(managerUserIds.filter(Boolean)));
        const result = new Map<string, string>();
        if (!ids.length) return result;

        const teams = await this.teamRepo.find({
            where: ids.map((id) => ({ manager: { user_id: id } })),
            relations: ['manager'],
        });
        for (const team of teams) {
            const managerId = team.manager?.user_id;
            if (managerId && team.teamName?.trim()) {
                result.set(managerId, team.teamName.trim());
            }
        }

        const missing = ids.filter((id) => !result.has(id));
        if (missing.length) {
            const managers = await this.userRepo.find({ where: { user_id: In(missing) } });
            for (const manager of managers) {
                result.set(manager.user_id, this.defaultTeamNameForManager(manager));
            }
        }

        return result;
    }

    async getTeamNamesForManagerEmails(managerEmails: string[]): Promise<Map<string, string>> {
        const emails = Array.from(
            new Set(
                managerEmails
                    .map((value) => String(value || '').trim().toLowerCase())
                    .filter(Boolean),
            ),
        );
        const result = new Map<string, string>();
        if (!emails.length) return result;

        const managers = await this.userRepo.find({ where: { email: In(emails) } });
        const teamNamesByManagerId = await this.getTeamNamesForManagers(managers.map((m) => m.user_id));
        for (const manager of managers) {
            result.set(
                manager.email,
                teamNamesByManagerId.get(manager.user_id) || this.defaultTeamNameForManager(manager),
            );
        }

        for (const email of emails) {
            if (!result.has(email)) {
                result.set(email, 'Team');
            }
        }

        return result;
    }

    async ensureMembership(managerUserId: string, employeeUserId: string): Promise<void> {
        const manager = await this.userRepo.findOne({ where: { user_id: managerUserId } });
        if (!manager || manager.role !== UserRole.TEAM_MANAGER) {
            // Only team managers own teams
            return;
        }

        // 1. Find or create the Team for this manager
        const team = await this.findOrCreateManagerTeam(managerUserId, manager);

        // 2. Check if the team member row already exists
        const existingMember = await this.teamMemberRepo.findOne({
            where: {
                team: { team_id: team.team_id },
                employee: { user_id: employeeUserId },
            },
        });

        // 3. If not, create it
        if (!existingMember) {
            const newMember = this.teamMemberRepo.create({
                team: { team_id: team.team_id } as any,
                employee: { user_id: employeeUserId } as any,
                joinedDate: new Date().toISOString().split('T')[0],
            });
            await this.teamMemberRepo.save(newMember);
        }
    }
}
