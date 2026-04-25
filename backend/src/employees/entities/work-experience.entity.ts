import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { EmployeeProfile } from './employee-profile.entity';

@Entity('work_experience')
export class WorkExperience {
    @PrimaryGeneratedColumn('uuid')
    experience_id: string;

    @ManyToOne(() => EmployeeProfile, (profile) => profile.workExperiences, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'profile_id' })
    profile: EmployeeProfile;

    @Column({ name: 'job_title', type: 'text' })
    jobTitle: string;

    @Column({ name: 'company_name', type: 'text' })
    companyName: string;

    @Column({ name: 'start_date', type: 'date', nullable: true })
    startDate: Date;

    @Column({ name: 'end_date', type: 'date', nullable: true })
    endDate: Date;

    @Column({ name: 'is_current', default: false })
    isCurrent: boolean;

    @Column({ type: 'text' })
    description: string;
}
