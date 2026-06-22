import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Team } from "./team.entity";
import { User } from "../../users/entities/user.entity";

@Entity("team_members")
export class TeamMember {
  @PrimaryGeneratedColumn("uuid")
  team_member_id: string;

  @ManyToOne(() => Team, (team) => team.members, { onDelete: "CASCADE" })
  @JoinColumn({ name: "team_id" })
  team: Team;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "employee_id" })
  employee: User;

  @Column({ name: "joined_date", type: "date", nullable: true })
  joinedDate?: string | null;
}
