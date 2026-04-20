import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('scoring_weights')
export class ScoringWeight {
  @PrimaryGeneratedColumn('uuid')
  weight_id: string;

  @Column({ name: 'team_id', type: 'uuid', nullable: true, unique: true })
  teamId: string | null;

  @Column({
    name: 'project_weight',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0.35,
  })
  projectWeight: number;

  @Column({
    name: 'certification_weight',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0.25,
  })
  certificationWeight: number;

  @Column({
    name: 'training_weight',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0.20,
  })
  trainingWeight: number;

  @Column({
    name: 'formation_weight',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0.20,
  })
  formationWeight: number;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
