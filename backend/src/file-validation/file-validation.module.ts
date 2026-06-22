import { Module } from "@nestjs/common";
import { FileValidationService } from "./file-validation.service";

@Module({
  providers: [FileValidationService],
  exports: [FileValidationService],
})
export class FileValidationModule {}
