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
        enum: ['active', 'pending_invitation', 'deactivated'],
        default: 'pending_invitation',
    })
    status: 'active' | 'pending_invitation' | 'deactivated';

    @Column({ name: 'first_name', nullable: true })
    firstName: string;

    @Column({ name: 'last_name', nullable: true })
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

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
