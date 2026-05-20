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

type CertificationMetadataEntry = {
    name: string;
    issuer?: string;
    issue_date?: string;
    date_obtained?: string;
    expiration?: string;
    is_uploaded?: boolean;
    credential_id?: string;
};

@Injectable()
export class FileStorageService {
    private readonly logger = new Logger(FileStorageService.name);
    constructor(private readonly usersService: UsersService) { }

    async saveEmployeeFile(
        userId: string,
        file: Express.Multer.File,
        category: EmployeeStorageCategory,
        options?: { preferredFileName?: string; overwrite?: boolean },
    ) {
        const user = await this.usersService.findById(userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
            || user.email?.split('@')[0]
            || 'employee';

        const existingBaseDir = await this.findBaseDirByOwner(user.user_id);
        const employeeName = fallbackName;

        let baseDir: string;
        if (existingBaseDir) {
            // Check if we need to rename the existing folder
            const currentFolderName = path.basename(existingBaseDir);
            const expectedFolderName = this.buildSafeFolderName(employeeName, user.user_id);

            if (currentFolderName !== expectedFolderName) {
                const rootDir = this.getStorageRoot();
                const newBaseDir = path.join(rootDir, expectedFolderName);
                this.logger.log(`[Folder Rename] Renaming from ${currentFolderName} to ${expectedFolderName}`);
                await fs.rename(existingBaseDir, newBaseDir);
                baseDir = newBaseDir;
            } else {
                baseDir = existingBaseDir;
            }
        } else {
            baseDir = await this.resolveEmployeeBaseDir(employeeName, user.user_id, user.email);
        }

        this.logger.log(`[CV Upload] User: ${userId}, Employee Name: ${employeeName}, Base Dir: ${baseDir}`);

        const targetDir = category === 'Certifications'
            ? path.join(baseDir, 'Certificates')
            : baseDir;

        const metadataPath = path.join(baseDir, 'metadata.json');

        await fs.mkdir(targetDir, { recursive: true });

        const safeOriginalName = this.sanitizeFileName(file.originalname || 'file');
        const storedName = category === 'CV'
            ? `CV${this.resolveExtension(file, safeOriginalName)}`
            : await this.resolveStoredName(
                targetDir,
                safeOriginalName,
                file,
                options,
            );

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
            const rawCertifications = Array.isArray(parsed.certifications)
                ? parsed.certifications
                : [];
            const certificationNames = rawCertifications
                .map((cert: any) => {
                    if (typeof cert === 'string') return cert;
                    if (cert && typeof cert === 'object') return cert.name || cert.certification_name || '';
                    return '';
                })
                .map((value: string) => value.trim())
                .filter((value: string) => value.length > 0);
            return {
                name: parsed.name || fallbackName,
                skills: parsed.skills || [],
                certifications: certificationNames,
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


    async findBaseDirByOwner(userId: string): Promise<string | null> {
        const rootDir = this.getStorageRoot();
        if (!existsSync(rootDir)) return null;

        const folders = await fs.readdir(rootDir);
        const userIdShort = userId.replace(/-/g, '').substring(0, 8);

        // 1. Try strict ID match first
        const ownerFolder = folders.find(folder => folder.endsWith(`_${userIdShort}`));
        if (ownerFolder) {
            return path.join(rootDir, ownerFolder);
        }

        return null;
    }


    private async resolveStoredName(
        targetDir: string,
        safeOriginalName: string,
        file?: Express.Multer.File,
        options?: { preferredFileName?: string; overwrite?: boolean },
    ) {
        const preferredRaw = options?.preferredFileName?.trim();
        if (preferredRaw) {
            const sanitizedPreferred = this.sanitizeFileName(preferredRaw);
            const preferredParsed = path.parse(sanitizedPreferred);
            const preferredBase = preferredParsed.name || 'certification';
            const preferredExt = preferredParsed.ext || this.resolveExtension(file, safeOriginalName);
            const preferredName = `${preferredBase}${preferredExt}`;

            if (options?.overwrite) {
                await this.removeConflictingFiles(targetDir, preferredBase);
                return preferredName;
            }

            const preferredPath = path.join(targetDir, preferredName);
            try {
                await fs.access(preferredPath);
                const timestamp = new Date().getTime();
                return `${timestamp}-${preferredName}`;
            } catch {
                return preferredName;
            }
        }

        const targetPath = path.join(targetDir, safeOriginalName);
        try {
            await fs.access(targetPath);
            const timestamp = new Date().getTime();
            return `${timestamp}-${safeOriginalName}`;
        } catch {
            return safeOriginalName;
        }
    }

    private async removeConflictingFiles(targetDir: string, baseName: string) {
        try {
            const files = await fs.readdir(targetDir);
            const lowerBase = baseName.toLowerCase();
            await Promise.all(
                files.map(async (filename) => {
                    const parsed = path.parse(filename);
                    if (parsed.name.toLowerCase() === lowerBase) {
                        await fs.unlink(path.join(targetDir, filename));
                    }
                })
            );
        } catch (error) {
            this.logger.warn(`Failed to remove conflicting files in ${targetDir}: ${error.message}`);
        }
    }

    async saveMetadata(userId: string, parsedData: any) {
        const baseDir = await this.findBaseDirByOwner(userId);
        if (!baseDir) {
            this.logger.warn(`No base directory found for user ${userId}, cannot save metadata`);
            return;
        }

        const metadataPath = path.join(baseDir, 'metadata.json');
        let existingMetadata: any = {};
        try {
            const existingRaw = await fs.readFile(metadataPath, 'utf8');
            existingMetadata = JSON.parse(existingRaw);
        } catch {
            existingMetadata = {};
        }

        // Build enhanced metadata with summary fields
        const firstName = parsedData.structured_data?.first_name || '';
        const lastName = parsedData.structured_data?.last_name || '';
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

        // Remove the PDF metadata section
        const cleanedData = { ...parsedData };
        delete cleanedData.metadata;

        const dedupeTextList = (values: any[]) => {
            const normalized = values
                .map((value: any) => (value == null ? '' : String(value).trim()))
                .filter((value: string) => value.length > 0);

            const output: string[] = [];
            const seenKeys = new Set<string>();
            for (const value of normalized) {
                const key = value
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase();
                if (seenKeys.has(key)) {
                    continue;
                }
                seenKeys.add(key);
                output.push(value);
            }
            return output;
        };

        const normalizeKey = (value: string) =>
            value
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim();

        const toCertificationEntry = (
            cert: any,
            forceUploaded?: boolean
        ): CertificationMetadataEntry | null => {
            if (cert == null) return null;
            if (typeof cert === 'string') {
                const name = cert.trim();
                if (!name) return null;
                return { name, is_uploaded: Boolean(forceUploaded) };
            }
            if (typeof cert !== 'object') return null;

            const name = String(cert.name || cert.certification_name || '').trim();
            if (!name) return null;

            const isUploaded = forceUploaded ?? Boolean(cert.is_uploaded ?? cert.isUploaded);
            const issuer = String(
                cert.issuer || cert.issuing_organization || cert.issuingOrganization || ''
            ).trim();
            const issueDate = String(
                cert.issue_date || cert.date_obtained || cert.issueDate || ''
            ).trim();
            const dateObtained = String(
                cert.date_obtained || cert.dateObtained || ''
            ).trim();
            const expiration = String(
                cert.expiration || cert.expiration_date || cert.expiry_date || cert.expirationDate || ''
            ).trim();
            const credentialId = String(
                cert.credential_id || cert.credentialId || ''
            ).trim();

            const entry: CertificationMetadataEntry = {
                name,
                is_uploaded: Boolean(isUploaded),
            };

            if (issuer) entry.issuer = issuer;
            if (issueDate) entry.issue_date = issueDate;
            if (dateObtained && dateObtained !== issueDate) entry.date_obtained = dateObtained;
            if (expiration) entry.expiration = expiration;
            if (credentialId) entry.credential_id = credentialId;
            return entry;
        };

        const mergeCertifications = (
            base: CertificationMetadataEntry[],
            incoming: CertificationMetadataEntry[]
        ) => {
            const merged = new Map<string, CertificationMetadataEntry>();

            const upsert = (entry: CertificationMetadataEntry) => {
                const key = normalizeKey(entry.name);
                if (!key) return;
                const existing = merged.get(key);
                if (!existing) {
                    merged.set(key, { ...entry });
                    return;
                }
                merged.set(key, {
                    ...existing,
                    name: existing.name || entry.name,
                    issuer: existing.issuer || entry.issuer,
                    issue_date: existing.issue_date || entry.issue_date,
                    date_obtained: existing.date_obtained || entry.date_obtained,
                    expiration: existing.expiration || entry.expiration,
                    credential_id: existing.credential_id || entry.credential_id,
                    is_uploaded: Boolean(existing.is_uploaded || entry.is_uploaded),
                });
            };

            base.forEach(upsert);
            incoming.forEach(upsert);
            return Array.from(merged.values());
        };

        // Keep top-level skills aligned with structured_data.skills for UI/API consumers.
        const rawSkills = Array.isArray(parsedData?.structured_data?.skills)
            ? parsedData.structured_data.skills
            : [];
        const dedupedSkills = dedupeTextList(rawSkills);

        const existingCertificationsRaw = Array.isArray(existingMetadata?.certifications)
            ? existingMetadata.certifications
            : [];
        const existingCertifications = existingCertificationsRaw
            .map((cert: any) => toCertificationEntry(cert))
            .filter(Boolean) as CertificationMetadataEntry[];

        const verifiedCertifications = existingCertifications.filter((cert) => cert.is_uploaded);

        const parsedCertificationsRaw = [
            ...(Array.isArray(parsedData?.structured_data?.certifications)
                ? parsedData.structured_data.certifications
                : []),
            ...(Array.isArray(parsedData?.certifications) ? parsedData.certifications : []),
        ];
        const parsedCertifications = parsedCertificationsRaw
            .map((cert: any) => toCertificationEntry(cert, false))
            .filter(Boolean) as CertificationMetadataEntry[];

        // Keep only verified (uploaded) certifications from prior metadata,
        // then add the newly parsed CV certifications.
        const mergedCertifications = mergeCertifications(verifiedCertifications, parsedCertifications);

        const enhancedMetadata = {
            ...existingMetadata,
            ...cleanedData,
            name: fullName,
            skills: dedupedSkills,
            certifications: mergedCertifications,
            experience_years: typeof existingMetadata.experience_years === 'number' ? existingMetadata.experience_years : 0,
            last_update: new Date().toISOString(),
        };

        await fs.writeFile(metadataPath, JSON.stringify(enhancedMetadata, null, 2));
        this.logger.log(`Saved parsed CV metadata to ${metadataPath}`);
    }

    async updateExperienceYearsInMetadata(userId: string, experienceYears: number | null) {
        if (typeof experienceYears !== 'number' || !Number.isFinite(experienceYears)) {
            return;
        }

        const baseDir = await this.findBaseDirByOwner(userId);
        if (!baseDir) {
            this.logger.warn(`No base directory found for user ${userId}, cannot update experience years`);
            return;
        }

        const metadataPath = path.join(baseDir, 'metadata.json');
        let metadata: any = {};
        try {
            const raw = await fs.readFile(metadataPath, 'utf8');
            metadata = JSON.parse(raw);
        } catch {
            metadata = {};
        }

        metadata.experience_years = Math.max(0, Math.floor(experienceYears));
        metadata.last_update = new Date().toISOString();

        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        this.logger.log(`Updated metadata experience_years to ${metadata.experience_years} for user ${userId}`);
    }

    async addCertificationToMetadata(
        userId: string,
        certData: {
            name: string;
            issuer?: string;
            issue_date?: string;
            date_obtained?: string;
            expiration?: string;
            credential_id?: string;
        }
    ) {
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

            // Normalize existing entries to objects { name, issuer?, issue_date?, expiration? }
            metadata.certifications = metadata.certifications.map((cert: any) => {
                if (typeof cert === 'string') {
                    return { name: cert, is_uploaded: false };
                }
                if (cert && typeof cert === 'object') {
                    return {
                        ...cert,
                        name: cert.name || cert.certification_name || '',
                        is_uploaded: Boolean(cert.is_uploaded ?? cert.isUploaded),
                    };
                }
                return cert;
            });

            const certNameKey = (certData.name || '').trim().toLowerCase();
            const existingIndex = metadata.certifications.findIndex((cert: any) => {
                const existingName = typeof cert === 'string' ? cert : cert?.name;
                return String(existingName || '').trim().toLowerCase() === certNameKey;
            });

            const certificationPayload = {
                name: certData.name,
                issuer: certData.issuer,
                issue_date: certData.issue_date,
                date_obtained: certData.date_obtained ?? certData.issue_date,
                expiration: certData.expiration,
                credential_id: certData.credential_id,
                is_uploaded: true,
            };

            if (existingIndex >= 0) {
                const current = metadata.certifications[existingIndex] || {};
                metadata.certifications[existingIndex] = {
                    ...current,
                    ...certificationPayload,
                    is_uploaded: Boolean(current.is_uploaded || certificationPayload.is_uploaded),
                };
            } else {
                metadata.certifications.push(certificationPayload);
            }

            // Update timestamp
            metadata.last_update = new Date().toISOString();

            // Write back to file
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            this.logger.log(`Updated metadata with certification payload: ${JSON.stringify(certificationPayload)}`);

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

    /**
     * Returns the full raw metadata.json content (including structured_data) for a user.
     */
    async getRawMetadata(userId: string): Promise<any | null> {
        const baseDir = await this.findBaseDirByOwner(userId);
        if (!baseDir) return null;

        const metadataPath = path.join(baseDir, 'metadata.json');
        try {
            const raw = await fs.readFile(metadataPath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    public getWorkspaceRoot(): string {
        // 1. Honor injected environment variable (highest priority)
        if (process.env.PROJECT_ROOT) {
            return path.resolve(process.env.PROJECT_ROOT);
        }

        // 2. Production container heuristic: in Docker, WORKDIR is often /app
        // We look for the main markers directly at /app if they aren't found relative to __dirname
        if (existsSync('/app/package.json') && existsSync('/app/file-storage')) {
            return '/app';
        }

        // 3. Recursive directory search (standard for local dev)
        let currentIdx = __dirname;
        while (currentIdx !== path.parse(currentIdx).root) {
            const potentialRoot = currentIdx;
            if (existsSync(path.join(potentialRoot, 'backend')) && 
                existsSync(path.join(potentialRoot, 'file-storage'))) {
                return potentialRoot;
            }
            currentIdx = path.dirname(currentIdx);
        }

        // 4. Fallback: resolve based on typical NestJS build output depth (dist/src/...)
        return path.resolve(__dirname, '..', '..', '..');
    }

    private getStorageRoot() {
        return path.resolve(this.getWorkspaceRoot(), 'file-storage', 'CV_Database');
    }

    private sanitizeFileName(name: string) {
        return name.replace(/[^a-zA-Z0-9.-]/g, '_');
    }

    public resolveFromWorkspace(filePath: string) {
        if (!filePath) return '';
        if (path.isAbsolute(filePath)) return filePath;
        
        let cleanedPath = filePath;

        // Backwards compatibility for old database entries that were saved
        // relative to the "backend" folder (starting with ../)
        if (cleanedPath.startsWith('..\\')) cleanedPath = cleanedPath.substring(3);
        if (cleanedPath.startsWith('../')) cleanedPath = cleanedPath.substring(3);

        // EXTRA SAFETY FOR CONTAINERS: 
        // If the path starts with 'app/' or 'app\', it likely suffered from the 
        // root-detection bug where the root resolved to '/' instead of '/app'.
        if (cleanedPath.startsWith('app/') || cleanedPath.startsWith('app\\')) {
            cleanedPath = cleanedPath.substring(4);
        }
        
        // All relative paths in the DB should be resolved from the workspace root
        return path.resolve(this.getWorkspaceRoot(), cleanedPath);
    }

    private buildSafeFolderName(name: string, userId: string) {
        const normalized = name
            .trim()
            .replace(/\s+/g, ' ')
            .split(' ')
            .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
            .join('_');

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

    async ensureEmployeeBaseDir(userId: string): Promise<string> {
        const user = await this.usersService.findById(userId);
        const existingBaseDir = await this.findBaseDirByOwner(user.user_id);
        if (existingBaseDir) {
            return existingBaseDir;
        }
        const fallbackName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
            || user.email?.split('@')[0]
            || 'employee';
        return this.resolveEmployeeBaseDir(fallbackName, user.user_id, user.email);
    }

    async getGeneratedCvDir(userId: string): Promise<string> {
        const baseDir = await this.ensureEmployeeBaseDir(userId);
        const generatedDir = path.join(baseDir, 'generated-cvs');
        await fs.mkdir(generatedDir, { recursive: true });
        return generatedDir;
    }

    getTemplatesRootDir(): string {
        return path.resolve(this.getWorkspaceRoot(), 'file-storage', 'templates');
    }

    async saveTemplateFile(file: Express.Multer.File, preferredName?: string) {
        const rootDir = this.getTemplatesRootDir();
        await fs.mkdir(rootDir, { recursive: true });

        const originalName = file.originalname || 'template';
        const preferredSafe = preferredName ? this.sanitizeFileName(preferredName) : '';
        const preferredParsed = preferredSafe ? path.parse(preferredSafe) : null;
        const originalParsed = path.parse(this.sanitizeFileName(originalName));
        const ext = preferredParsed?.ext || originalParsed.ext || this.resolveExtension(file, originalName) || '.docx';
        const safeBase = preferredParsed?.name || originalParsed.name || 'template';
        const filename = `${safeBase}-${Date.now()}${ext}`;
        const fullPath = path.join(rootDir, filename);
        await fs.writeFile(fullPath, file.buffer);

        return {
            fullPath,
            filename,
            relativePath: path.relative(this.getWorkspaceRoot(), fullPath),
        };
    }

    async replicateTemplateFile(existingPath: string, preferredName?: string) {
        const absPath = this.resolveFromWorkspace(existingPath);
        const rootDir = this.getTemplatesRootDir();
        await fs.mkdir(rootDir, { recursive: true });

        const parsed = path.parse(absPath);
        const safeBase = this.sanitizeFileName(preferredName || parsed.name || 'template');
        const filename = `${safeBase}-${Date.now()}${parsed.ext || '.docx'}`;
        const fullPath = path.join(rootDir, filename);
        await fs.copyFile(absPath, fullPath);

        return {
            fullPath,
            filename,
            relativePath: path.relative(this.getWorkspaceRoot(), fullPath),
        };
    }
}
