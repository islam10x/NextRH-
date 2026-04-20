import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Project } from './project.entity';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

export enum ParticipantRole {
  CONTRIBUTOR = 'contributor',
  TECHNICAL_LEAD = 'technical_lead',
  PROJECT_LEAD = 'project_lead',
}

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

    @Column({
      type: 'enum',
      enum: ParticipantRole,
      default: ParticipantRole.CONTRIBUTOR,
    })
    role: ParticipantRole;

    @Column({ type: 'text' })
    description: string;

    @Column({ name: 'assigned_by', type: 'uuid', nullable: true })
    assignedBy: string | null;
}
