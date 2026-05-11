import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Project } from './project.entity';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

export type ParticipantAssignmentType = 'internal' | 'external';

@Entity('project_participants')
export class ProjectParticipant {
  @PrimaryGeneratedColumn('uuid')
  participant_id: string;

  @ManyToOne(() => Project, (project) => project.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @ManyToOne(() => EmployeeProfile, (profile) => profile.projectParticipations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: EmployeeProfile;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'assigned_by', type: 'uuid', nullable: true })
  assignedBy: string | null;

    @Column({ type: 'text', nullable: true })
    role: string;

  @Column({ name: 'assignment_type', type: 'text', default: 'internal' })
  assignmentType: ParticipantAssignmentType;

  @Column({ name: 'home_manager_id', type: 'uuid', nullable: true })
  homeManagerId: string | null;

  @Column({ name: 'cross_team_request_id', type: 'uuid', nullable: true })
  crossTeamRequestId: string | null;
}
