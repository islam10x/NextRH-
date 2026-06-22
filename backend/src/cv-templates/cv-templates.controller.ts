import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpCode,
  ParseFilePipeBuilder,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { CvTemplatesService } from "./cv-templates.service";
import { CreateCvTemplateDto } from "./dto/create-cv-template.dto";
import { ReplicateCvTemplateDto } from "./dto/replicate-cv-template.dto";
import { createReadStream } from "fs";
import type { Response } from "express";

@Controller("cv-templates")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CvTemplatesController {
  constructor(private readonly cvTemplatesService: CvTemplatesService) {}

  @Get()
  @Roles(UserRole.BID_MANAGER)
  async list() {
    return this.cvTemplatesService.listTemplates();
  }

  /**
   * Per-user template history for the bid manager — surfaces the templates
   * they've already used so they can re-generate without re-uploading.
   */
  @Get("mine")
  @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
  async listMine(@CurrentUser() user: any) {
    const userId = user?.user_id || user?.id;
    return this.cvTemplatesService.listMyTemplates(userId);
  }

  /**
   * Remove an entry from the bid manager's own template history. Only the
   * uploader can delete their own templates.
   */
  @Delete(":templateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.BID_MANAGER, UserRole.TEAM_MANAGER)
  async removeMine(
    @Param("templateId") templateId: string,
    @CurrentUser() user: any,
  ) {
    const userId = user?.user_id || user?.id;
    await this.cvTemplatesService.removeFromHistory(templateId, userId);
  }

  @Post()
  @Roles(UserRole.BID_MANAGER)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: 20 * 1024 * 1024 })
        .build({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    file: Express.Multer.File,
    @Body() dto: CreateCvTemplateDto,
    @CurrentUser() user: any,
  ) {
    const userId = user?.user_id || user?.id;
    return this.cvTemplatesService.uploadTemplate(file, dto, userId);
  }

  @Post(":templateId/replicate")
  @Roles(UserRole.BID_MANAGER)
  async replicate(
    @Param("templateId") templateId: string,
    @Body() dto: ReplicateCvTemplateDto,
    @CurrentUser() user: any,
  ) {
    const userId = user?.user_id || user?.id;
    return this.cvTemplatesService.replicateTemplate(templateId, dto, userId);
  }

  @Post(":templateId/analyze")
  @Roles(UserRole.BID_MANAGER)
  async analyze(@Param("templateId") templateId: string) {
    return this.cvTemplatesService.analyzeTemplate(templateId);
  }

  @Patch(":templateId/field-mapping")
  @Roles(UserRole.BID_MANAGER)
  async updateFieldMapping(
    @Param("templateId") templateId: string,
    @Body() body: { fieldMapping: Record<string, string> },
  ) {
    return this.cvTemplatesService.updateFieldMapping(
      templateId,
      body.fieldMapping,
    );
  }

  @Get(":templateId/download")
  @Roles(UserRole.BID_MANAGER)
  async download(
    @Param("templateId") templateId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const template = await this.cvTemplatesService.getTemplateFile(templateId);
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${template.filename}"`,
    });
    return new StreamableFile(createReadStream(template.path));
  }
}
