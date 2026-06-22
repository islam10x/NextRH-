import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from "typeorm";
import { EmployeeProfile } from "../../employees/entities/employee-profile.entity";

@Entity("training_records")
export class TrainingRecord {
  @PrimaryGeneratedColumn("uuid")
  record_id: string;

  @ManyToOne(() => EmployeeProfile, { onDelete: "CASCADE" })
  @JoinColumn({ name: "profile_id" })
  profile: EmployeeProfile;

  @Column({ name: "profile_id", type: "uuid" })
  profileId: string;

  @Column({ name: "training_name", length: 255 })
  trainingName: string;

  @Column({ name: "trainer_name", length: 255, nullable: true })
  trainerName: string;

  @Column({ name: "client_name", length: 255, nullable: true })
  clientName: string;

  @Column({ length: 255, nullable: true })
  location: string;

  @Column({ name: "start_date", type: "date", nullable: true })
  startDate: Date;

  @Column({ name: "end_date", type: "date", nullable: true })
  endDate: Date;

  @Column({ name: "participant_count", type: "int", default: 0 })
  participantCount: number;

  @Column({ name: "document_hash", length: 128, nullable: true })
  documentHash: string;

  @Column({ name: "source_filename", length: 512, nullable: true })
  sourceFilename: string;

  @Column({ name: "parsed_data", type: "jsonb", nullable: true })
  parsedData: Record<string, any>;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
