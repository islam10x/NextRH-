import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

@Entity('scoring_targets')
export class ScoringTarget {
  @PrimaryGeneratedColumn('uuid')
  target_id: string;

  @ManyToOne(() => EmployeeProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'profile_id' })
  profile: EmployeeProfile;

  @Column({ name: 'profile_id', type: 'uuid' })
  profileId: string;

  @Column({ name: 'target_year', type: 'int' })
  targetYear: number;

  @Column({ name: 'certification_target', type: 'int', default: 2 })
  certificationTarget: number;

  @Column({ name: 'set_by', type: 'uuid', nullable: true })
  setBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
