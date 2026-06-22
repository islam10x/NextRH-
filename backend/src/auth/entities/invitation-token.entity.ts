import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("invitation_tokens")
export class InvitationToken {
  @PrimaryGeneratedColumn("uuid")
  token_id: string;

  @Column({ name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ name: "token_hash" })
  tokenHash: string;

  @Column({ name: "expires_at" })
  expiresAt: Date;

  @Column({ name: "is_used", default: false })
  isUsed: boolean;

  @Column({ name: "used_at", nullable: true })
  usedAt: Date;

  @Column({ name: "created_by", nullable: true })
  createdBy: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
