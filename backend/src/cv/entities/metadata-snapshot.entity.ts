import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

@Entity('metadata_snapshots')
export class MetadataSnapshot {
    @PrimaryGeneratedColumn('uuid')
    snapshot_id: string;

    @ManyToOne(() => EmployeeProfile, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'profile_id' })
    profile: EmployeeProfile;

    @Column({ name: 'metadata_json', type: 'jsonb' })
    metadataJson: any;

    @Column({ name: 'is_current', default: false })
    isCurrent: boolean;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
