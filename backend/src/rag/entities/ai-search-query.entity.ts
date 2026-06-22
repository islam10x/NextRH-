import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";

@Entity("ai_search_queries")
export class AiSearchQuery {
  @PrimaryGeneratedColumn("uuid")
  query_id: string;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "user_id" })
  user?: User | null;

  @Column({ name: "query_text", type: "text" })
  queryText: string;

  @Column({ name: "query_intent", nullable: true })
  queryIntent?: string | null;

  @Column({ name: "extracted_entities", type: "jsonb", nullable: true })
  extractedEntities?: Record<string, any> | null;

  @Column({ name: "result_count", type: "int", nullable: true })
  resultCount?: number | null;

  @Column({ name: "execution_time_ms", type: "int", nullable: true })
  executionTimeMs?: number | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
