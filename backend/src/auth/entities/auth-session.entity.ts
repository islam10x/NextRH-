import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('auth_sessions')
export class AuthSession {
    @PrimaryGeneratedColumn('uuid')
    session_id: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'refresh_token_hash' })
    refreshTokenHash: string;

    @Column({ name: 'user_agent', type: 'text', nullable: true })
    userAgent?: string | null;

    @Column({ name: 'ip_address', nullable: true })
    ipAddress?: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
    lastUsedAt?: Date | null;

    @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
    expiresAt?: Date | null;

    @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
    revokedAt?: Date | null;
}
