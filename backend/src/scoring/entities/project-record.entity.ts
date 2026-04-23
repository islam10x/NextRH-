import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

@Entity('project_records')
export class ProjectRecord {
  @PrimaryGeneratedColumn('uuid')
  record_id: string;

  @ManyToOne(() => EmployeeProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: EmployeeProfile;

  @Column({ name: 'profile_id', type: 'uuid' })
  profileId: string;

  @Column({ name: 'project_name', length: 255 })
  projectName: string;

  @Column({ name: 'client_name', length: 255, nullable: true })
  clientName: string;

  @Column({ name: 'project_description', type: 'text', nullable: true })
  projectDescription: string;

  @Column({ name: 'completion_date', type: 'date', nullable: true })
  completionDate: Date;

  @Column({
    type: 'enum',
    enum: ['low', 'medium', 'high'],
    default: 'medium',
  })
  complexity: 'low' | 'medium' | 'high';

  @Column({ name: 'pv_verified', type: 'boolean', default: false })
  pvVerified: boolean;

  @Column({ name: 'individual_score', type: 'decimal', precision: 5, scale: 2, nullable: true })
  individualScore: number | null;

  @Column({
    name: 'evaluation_status',
    type: 'enum',
    enum: ['scored_by_own_manager', 'pending_external_manager', 'scored_by_home_manager'],
    default: 'scored_by_own_manager',
  })
  evaluationStatus: 'scored_by_own_manager' | 'pending_external_manager' | 'scored_by_home_manager';

  @Column({ name: 'external_contribution_description', type: 'text', nullable: true })
  externalContributionDescription: string | null;

  @Column({ name: 'external_home_manager_id', type: 'uuid', nullable: true })
  externalHomeManagerId: string | null;

  @Column({ name: 'evaluated_by_manager_id', type: 'uuid', nullable: true })
  evaluatedByManagerId: string | null;

  @Column({ name: 'evaluated_at', type: 'timestamp', nullable: true })
  evaluatedAt: Date | null;

  @Column({ name: 'submitted_by', type: 'uuid', nullable: true })
  submittedBy: string;

  @Column({ name: 'document_hash', length: 128, nullable: true })
  documentHash: string;

  @Column({ name: 'source_filename', length: 512, nullable: true })
  sourceFilename: string;

  @Column({ name: 'parsed_data', type: 'jsonb', nullable: true })
  parsedData: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
