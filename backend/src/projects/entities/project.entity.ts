import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, ManyToMany, JoinTable, OneToMany } from 'typeorm';
import { EmployeeProfile } from '../../employees/entities/employee-profile.entity';
import { Skill } from '../../skills/entities/skill.entity';
import { ProjectParticipant } from './participant.entity';

@Entity('projects')
export class Project {
    @PrimaryGeneratedColumn('uuid')
    project_id: string;

    @ManyToMany(() => Skill, (skill) => skill.projects)
    @JoinTable({
        name: 'project_technologies',
        joinColumn: { name: 'project_id', referencedColumnName: 'project_id' },
        inverseJoinColumn: { name: 'skill_id', referencedColumnName: 'skill_id' }
    })
    skills: Skill[];

    @OneToMany(() => ProjectParticipant, (participant) => participant.project)
    participants: ProjectParticipant[];

    @Column({ name: 'project_name', length: 255 })
    projectName: string;

    @Column({ name: 'client_name', length: 255, nullable: true })
    clientName: string;

    @Column({ name: 'project_description', type: 'text', nullable: true })
    projectDescription: string;

    @Column({ name: 'start_date', type: 'date', nullable: true })
    startDate: Date | null;

    @Column({ name: 'end_date', type: 'date', nullable: true })
    endDate: Date | null;

    @Column({ name: 'complexity', length: 20, nullable: true, default: 'medium' })
    complexity: string | null;

    @Column({ name: 'generated_title', length: 255, nullable: true })
    generatedTitle: string | null;
}
