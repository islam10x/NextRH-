import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

@Entity('employee_scores')
export class EmployeeScore {
  @PrimaryGeneratedColumn('uuid')
  score_id: string;

  @ManyToOne(() => EmployeeProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: EmployeeProfile;

  @Column({ name: 'profile_id', type: 'uuid' })
  profileId: string;

  @Column({ name: 'score_year', type: 'int' })
  scoreYear: number;

  @Column({
    name: 'project_score',
    type: 'decimal',
    precision: 8,
    scale: 2,
    default: 0,
  })
  projectScore: number;

  @Column({
    name: 'certification_score',
    type: 'decimal',
    precision: 8,
    scale: 2,
    default: 0,
  })
  certificationScore: number;

  @Column({
    name: 'training_score',
    type: 'decimal',
    precision: 8,
    scale: 2,
    default: 0,
  })
  trainingScore: number;

  @Column({
    name: 'formation_score',
    type: 'decimal',
    precision: 8,
    scale: 2,
    default: 0,
  })
  formationScore: number;

  @Column({
    name: 'final_score',
    type: 'decimal',
    precision: 8,
    scale: 2,
    default: 0,
  })
  finalScore: number;

  @Column({ name: 'rank_in_team', type: 'int', nullable: true })
  rankInTeam: number;

  @Column({ name: 'rank_global', type: 'int', nullable: true })
  rankGlobal: number;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
  })
  percentile: number;

  @Column({ name: 'score_details', type: 'jsonb', nullable: true })
  scoreDetails: Record<string, any>;

  @CreateDateColumn({ name: 'computed_at' })
  computedAt: Date;
}
