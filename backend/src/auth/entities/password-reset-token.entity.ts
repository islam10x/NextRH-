import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("password_reset_tokens")
export class PasswordResetToken {
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
  usedAt: Date | null;

  @Column({ name: "requested_ip", nullable: true })
  requestedIp?: string | null;

  @Column({ name: "requested_user_agent", type: "text", nullable: true })
  requestedUserAgent?: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
