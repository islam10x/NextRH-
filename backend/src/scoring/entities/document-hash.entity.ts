import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

@Entity("document_hashes")
export class DocumentHash {
  @PrimaryGeneratedColumn("uuid")
  hash_id: string;

  @Column({ name: "file_hash", length: 128, unique: true })
  fileHash: string;

  @Column({
    name: "document_type",
    type: "enum",
    enum: ["pv", "training_sheet"],
  })
  documentType: "pv" | "training_sheet";

  @Column({ name: "original_filename", length: 512, nullable: true })
  originalFilename: string;

  @Column({ name: "uploaded_by", type: "uuid", nullable: true })
  uploadedBy: string;

  @CreateDateColumn({ name: "uploaded_at" })
  uploadedAt: Date;
}
