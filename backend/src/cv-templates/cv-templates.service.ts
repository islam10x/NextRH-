import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvTemplate } from './entities/cv-template.entity';
import { CreateCvTemplateDto } from './dto/create-cv-template.dto';
import { ReplicateCvTemplateDto } from './dto/replicate-cv-template.dto';
import { FileStorageService } from '../file-storage/file-storage.service';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import * as path from 'path';
import * as fs from 'fs/promises';

@Injectable()
export class CvTemplatesService {
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
        const absPath = this.fileStorageService.resolveFromWorkspace(template.filePath);

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
        const result = await response.json();

        // Persist the discovered fields and mapping.
        template.detectedFields = result.detected_fields || null;
        template.fieldMapping = result.field_mapping || null;
        await this.templateRepo.save(template);

        return result;
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
