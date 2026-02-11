import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToOne,
    JoinColumn,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { WorkExperience } from './work-experience.entity';
import { Education } from './education.entity';
import { Certification } from '../../certifications/entities/certification.entity';

@Entity('employee_profiles')
export class EmployeeProfile {
    @PrimaryGeneratedColumn('uuid')
    profile_id: string;

    @OneToOne(() => User)
    @JoinColumn({ name: 'user_id' })
    user: User;

    @Column({ name: 'total_experience_years', nullable: true })
    totalExperienceYears: number;

    @Column({ name: 'current_position', nullable: true })
    currentPosition: string;

    @Column({ name: 'professional_summary', type: 'text', nullable: true })
    professionalSummary: string;

    @Column({ name: 'folder_path', nullable: true })
    folderPath: string;

    @OneToMany(() => WorkExperience, (experience) => experience.profile)
    workExperiences: WorkExperience[];

    @OneToMany(() => Education, (education) => education.profile)
    educations: Education[];

    @OneToMany(() => Certification, (certification) => certification.profile)
    certifications: Certification[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
