import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';

@Module({
    imports: [TypeOrmModule.forFeature([Team, TeamMember, EmployeeProfile])],
    controllers: [TeamsController],
    providers: [TeamsService],
    exports: [TeamsService],
})
export class TeamsModule { }
