import { Module } from "@nestjs/common";
import { RagService } from "./rag.service";
import { RagController } from "./rag.controller";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AiSearchQuery } from "./entities/ai-search-query.entity";
import { User } from "../users/entities/user.entity";

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([AiSearchQuery, User])],
  controllers: [RagController],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
