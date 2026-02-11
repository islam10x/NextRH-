import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';

export enum CertificationStatus {
    ACTIVE = 'active',
    EXPIRED = 'expired',
    EXPIRING_SOON = 'expiring_soon',
}

@Entity('certifications')
export class Certification {
    @PrimaryGeneratedColumn('uuid')
    certification_id: string;

    @ManyToOne(() => EmployeeProfile, (profile) => profile.certifications, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'profile_id' })
    profile: EmployeeProfile;

    @Column({ name: 'certification_name' })
    certificationName: string;

    @Column({ name: 'issuing_organization', nullable: true })
    issuingOrganization: string;

    @Column({ name: 'issue_date', type: 'date', nullable: true })
    issueDate: Date;

    @Column({ name: 'expiration_date', type: 'date', nullable: true })
    expirationDate: Date;

    @Column({
        type: 'enum',
        enum: CertificationStatus,
        default: CertificationStatus.ACTIVE,
    })
    status: CertificationStatus;

    @Column({ name: 'file_path', nullable: true })
    filePath: string;

    @Column({ name: 'credential_id', nullable: true })
    credentialId: string;

    @CreateDateColumn({ name: 'uploaded_at' })
    uploadedAt: Date;
}
