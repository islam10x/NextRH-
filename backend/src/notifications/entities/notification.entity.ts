import {
    Column,
    CreateDateColumn,
    Entity,
    ManyToOne,
    PrimaryGeneratedColumn,
    JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export type NotificationType =
    | 'certification_expiring'
    | 'certification_expired'
    | 'cv_update_needed'
    | 'training_assigned'
    | 'training_started'
    | 'training_completed'
    | 'team_added'
    | 'project_assigned'
    | 'project_updated';

@Entity('notifications')
export class Notification {
    @PrimaryGeneratedColumn('uuid')
    notification_id: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'notification_type', type: 'enum', enum: ['certification_expiring', 'certification_expired', 'cv_update_needed', 'training_assigned', 'training_started', 'training_completed', 'team_added', 'project_assigned', 'project_updated'] })
    notificationType: NotificationType;

    @Column({ length: 255 })
    title: string;

    @Column({ type: 'text', nullable: true })
    message?: string;

    @Column({ name: 'is_read', default: false })
    isRead: boolean;

    @Column({ name: 'priority', default: 1 })
    priority: number;

    @Column({ name: 'related_entity_type', nullable: true })
    relatedEntityType?: string;

    @Column({ name: 'related_entity_id', type: 'uuid', nullable: true })
    relatedEntityId?: string;

    @Column({ name: 'scheduled_at', type: 'timestamp', nullable: true })
    scheduledAt?: Date;

    @Column({ name: 'email_sent', default: false })
    emailSent: boolean;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
