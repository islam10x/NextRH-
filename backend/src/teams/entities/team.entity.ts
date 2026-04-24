import { Column, Entity, OneToMany, ManyToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { TeamMember } from './team-member.entity';

@Entity('teams')
export class Team {
    @PrimaryGeneratedColumn('uuid')
    team_id: string;

    @Column({ name: 'team_name' })
    teamName: string;

    @Column({ name: 'team_focus', nullable: true, type: 'varchar', length: 120 })
    teamFocus: string | null;

    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: 'manager_id' })
    manager?: User | null;

    @OneToMany(() => TeamMember, (tm) => tm.team)
    members: TeamMember[];
}
