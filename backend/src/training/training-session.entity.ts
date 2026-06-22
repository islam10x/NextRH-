import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { User } from "../users/entities/user.entity";
import { Project } from "../projects/entities/project.entity";

export type TrainingStatus = "assigned" | "in_progress" | "completed";

@Entity("training_sessions")
export class TrainingSession {
  @PrimaryGeneratedColumn("uuid")
  training_id: string;

  @ManyToOne(() => EmployeeProfile, { eager: true, onDelete: "CASCADE" })
  @JoinColumn({ name: "profile_id" })
  profile: EmployeeProfile;

  @Column({ name: "assigned_by", nullable: true })
  assignedBy?: string | null;

  @Column({ name: "training_title" })
  trainingTitle: string;

  @Column({ name: "provider", nullable: true })
  provider?: string | null;

  @Column({ name: "training_url", nullable: true, type: "text" })
  trainingUrl?: string | null;

  @Column({ name: "due_date", type: "date", nullable: true })
  dueDate?: string | null;

  @Column({
    name: "status",
    type: "enum",
    enum: ["assigned", "in_progress", "completed"],
    default: "assigned",
  })
  status: TrainingStatus;

  @Column({ name: "proof_file_path", nullable: true, length: 512 })
  proofFilePath?: string | null;

  @Column({ name: "start_date", type: "date", nullable: true })
  startDate?: string | null;

  @Column({ name: "end_date", type: "date", nullable: true })
  endDate?: string | null;

  @Column({ name: "duration_hours", type: "int", nullable: true })
  durationHours?: number | null;

  @Column({ name: "description", type: "text", nullable: true })
  description?: string | null;

  @ManyToOne(() => Project, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "related_project_id" })
  relatedProject?: Project | null;

  @Column({ name: "related_project_id", nullable: true })
  relatedProjectId?: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
