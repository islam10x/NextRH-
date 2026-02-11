import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { EmployeeProfile } from './employee-profile.entity';

@Entity('education')
export class Education {
    @PrimaryGeneratedColumn('uuid')
    education_id: string;

    @ManyToOne(() => EmployeeProfile, (profile) => profile.educations, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'profile_id' })
    profile: EmployeeProfile;

    @Column()
    degree: string;

    @Column({ name: 'field_of_study', nullable: true })
    fieldOfStudy: string;

    @Column({ nullable: true })
    institution: string;

    @Column({ name: 'end_date', type: 'date', nullable: true })
    endDate: Date;
}
