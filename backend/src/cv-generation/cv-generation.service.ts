import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { GeneratedCv } from "./entities/generated-cv.entity";
import { CvTemplate } from "../cv-templates/entities/cv-template.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { CvService } from "../cv/cv.service";
import { FileStorageService } from "../file-storage/file-storage.service";
import { ConfigService } from "@nestjs/config";
import { GenerateCvDto } from "./dto/generate-cv.dto";
import { User } from "../users/entities/user.entity";
import * as path from "path";

type AiGenerateResponse = {
  docx_path?: string;
  pdf_path?: string | null;
  docx_relative_path?: string;
  pdf_relative_path?: string | null;
  field_mapping?: Record<string, string> | null;
  matched_template_path?: string | null;
  matched_template_relative_path?: string | null;
};

@Injectable()
export class CvGenerationService {
  private readonly logger = new Logger(CvGenerationService.name);
  private readonly aiServiceBaseUrl: string;

  constructor(
    @InjectRepository(GeneratedCv)
    private readonly generatedRepo: Repository<GeneratedCv>,
    @InjectRepository(CvTemplate)
    private readonly templateRepo: Repository<CvTemplate>,
    @InjectRepository(EmployeeProfile)
    private readonly profileRepo: Repository<EmployeeProfile>,
    private readonly cvService: CvService,
    private readonly fileStorageService: FileStorageService,
    private readonly configService: ConfigService,
  ) {
    this.aiServiceBaseUrl =
      this.configService.get<string>("AI_SERVICE_URL")?.replace(/\/+$/, "") ||
      "http://127.0.0.1:8000";
  }

  async generate(dto: GenerateCvDto, generatorUserId: string) {
    const template = await this.templateRepo.findOne({
      where: { template_id: dto.templateId },
    });
    if (!template) {
      throw new NotFoundException("Template not found");
    }
    if (!template.filePath) {
      throw new BadRequestException("Template file is missing");
    }

    const profile = await this.profileRepo.findOne({
      where: { user: { user_id: dto.employeeId } },
      relations: ["user"],
    });
    if (!profile) {
      throw new NotFoundException("Employee profile not found");
    }

    const profilePayload = await this.cvService.getMyProfile(dto.employeeId);
    const outputDir = await this.fileStorageService.getGeneratedCvDir(
      dto.employeeId,
    );
    const templatePath = this.resolveAbsolutePath(template.filePath || "");

    let outputFormats = dto.outputFormats?.length
      ? dto.outputFormats
      : ["docx", "pdf"];
    const targetLanguage = dto.language || template.language || null;
    const translate = dto.translate ?? true;

    const filenamePrefix = this.buildFilenamePrefix(
      profilePayload?.name || "CV",
      template.templateName,
    );

    const templateExt = path.extname(template.filePath || "").toLowerCase();
    if (templateExt === ".pdf") {
      outputFormats = ["pdf"];
    }

    const aiPayload: Record<string, any> = {
      template_path: templatePath,
      output_dir: outputDir,
      output_formats: outputFormats,
      language: targetLanguage,
      translate,
      filename_prefix: filenamePrefix,
      profile: profilePayload,
    };

    // Use cached field mapping when available (skips re-analysis).
    if (template.fieldMapping) {
      aiPayload.field_mapping = template.fieldMapping;
    }

    // Create a pending record for status tracking.
    const record = this.generatedRepo.create({
      profile: { profile_id: profile.profile_id } as EmployeeProfile,
      template: { template_id: template.template_id } as CvTemplate,
      generatedBy: generatorUserId
        ? ({ user_id: generatorUserId } as User)
        : null,
      generationPurpose: dto.generationPurpose || null,
      language: targetLanguage,
      status: "processing",
    });
    const saved = await this.generatedRepo.save(record);

    let aiResponse: AiGenerateResponse;
    try {
      aiResponse = await this.callAiService(aiPayload);
    } catch (error) {
      saved.status = "failed";
      saved.errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.generatedRepo.save(saved);
      throw error;
    }

    const docxPath = this.resolveRelativePath(
      aiResponse.docx_relative_path || aiResponse.docx_path,
    );
    const pdfPath = this.resolveRelativePath(
      aiResponse.pdf_relative_path || aiResponse.pdf_path || null,
    );
    const matchedTemplatePath = this.resolveRelativePath(
      aiResponse.matched_template_relative_path ||
        aiResponse.matched_template_path ||
        null,
    );

    // Update the record with completed status and file paths.
    saved.docxPath = docxPath;
    saved.pdfPath = pdfPath;
    saved.status = "completed";

    if (matchedTemplatePath) {
      const resolved = await this.templateRepo.findOne({
        where: { filePath: matchedTemplatePath },
      });
      if (resolved) {
        (saved as any).resolvedTemplate = resolved as CvTemplate;
        this.logger.log(`Matched template stored: ${resolved.template_id}`);
      } else {
        this.logger.warn(
          `Matched template not found for path: ${matchedTemplatePath}`,
        );
      }
    }
    await this.generatedRepo.save(saved);

    // Cache the computed field mapping on the template for future reuse.
    if (aiResponse.field_mapping && !template.fieldMapping) {
      template.fieldMapping = aiResponse.field_mapping;
      await this.templateRepo.save(template);
      this.logger.log(
        `Cached field mapping for template ${template.template_id}`,
      );
    }

    return {
      id: saved.generated_cv_id,
      docxPath,
      pdfPath,
      downloadDocxUrl: `/cv-generation/${saved.generated_cv_id}/download?format=docx`,
      downloadPdfUrl: pdfPath
        ? `/cv-generation/${saved.generated_cv_id}/download?format=pdf`
        : null,
    };
  }

  async getGeneratedFile(generatedId: string, format: "docx" | "pdf") {
    const record = await this.generatedRepo.findOne({
      where: { generated_cv_id: generatedId },
    });
    if (!record) {
      throw new NotFoundException("Generated CV not found");
    }
    const filePath = format === "pdf" ? record.pdfPath : record.docxPath;
    if (!filePath) {
      throw new NotFoundException(`No ${format.toUpperCase()} file available`);
    }
    const absPath = this.resolveAbsolutePath(filePath);
    return {
      path: absPath,
      filename: path.basename(absPath),
      mime:
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }

  private buildFilenamePrefix(name: string, templateName: string) {
    const safe = (value: string) =>
      String(value || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_\-]/g, "");
    const date = new Date().toISOString().slice(0, 10);
    return `${safe(name)}_${safe(templateName)}_${date}` || `CV_${date}`;
  }

  private resolveAbsolutePath(filePath: string) {
    return this.fileStorageService.resolveFromWorkspace(filePath);
  }

  private resolveRelativePath(filePath: string | null | undefined) {
    if (!filePath) return null;
    if (!path.isAbsolute(filePath)) return filePath;
    return path.relative(this.fileStorageService.getWorkspaceRoot(), filePath);
  }

  private async callAiService(
    payload: Record<string, any>,
  ): Promise<AiGenerateResponse> {
    const url = `${this.aiServiceBaseUrl}/api/v1/generation/cv`;
    const controller = new AbortController();
    const timeoutMs = 120_000; // 2 minutes
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.error(
          `AI generation failed: ${response.status} ${response.statusText} ${body}`,
        );
        throw new BadRequestException("AI service failed to generate CV");
      }
      return (await response.json()) as AiGenerateResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.logger.error(
          `AI service call timed out after ${timeoutMs / 1000}s`,
        );
        throw new BadRequestException(
          "CV generation timed out. Please try again.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
