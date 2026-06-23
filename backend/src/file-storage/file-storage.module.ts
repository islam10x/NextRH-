import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UsersModule } from "../users/users.module";
import { FileStorageService } from "./file-storage.service";
import { FileStorageController } from "./file-storage.controller";
import { MetadataSyncService } from "./metadata-sync.service";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";

@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([EmployeeProfile])],
  controllers: [FileStorageController],
  providers: [FileStorageService, MetadataSyncService],
  exports: [FileStorageService, MetadataSyncService],
})
export class FileStorageModule {}
