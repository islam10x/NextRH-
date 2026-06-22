import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  HttpStatus,
  UseGuards,
  StreamableFile,
  Res,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { TrainingService } from "./training.service";
import { CreateTrainingDto } from "./dto/create-training.dto";
import { UpdateTrainingStatusDto } from "./dto/update-training-status.dto";
import { ParseFilePipeBuilder } from "@nestjs/common";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "../file-validation/file-validation.constants";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { Response } from "express";

@Controller("training")
@UseGuards(JwtAuthGuard)
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  // Team manager assigns training to one or more profiles
  @Post("assign")
  async assignTraining(@Body() dto: CreateTrainingDto, @Req() req: any) {
    const managerUserId = req.user?.userId ?? req.user?.user_id;
    const managerEmail = req.user?.email;
    return this.trainingService.assignTraining(
      dto,
      managerUserId,
      managerEmail,
    );
  }

  // Employee lists own trainings
  @Get("employee/:profileId")
  async myTrainings(@Param("profileId") profileId: string) {
    return this.trainingService.listForEmployee(profileId);
  }

  // Employee lists own trainings (using userId from token)
  @Get("me")
  async myTrainingsMe(@Req() req: any) {
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.trainingService.listForUser(userId);
  }

  // Manager lists trainings they assigned
  @Get("assigned/me")
  async assignedByMe(@Req() req: any) {
    const email = req.user?.email;
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    return this.trainingService.listAssignedByUser(email, userId);
  }

  // Employee updates status (start/complete)
  @Patch(":trainingId/status")
  async updateStatus(
    @Param("trainingId") trainingId: string,
    @Body() dto: UpdateTrainingStatusDto,
    @Req() req: any,
  ) {
    const actorProfileId = req.user?.profileId || req.user?.profile_id;
    return this.trainingService.updateStatus(trainingId, dto, actorProfileId);
  }

  // Employee uploads proof (certification file) when completing training
  @Post(":trainingId/proof")
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
  async uploadProof(
    @Param("trainingId") trainingId: string,
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
    @Req() req: any,
  ) {
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    if (!userId) {
      throw new BadRequestException("Missing user context");
    }
    return this.trainingService.uploadProof(
      trainingId,
      file,
      userId,
      req.body?.issueDate || req.body?.issue_date,
      req.body?.description,
      req.body?.relatedProjectId || req.body?.related_project_id,
    );
  }

  // Manager or employee downloads the uploaded proof file (PDF/Image)
  @Get(":trainingId/proof")
  async downloadProof(
    @Param("trainingId") trainingId: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = req.user?.userId || req.user?.user_id || req.user?.id;
    const userEmail = req.user?.email;
    const { stream, mime, filename } = await this.trainingService.getProofFile(
      trainingId,
      userId,
      userEmail,
    );
    res.set({
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${filename}"`,
    });
    return new StreamableFile(stream);
  }
}
