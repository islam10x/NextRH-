import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

export enum CvTemplateType {
  STANDARD = "standard",
  CANADIAN = "canadian",
  EU = "eu",
  CLIENT_SPECIFIC = "client_specific",
}

@Entity("cv_templates")
export class CvTemplate {
  @PrimaryGeneratedColumn("uuid")
  template_id: string;

  @Column({ name: "template_name", length: 255 })
  templateName: string;

  @Column({
    name: "template_type",
    type: "enum",
    enum: CvTemplateType,
    default: CvTemplateType.CLIENT_SPECIFIC,
  })
  templateType: CvTemplateType;

  @Column({ name: "language", length: 10, nullable: true })
  language?: string | null;

  @Column({ name: "file_path", length: 512, nullable: true })
  filePath?: string | null;

  @Column({ name: "original_filename", length: 255, nullable: true })
  originalFilename?: string | null;

  @Column({ name: "field_mapping", type: "jsonb", nullable: true })
  fieldMapping?: Record<string, string> | null;

  @Column({ name: "detected_fields", type: "jsonb", nullable: true })
  detectedFields?: string[] | null;

  @Column({ name: "file_hash", length: 64, nullable: true })
  fileHash?: string | null;

  @Column({ name: "usage_count", type: "int", default: 0 })
  usageCount: number;

  @Column({ name: "last_used_at", type: "timestamp", nullable: true })
  lastUsedAt?: Date | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: "uploaded_by" })
  uploadedBy?: User | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
