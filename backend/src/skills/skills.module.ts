import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Skill } from "./entities/skill.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Skill])],
})
export class SkillsModule {}
