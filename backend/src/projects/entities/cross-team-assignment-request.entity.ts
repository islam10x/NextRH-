import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Project } from './project.entity';
import { Team } from '../../teams/entities/team.entity';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

export type CrossTeamRequestStatus = 'pending' | 'approved' | 'rejected';

@Entity('cross_team_assignment_requests')
export class CrossTeamAssignmentRequest {
  @PrimaryGeneratedColumn('uuid')
  request_id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Team, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_team_id' })
  targetTeam: Team;

  @Column({ name: 'target_team_id', type: 'uuid' })
  targetTeamId: string;

  @Column({ name: 'requesting_manager_id', type: 'uuid' })
  requestingManagerId: string;

  @Column({ name: 'target_manager_id', type: 'uuid' })
  targetManagerId: string;

  @ManyToOne(() => EmployeeProfile, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'selected_profile_id' })
  selectedProfile?: EmployeeProfile | null;

  @Column({ name: 'selected_profile_id', type: 'uuid', nullable: true })
  selectedProfileId: string | null;

  @Column({
    type: 'enum',
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  })
  status: CrossTeamRequestStatus;

  @Column({ name: 'request_note', type: 'text', nullable: true })
  requestNote: string | null;

  @Column({ name: 'response_note', type: 'text', nullable: true })
  responseNote: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'responded_at', type: 'timestamp', nullable: true })
  respondedAt: Date | null;
}
