import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

export type EmployeeStorageCategory = 'CV' | 'Certifications' | 'Trainings';

export interface EmployeeMetadata {
    name: string;
    skills: string[];
    certifications: string[];
    experience_years: number;
    last_update: string;
}

@Injectable()
export class FileStorageService {
    private readonly logger = new Logger(FileStorageService.name);
    constructor(private readonly usersService: UsersService) { }

    async saveEmployeeFile(userId: string, file: Express.Multer.File, category: EmployeeStorageCategory) {
        const user = await this.usersService.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
            || user.email?.split('@')[0]
            || 'employee';

        const existingBaseDir = await this.findBaseDirByOwner(user.user_id);
        const employeeName = fallbackName;

        const baseDir = existingBaseDir || await this.resolveEmployeeBaseDir(employeeName, user.user_id, user.email);

        this.logger.log(`[CV Upload] User: ${userId}, Employee Name: ${employeeName}, Base Dir: ${baseDir}`);

        const targetDir = category === 'Certifications'
            ? path.join(baseDir, 'Certificates')
            : baseDir;

        const metadataPath = path.join(baseDir, 'metadata.json');

        await fs.mkdir(targetDir, { recursive: true });

        const safeOriginalName = this.sanitizeFileName(file.originalname || 'file');
        const storedName = category === 'CV'
            ? `CV${this.resolveExtension(file, safeOriginalName)}`
            : await this.resolveStoredName(targetDir, safeOriginalName);

        const fullPath = path.join(targetDir, storedName);
        await fs.writeFile(fullPath, file.buffer);

        await this.updateBasicMetadata(metadataPath, employeeName);

        return {
            message: 'File uploaded successfully',
            path: path.relative(process.cwd(), fullPath),
            filename: storedName,
            baseDir: path.relative(process.cwd(), baseDir),
        };
    }

    async getEmployeeMetadata(userId: string): Promise<EmployeeMetadata> {
        const user = await this.usersService.findById(userId);
        const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email.split('@')[0];

        const baseDir = await this.findBaseDirByOwner(user.user_id);
        if (!baseDir) {
            return {
                name: fallbackName,
                skills: [],
                certifications: [],
                experience_years: 0,
                last_update: this.currentDate(),
            };
        }

        const metadataPath = path.join(baseDir, 'metadata.json');
        try {
            const raw = await fs.readFile(metadataPath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                name: parsed.name || fallbackName,
                skills: parsed.skills || [],
                certifications: parsed.certifications || [],
                experience_years: parsed.experience_years || 0,
                last_update: parsed.last_update || this.currentDate(),
            };
        } catch {
            return {
                name: fallbackName,
                skills: [],
                certifications: [],
                experience_years: 0,
                last_update: this.currentDate(),
            };
        }
    }

    private async resolveEmployeeBaseDir(employeeName: string, userId: string, email: string) {
        const rootDir = this.getStorageRoot();
        const folderName = this.buildSafeFolderName(employeeName, userId);
        const baseDir = path.join(rootDir, folderName);

        this.logger.log(`[Folder Creation] Root: ${rootDir}, Folder Name: ${folderName}, Full Path: ${baseDir}`);

        await fs.mkdir(baseDir, { recursive: true });
        return baseDir;
    }


    private async findBaseDirByOwner(userId: string): Promise<string | null> {
        const user = await this.usersService.findById(userId);
        if (!user || !user.firstName || !user.lastName) {
            return null;
        }

        const rootDir = this.getStorageRoot();
        const folderName = this.buildSafeFolderName(`${user.firstName} ${user.lastName}`, userId);
        const baseDir = path.join(rootDir, folderName);

        if (existsSync(baseDir)) {
            return baseDir;
        }

        return null;
    }


    private async resolveStoredName(targetDir: string, safeOriginalName: string) {
        const targetPath = path.join(targetDir, safeOriginalName);
        try {
            await fs.access(targetPath);
            const timestamp = new Date().getTime();
            return `${timestamp}-${safeOriginalName}`;
        } catch {
            return safeOriginalName;
        }
    }

    async saveMetadata(userId: string, parsedData: any) {
        const baseDir = await this.findBaseDirByOwner(userId);
        if (!baseDir) {
            this.logger.warn(`No base directory found for user ${userId}, cannot save metadata`);
            return;
        }

        // Build enhanced metadata with summary fields
        const firstName = parsedData.structured_data?.first_name || '';
        const lastName = parsedData.structured_data?.last_name || '';
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

        // Remove the PDF metadata section
        const cleanedData = { ...parsedData };
        delete cleanedData.metadata;

        const enhancedMetadata = {
            name: fullName,
            skills: [], // Can be populated from structured_data if available
            certifications: parsedData.structured_data?.certifications?.map((c: any) => c.name) || [],
            experience_years: 0, // Calculate from experience if needed
            last_update: new Date().toISOString(),
            ...cleanedData
        };

        const metadataPath = path.join(baseDir, 'metadata.json');
        await fs.writeFile(metadataPath, JSON.stringify(enhancedMetadata, null, 2));
        this.logger.log(`Saved parsed CV metadata to ${metadataPath}`);
    }

    async addCertificationToMetadata(userId: string, certData: { name: string; issuer?: string; expiration?: string }) {
        const baseDir = await this.findBaseDirByOwner(userId);
        if (!baseDir) {
            this.logger.warn(`No base directory found for user ${userId}, cannot update metadata`);
            return;
        }

        const metadataPath = path.join(baseDir, 'metadata.json');

        try {
            // Read existing metadata
            let metadata: any = {};
            try {
                const existing = await fs.readFile(metadataPath, 'utf8');
                metadata = JSON.parse(existing);
            } catch {
                // If metadata doesn't exist, create minimal structure
                metadata = {
                    name: '',
                    skills: [],
                    certifications: [],
                    experience_years: 0,
                    last_update: new Date().toISOString()
                };
            }

            // Initialize certifications array if it doesn't exist
            if (!Array.isArray(metadata.certifications)) {
                metadata.certifications = [];
            }

            // Add new certification (check for duplicates)
            const isDuplicate = metadata.certifications.some(
                (cert: any) => cert.name === certData.name || cert === certData.name
            );

            if (!isDuplicate) {
                metadata.certifications.push(certData.name);
            }

            // Update timestamp
            metadata.last_update = new Date().toISOString();

            // Write back to file
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            this.logger.log(`Updated metadata with certification: ${certData.name}`);

        } catch (error) {
            this.logger.error(`Error updating metadata with certification: ${error.message}`);
        }
    }

    private async updateBasicMetadata(metadataPath: string, name: string) {
        let metadata = {
            name,
            skills: [],
            certifications: [],
            experience_years: 0,
            last_update: this.currentDate(),
        };

        try {
            const existing = await fs.readFile(metadataPath, 'utf8');
            const parsed = JSON.parse(existing);
            metadata = { ...metadata, ...parsed, name, last_update: this.currentDate() };
        } catch { }

        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    }

    private getStorageRoot() {
        return path.resolve(process.cwd(), 'file-storage', 'CV_Database');
    }

    private sanitizeFileName(name: string) {
        return name.replace(/[^a-zA-Z0-9.-]/g, '_');
    }

    private buildSafeFolderName(name: string, userId: string) {
        const normalized = name
            .trim()
            .replace(/\s+/g, ' ')
            .split(' ')
            .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
            .join('_');

        // Extract first 8 characters of userId for brevity (e.g., "12345678-..." -> "12345678")
        const userIdShort = userId.replace(/-/g, '').substring(0, 8);

        return this.sanitizeFileName(`${normalized}_${userIdShort}`);
    }

    private resolveExtension(file: Express.Multer.File, originalName: string) {
        const ext = path.extname(originalName);
        if (ext) return ext;
        if (file.mimetype === 'application/pdf') return '.pdf';
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
        return '';
    }

    private currentDate() {
        return new Date().toISOString();
    }
}
