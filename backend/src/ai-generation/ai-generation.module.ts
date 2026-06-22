import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AIGenerationController } from "./ai-generation.controller";
import { AIGenerationService } from "./ai-generation.service";
import { HttpModule } from "@nestjs/axios";
import { Project } from "../projects/entities/project.entity";

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Project])],
  controllers: [AIGenerationController],
  providers: [AIGenerationService],
  exports: [AIGenerationService],
})
export class AIGenerationModule {}
