import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
} from 'typeorm';
import { Certification } from '../../certifications/entities/certification.entity';

export type AlertType = 'expiring_30_days' | 'expiring_7_days' | 'expired';

@Entity('certification_alerts')
export class CertificationAlert {
    @PrimaryGeneratedColumn('uuid')
    alert_id: string;

    @ManyToOne(() => Certification, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'certification_id' })
    certification: Certification;

    @Column({ name: 'alert_type', type: 'varchar' })
    alertType: AlertType;

    @Column({ name: 'days_until_expiration', nullable: true })
    daysUntilExpiration: number;

    @Column({ name: 'notification_sent', default: false })
    notificationSent: boolean;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
