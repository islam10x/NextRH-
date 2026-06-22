import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from "typeorm";
import { Project } from "../../projects/entities/project.entity";

@Entity("skills")
export class Skill {
  @PrimaryGeneratedColumn("uuid")
  skill_id: string;

  @Column({ name: "skill_name", length: 100, unique: true })
  skillName: string;

  @Column({ length: 100, nullable: true })
  category: string;

  @ManyToMany(() => Project, (project) => project.skills)
  projects: Project[];
}
