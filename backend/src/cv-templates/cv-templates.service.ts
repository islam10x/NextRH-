import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvTemplate, CvTemplateType } from './entities/cv-template.entity';
import { CreateCvTemplateDto } from './dto/create-cv-template.dto';
import { ReplicateCvTemplateDto } from './dto/replicate-cv-template.dto';
import { FileStorageService } from '../file-storage/file-storage.service';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

@Injectable()
export class CvTemplatesService {
    private readonly logger = new Logger(CvTemplatesService.name);
    private readonly aiServiceBaseUrl: string;

    constructor(
        @InjectRepository(CvTemplate)
        private readonly templateRepo: Repository<CvTemplate>,
        private readonly fileStorageService: FileStorageService,
        private readonly configService: ConfigService,
    ) {
        this.aiServiceBaseUrl =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
    }

    async listTemplates() {
        const templates = await this.templateRepo.find({
            order: { createdAt: 'DESC' },
            relations: ['uploadedBy'],
        });
        return templates.map((t) => ({
            id: t.template_id,
            templateName: t.templateName,
            templateType: t.templateType,
            language: t.language,
            filePath: t.filePath,
            originalFilename: t.originalFilename,
            hasFieldMapping: !!t.fieldMapping,
            uploadedBy: t.uploadedBy ? {
                user_id: t.uploadedBy.user_id,
                email: t.uploadedBy.email,
                firstName: t.uploadedBy.firstName,
                lastName: t.uploadedBy.lastName,
            } : null,
            createdAt: t.createdAt,
        }));
    }

    async uploadTemplate(
        file: Express.Multer.File,
        dto: CreateCvTemplateDto,
        userId: string,
    ) {
        this.assertTemplateFile(file);
        const { relativePath, filename } = await this.fileStorageService.saveTemplateFile(
            file,
            dto.templateName,
        );

        const entity = this.templateRepo.create({
            templateName: dto.templateName,
            templateType: dto.templateType,
            language: dto.language || null,
            filePath: relativePath,
            originalFilename: file.originalname,
            uploadedBy: userId ? ({ user_id: userId } as User) : null,
        });
        let saved = await this.templateRepo.save(entity);

        // Best-effort: pre-analyse the template now so the field mapping (and
        // PDF overlay mapping for PDF templates) is cached before the first
        // generation. A failure here must NOT block the upload — the mapping
        // will be computed lazily on first generation instead.
        try {
            saved = await this.runInitialAnalysis(saved);
        } catch (exc) {
            this.logger.warn(
                `Initial template analysis failed for ${saved.template_id} (non-fatal): ${(exc as Error)?.message || exc}`,
            );
        }

        return {
            id: saved.template_id,
            templateName: saved.templateName,
            templateType: saved.templateType,
            language: saved.language,
            filePath: saved.filePath,
            filename,
            hasFieldMapping: !!saved.fieldMapping,
            detectedFields: saved.detectedFields || [],
        };
    }

    async replicateTemplate(
        templateId: string,
        dto: ReplicateCvTemplateDto,
        userId: string,
    ) {
        const template = await this.templateRepo.findOne({ where: { template_id: templateId } });
        if (!template) {
            throw new NotFoundException('Template not found');
        }
        if (!template.filePath) {
            throw new BadRequestException('Template file path is missing');
        }

        const name = dto.templateName || `${template.templateName} Copy`;
        const { relativePath, filename } = await this.fileStorageService.replicateTemplateFile(
            template.filePath,
            name,
        );

        const entity = this.templateRepo.create({
            templateName: name,
            templateType: dto.templateType || template.templateType,
            language: dto.language || template.language || null,
            filePath: relativePath,
            originalFilename: template.originalFilename || filename,
            uploadedBy: userId ? ({ user_id: userId } as User) : null,
        });
        const saved = await this.templateRepo.save(entity);

        return {
            id: saved.template_id,
            templateName: saved.templateName,
            templateType: saved.templateType,
            language: saved.language,
            filePath: saved.filePath,
            filename,
        };
    }

    async getTemplateFile(templateId: string) {
        const template = await this.templateRepo.findOne({ where: { template_id: templateId } });
        if (!template || !template.filePath) {
            throw new NotFoundException('Template not found');
        }
        const absPath = this.fileStorageService.resolveFromWorkspace(template.filePath);
        await fs.access(absPath);
        return {
            path: absPath,
            filename: path.basename(absPath),
        };
    }

    /**
     * Call the AI service to extract all fields/placeholders from the template
     * and return the auto-computed mapping.  The result is saved on the entity.
     */
    async analyzeTemplate(templateId: string) {
        const template = await this.templateRepo.findOne({ where: { template_id: templateId } });
        if (!template || !template.filePath) {
            throw new NotFoundException('Template not found');
        }
        const result = await this.callAnalyzeTemplate(template.filePath);

        template.detectedFields = result.detected_fields || null;
        template.fieldMapping = this.mergeFieldMapping(template.fieldMapping, result.field_mapping);
        await this.templateRepo.save(template);

        // PDF templates additionally get an overlay mapping cached so the
        // primary engine can preserve the original PDF layout exactly.
        if ((template.filePath || '').toLowerCase().endsWith('.pdf')) {
            try {
                const overlay = await this.callBuildOverlayMapping(template.filePath);
                if (overlay && (overlay.fields?.length || overlay.tables?.length)) {
                    template.fieldMapping = this.mergeFieldMapping(
                        template.fieldMapping,
                        { overlay },
                    );
                    await this.templateRepo.save(template);
                }
            } catch (exc) {
                this.logger.warn(
                    `PDF overlay mapping unavailable for ${template.template_id} (non-fatal): ${(exc as Error)?.message || exc}`,
                );
            }
        }

        return result;
    }

    /**
     * Run analyze + (for PDFs) overlay mapping on a freshly-uploaded template.
     * Returns the updated entity. Errors are propagated; the caller decides
     * whether to swallow them (upload flow does, manual analyze does not).
     */
    private async runInitialAnalysis(template: CvTemplate): Promise<CvTemplate> {
        if (!template.filePath) return template;

        const result = await this.callAnalyzeTemplate(template.filePath);
        template.detectedFields = result.detected_fields || null;
        template.fieldMapping = this.mergeFieldMapping(template.fieldMapping, result.field_mapping);

        if ((template.filePath || '').toLowerCase().endsWith('.pdf')) {
            try {
                const overlay = await this.callBuildOverlayMapping(template.filePath);
                if (overlay && (overlay.fields?.length || overlay.tables?.length)) {
                    template.fieldMapping = this.mergeFieldMapping(
                        template.fieldMapping,
                        { overlay },
                    );
                }
            } catch (exc) {
                // Overlay extraction is best-effort — primary engine will fall
                // back to live computation at generation time.
                this.logger.warn(
                    `PDF overlay mapping unavailable on upload for ${template.template_id} (non-fatal): ${(exc as Error)?.message || exc}`,
                );
            }
        }

        return this.templateRepo.save(template);
    }

    private mergeFieldMapping(
        existing: Record<string, any> | null | undefined,
        incoming: Record<string, any> | null | undefined,
    ): Record<string, any> | null {
        if (!incoming) return existing || null;
        return { ...(existing || {}), ...incoming };
    }

    private async callAnalyzeTemplate(relativePath: string): Promise<any> {
        const absPath = this.fileStorageService.resolveFromWorkspace(relativePath);
        const url = `${this.aiServiceBaseUrl}/api/v1/generation/analyze-template`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template_path: absPath }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new BadRequestException(`Template analysis failed: ${body}`);
        }
        return response.json();
    }

    private async callBuildOverlayMapping(relativePath: string): Promise<any> {
        const absPath = this.fileStorageService.resolveFromWorkspace(relativePath);
        const url = `${this.aiServiceBaseUrl}/api/v1/generation/build-overlay-mapping`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template_path: absPath }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Overlay mapping failed (${response.status}): ${body}`);
        }
        return response.json();
    }

    /**
     * Allow users to manually override field mappings.
     * Merges the provided overrides into the existing mapping.
     */
    async updateFieldMapping(
        templateId: string,
        fieldMapping: Record<string, string>,
    ) {
        const template = await this.templateRepo.findOne({ where: { template_id: templateId } });
        if (!template) {
            throw new NotFoundException('Template not found');
        }
        // Merge: user overrides take precedence over existing auto-mapping.
        template.fieldMapping = {
            ...(template.fieldMapping || {}),
            ...fieldMapping,
        };
        await this.templateRepo.save(template);
        return {
            id: template.template_id,
            fieldMapping: template.fieldMapping,
        };
    }

    /**
     * Per-user template history — used by the bid manager workflow on
     * POST /cv/generate. Returns the user's templates ordered by most-recent
     * usage so the UI can offer a quick "re-use" list above the upload input.
     */
    async listMyTemplates(userId: string) {
        if (!userId) return [];
        const rows = await this.templateRepo
            .createQueryBuilder('t')
            .leftJoinAndSelect('t.uploadedBy', 'u')
            .where('u.user_id = :userId', { userId })
            .orderBy('t.last_used_at', 'DESC', 'NULLS LAST')
            .addOrderBy('t.created_at', 'DESC')
            .getMany();
        return rows.map((t) => this.toHistoryDto(t));
    }

    /**
     * Look up a template the user owns. Used when the bid manager picks an
     * entry from their history instead of uploading a new file.
     */
    async getOwnedTemplate(templateId: string, userId: string): Promise<CvTemplate> {
        const template = await this.templateRepo.findOne({
            where: { template_id: templateId },
            relations: ['uploadedBy'],
        });
        if (!template) {
            throw new NotFoundException('Template not found');
        }
        if (!template.uploadedBy || template.uploadedBy.user_id !== userId) {
            throw new ForbiddenException('You can only use templates from your own history');
        }
        return template;
    }

    /**
     * Read the saved template file off disk so the caller can build a mock
     * multer file and re-feed it through the standard generation pipeline.
     */
    async loadTemplateBuffer(template: CvTemplate): Promise<{
        buffer: Buffer;
        mimetype: string;
        filename: string;
    }> {
        if (!template.filePath) {
            throw new NotFoundException('Template file is missing on disk');
        }
        const absPath = this.fileStorageService.resolveFromWorkspace(template.filePath);
        const buffer = await fs.readFile(absPath);
        const ext = path.extname(absPath).toLowerCase();
        const mimetype =
            ext === '.pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        return {
            buffer,
            mimetype,
            filename: template.originalFilename || path.basename(absPath),
        };
    }

    /**
     * Auto-save a template that the user just uploaded through POST /cv/generate
     * if (and only if) generation succeeded. Re-uploading the same bytes by the
     * same user bumps usage stats instead of creating a duplicate row.
     *
     * Hashing happens up-front (before generation) so we can short-circuit
     * the "is this a reuse?" decision without writing the file twice.
     */
    async recordGenerationUsage(args: {
        userId: string | null | undefined;
        file: Express.Multer.File;
        language?: string | null;
    }): Promise<CvTemplate | null> {
        const { userId, file, language } = args;
        if (!userId || !file?.buffer || !file.buffer.length) {
            return null;
        }

        const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');

        // Re-use: the same bytes uploaded again by the same user → bump stats.
        const existing = await this.templateRepo.findOne({
            where: {
                uploadedBy: { user_id: userId } as User,
                fileHash: hash,
            },
        });
        if (existing) {
            existing.usageCount = (existing.usageCount || 0) + 1;
            existing.lastUsedAt = new Date();
            return this.templateRepo.save(existing);
        }

        // First time we've seen this template from this user → persist it.
        let saved: { fullPath: string; filename: string; relativePath: string };
        try {
            const friendlyName = this.deriveTemplateName(file.originalname);
            saved = await this.fileStorageService.saveTemplateFile(file, friendlyName);
        } catch (exc) {
            this.logger.warn(
                `Auto-save of upload template failed (non-fatal): ${(exc as Error)?.message || exc}`,
            );
            return null;
        }

        const entity = this.templateRepo.create({
            templateName: this.deriveTemplateName(file.originalname),
            templateType: CvTemplateType.CLIENT_SPECIFIC,
            language: this.normalizeLanguageForStorage(language),
            filePath: saved.relativePath,
            originalFilename: file.originalname,
            fileHash: hash,
            usageCount: 1,
            lastUsedAt: new Date(),
            uploadedBy: { user_id: userId } as User,
        });
        try {
            return await this.templateRepo.save(entity);
        } catch (exc) {
            // Race: another concurrent request just inserted the same hash.
            // Re-fetch and bump it instead so we don't fail generation.
            this.logger.warn(
                `Template auto-save insert failed, retrying as bump: ${(exc as Error)?.message || exc}`,
            );
            const reloaded = await this.templateRepo.findOne({
                where: {
                    uploadedBy: { user_id: userId } as User,
                    fileHash: hash,
                },
            });
            if (reloaded) {
                reloaded.usageCount = (reloaded.usageCount || 0) + 1;
                reloaded.lastUsedAt = new Date();
                return this.templateRepo.save(reloaded);
            }
            return null;
        }
    }

    /**
     * Bump usage stats when the user re-generates from a stored template
     * (history pick). Separate from recordGenerationUsage so we don't have to
     * re-hash bytes we already know match.
     */
    async bumpUsage(templateId: string): Promise<void> {
        const template = await this.templateRepo.findOne({ where: { template_id: templateId } });
        if (!template) return;
        template.usageCount = (template.usageCount || 0) + 1;
        template.lastUsedAt = new Date();
        await this.templateRepo.save(template);
    }

    async removeFromHistory(templateId: string, userId: string): Promise<void> {
        const template = await this.getOwnedTemplate(templateId, userId);
        // Best-effort file cleanup; an orphan file is harmless but a missing
        // row would re-create on next upload.
        if (template.filePath) {
            try {
                const absPath = this.fileStorageService.resolveFromWorkspace(template.filePath);
                await fs.unlink(absPath);
            } catch (exc) {
                this.logger.warn(
                    `Failed to delete template file ${template.filePath} (non-fatal): ${(exc as Error)?.message || exc}`,
                );
            }
        }
        await this.templateRepo.delete({ template_id: template.template_id });
    }

    private toHistoryDto(t: CvTemplate) {
        return {
            id: t.template_id,
            templateName: t.templateName,
            templateType: t.templateType,
            language: t.language,
            originalFilename: t.originalFilename,
            extension: this.extractExt(t.filePath || t.originalFilename),
            usageCount: t.usageCount || 0,
            lastUsedAt: t.lastUsedAt || null,
            createdAt: t.createdAt,
        };
    }

    private extractExt(filename: string | null | undefined): string {
        if (!filename) return '';
        const ext = path.extname(filename).toLowerCase().replace('.', '');
        return ext;
    }

    private deriveTemplateName(originalFilename: string | null | undefined): string {
        const base = (originalFilename || 'Template').trim();
        const noExt = base.replace(/\.[^.]+$/, '');
        return noExt.slice(0, 200) || 'Template';
    }

    private normalizeLanguageForStorage(language: string | null | undefined): string | null {
        if (!language) return null;
        const lang = language.trim().toLowerCase();
        if (!lang || lang === 'original') return null;
        return lang.slice(0, 10);
    }

    private assertTemplateFile(file?: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('Template file is required');
        }
        const name = (file.originalname || '').toLowerCase();
        const allowedDocx =
            file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            name.endsWith('.docx');
        const allowedPdf =
            file.mimetype === 'application/pdf' || name.endsWith('.pdf');
        const allowed = allowedDocx || allowedPdf;
        if (!allowed) {
            throw new BadRequestException('Only .docx or .pdf templates are supported');
        }
    }
}
