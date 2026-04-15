import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
    EMPLOYEE = 'employee',
    TEAM_MANAGER = 'team_manager',
    BID_MANAGER = 'bid_manager',
}

export enum UserStatus {
    ACTIVE = 'active',
    PENDING_INVITATION = 'pending_invitation',
    DEACTIVATED = 'deactivated',
}

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    user_id: string;

    @Column({ unique: true })
    email: string;

    @Column({
        type: 'enum',
        enum: UserRole,
        default: UserRole.EMPLOYEE,
    })
    role: UserRole;

    @Column({
        type: 'enum',
        enum: UserStatus,
        default: UserStatus.PENDING_INVITATION,
    })
    status: UserStatus;

    @Column({ name: 'first_name', type: 'text', nullable: true })
    firstName: string;

    @Column({ name: 'last_name', type: 'text', nullable: true })
    lastName: string;

    @Column({ nullable: true })
    password: string;

    @Column({ name: 'invited_by', nullable: true })
    invitedBy: string;

    @Column({ name: 'invited_at', nullable: true })
    invitedAt: Date;

    @Column({ name: 'activated_at', nullable: true })
    activatedAt: Date;

    @Column({ name: 'current_hashed_refresh_token', nullable: true })
    currentHashedRefreshToken?: string;

    @Column({ name: 'avatar_path', nullable: true })
    avatarPath?: string | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
