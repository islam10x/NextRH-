import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  ParseFilePipeBuilder,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { createReadStream } from "fs";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { CertificationsService } from "./certifications.service";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "../file-validation/file-validation.constants";
import {
  CreateCertificationDto,
  UpdateCertificationDto,
} from "./dto/certification.dto";

@Controller("certifications")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CertificationsController {
  constructor(private readonly certificationsService: CertificationsService) {}

  @Post("upload")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        if (
          !ALLOWED_UPLOAD_MIME_TYPES.includes(
            (file.mimetype || "").toLowerCase(),
          )
        ) {
          return cb(new BadRequestException("Unsupported file type"), false);
        }
        return cb(null, true);
      },
    }),
  )
  async uploadCertification(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .addFileTypeValidator({
          fileType:
            /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/png|image\/jpeg)$/i,
        })
        .build({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: any,
    @Body("expected_certification_name") expectedCertificationName?: string,
  ) {
    if (!file) {
      throw new BadRequestException("File is required");
    }

    return this.certificationsService.saveEmployeeCertification(
      user,
      file,
      expectedCertificationName,
    );
  }

  /**
   * Self-service: create a manual (unverified) certification entry to
   * correct a CV parsing error or add one the parser missed.
   */
  @Post()
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async createCertification(
    @CurrentUser() user: any,
    @Body() dto: CreateCertificationDto,
  ) {
    const userId = user?.user_id || user?.id;
    return this.certificationsService.createCertification(userId, dto);
  }

  /**
   * Self-service: edit a certification's metadata. Blocked once verified
   * (is_uploaded=true) — see CertificationsService.updateCertification.
   */
  @Patch(":id")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async updateCertification(
    @CurrentUser() user: any,
    @Param("id") id: string,
    @Body() dto: UpdateCertificationDto,
  ) {
    const userId = user?.user_id || user?.id;
    return this.certificationsService.updateCertification(userId, id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async deleteCertification(@CurrentUser() user: any, @Param("id") id: string) {
    const userId = user?.user_id || user?.id;
    return this.certificationsService.deleteCertification(userId, id);
  }

  @Get(":id/proof")
  @Roles(UserRole.EMPLOYEE, UserRole.TEAM_MANAGER, UserRole.BID_MANAGER)
  async getCertificationProof(
    @Param("id") id: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const proof = await this.certificationsService.getCertificationProof(id, {
      userId: user?.user_id || user?.id,
      role: user?.role,
    });
    if (!proof) {
      throw new NotFoundException("Justificatif introuvable");
    }

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(proof.fileName)}"`,
    );
    createReadStream(proof.absolutePath).pipe(res);
  }

  @Get("bid/stats")
  @Roles(UserRole.BID_MANAGER)
  async getBidStats() {
    return this.certificationsService.getGlobalCertStats();
  }

  @Get("team")
  @Roles(UserRole.TEAM_MANAGER)
  async getTeamCertifications(@CurrentUser() user: any) {
    const managerId = user?.user_id || user?.id;
    return this.certificationsService.getTeamCertifications(managerId);
  }

  @Get("team/stats")
  @Roles(UserRole.TEAM_MANAGER)
  async getTeamCertificationStats(@CurrentUser() user: any) {
    const managerId = user?.user_id || user?.id;
    return this.certificationsService.getTeamCertificationStats(managerId);
  }
}
