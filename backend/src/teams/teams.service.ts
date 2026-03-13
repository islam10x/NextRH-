import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';

@Injectable()
export class TeamsService {
    constructor(
        @InjectRepository(Team)
        private readonly teamRepo: Repository<Team>,
        @InjectRepository(TeamMember)
        private readonly teamMemberRepo: Repository<TeamMember>,
        @InjectRepository(EmployeeProfile)
        private readonly profileRepo: Repository<EmployeeProfile>,
    ) { }

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

    async ensureMembership(managerUserId: string, employeeUserId: string): Promise<void> {
        // 1. Find or create the Team for this manager
        let team = await this.teamRepo.findOne({
            where: { manager: { user_id: managerUserId } },
        });

        if (!team) {
            // Get manager details for team name
            const userRepo = this.teamRepo.manager.getRepository('User');
            const manager = await userRepo.findOne({ where: { user_id: managerUserId } });
            
            let teamName = 'Team';
            if (manager && (manager as any).firstName) {
                teamName = `${(manager as any).firstName}'s Team`;
            }

            team = this.teamRepo.create({
                teamName: teamName,
                manager: { user_id: managerUserId } as any,
            });
            team = await this.teamRepo.save(team);
        }

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
