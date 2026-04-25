import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';
import { CvTemplate } from '../../cv-templates/entities/cv-template.entity';
import { User } from '../../users/entities/user.entity';

@Entity('generated_cvs')
export class GeneratedCv {
    @PrimaryGeneratedColumn('uuid')
    generated_cv_id: string;

    @ManyToOne(() => EmployeeProfile, { nullable: true })
    @JoinColumn({ name: 'profile_id' })
    profile?: EmployeeProfile | null;

    @ManyToOne(() => CvTemplate, { nullable: true })
    @JoinColumn({ name: 'template_id' })
    template?: CvTemplate | null;

    @ManyToOne(() => CvTemplate, { nullable: true })
    @JoinColumn({ name: 'resolved_template_id' })
    resolvedTemplate?: CvTemplate | null;

    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: 'generated_by' })
    generatedBy?: User | null;

    @Column({ name: 'generation_purpose', length: 100, nullable: true })
    generationPurpose?: string | null;

    @Column({ name: 'file_path', length: 512, nullable: true })
    docxPath?: string | null;

    @Column({ name: 'pdf_path', length: 512, nullable: true })
    pdfPath?: string | null;

    @Column({ name: 'language', length: 10, nullable: true })
    language?: string | null;

    @Column({ name: 'status', length: 20, default: 'completed' })
    status: string;

    @Column({ name: 'error_message', type: 'text', nullable: true })
    errorMessage?: string | null;

    @CreateDateColumn({ name: 'generated_at' })
    generatedAt: Date;
}
