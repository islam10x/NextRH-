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

    @Column()
    password: string;

    @Column({ name: 'first_name' })
    firstName: string;

    @Column({ name: 'last_name' })
    lastName: string;

    @Column({
        type: 'enum',
        enum: UserRole,
        default: UserRole.EMPLOYEE,
    })
    role: UserRole;

    @Column({ name: 'is_active', default: true })
    isActive: boolean;

    @Column({ name: 'current_hashed_refresh_token', nullable: true })
    currentHashedRefreshToken?: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
