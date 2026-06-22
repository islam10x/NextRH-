import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { FileStorageService } from "./file-storage.service";
import { FileStorageController } from "./file-storage.controller";

@Module({
  imports: [UsersModule],
  controllers: [FileStorageController],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class FileStorageModule {}
