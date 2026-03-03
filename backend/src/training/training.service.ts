import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TrainingSession, TrainingStatus } from './training-session.entity';
import { CreateTrainingDto } from './dto/create-training.dto';
import { UpdateTrainingStatusDto } from './dto/update-training-status.dto';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { User } from '../users/entities/user.entity';
import { Certification, CertificationStatus } from '../certifications/entities/certification.entity';
import { FileStorageService } from '../file-storage/file-storage.service';
import { FileValidationService } from '../file-validation/file-validation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamsService } from '../teams/teams.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosResponse } from 'axios';
import * as FormDataNode from 'form-data';

@Injectable()
export class TrainingService {
    private readonly logger = new Logger(TrainingService.name);
    private readonly nameMatchThreshold = 0.82;

    constructor(
        @InjectRepository(TrainingSession)
        private readonly trainingRepo: Repository<TrainingSession>,
        @InjectRepository(EmployeeProfile)
        private readonly profilesRepo: Repository<EmployeeProfile>,
        @InjectRepository(User)
        private readonly usersRepo: Repository<User>,
        @InjectRepository(Certification)
        private readonly certificationRepo: Repository<Certification>,
        private readonly fileStorageService: FileStorageService,
        private readonly fileValidationService: FileValidationService,
        private readonly notificationsService: NotificationsService,
        private readonly teamsService: TeamsService,
        private readonly mailService: MailService,
        private readonly configService: ConfigService,
    ) { }

    async assignTraining(dto: CreateTrainingDto, managerUserId?: string, managerEmail?: string) {
        const profiles = await this.profilesRepo.find({
            where: { profile_id: In(dto.assigneeProfileIds) },
            relations: ['user'],
        });
        if (profiles.length !== dto.assigneeProfileIds.length) {
            throw new NotFoundException('One or more assignee profiles not found');
        }

        const assignedBy = managerUserId
            ? await this.usersRepo.findOne({ where: { user_id: managerUserId } })
            : null;
        const managerName = assignedBy
            ? [assignedBy.firstName, assignedBy.lastName].filter(Boolean).join(' ')
            : null;

        const rows = profiles.map((profile) =>
            this.trainingRepo.create({
                profile,
                trainingTitle: dto.trainingTitle,
                provider: dto.provider,
                trainingUrl: dto.trainingUrl,
                dueDate: dto.dueDate,
                description: dto.description,
                status: 'assigned',
                assignedBy: managerEmail || assignedBy?.email || null,
            }),
        );

        const saved = await this.trainingRepo.save(rows);

        // Notifications to assignees
        await Promise.all(
            saved.map((row) =>
                this.notificationsService.create({
                    userId: row.profile?.user?.user_id || '',
                    type: 'training_assigned',
                    title: 'New training assigned',
                    message: `${row.trainingTitle}${row.dueDate ? ` · Due ${row.dueDate}` : ''}`,
                    relatedEntityType: 'training_session',
                    relatedEntityId: row.training_id,
                })
            )
        );

        await Promise.all(
            saved.map((row) => {
                const to = row.profile?.user?.email;
                if (!to) return Promise.resolve();
                return this.mailService.sendTrainingAssignedEmail({
                    to,
                    trainingTitle: row.trainingTitle,
                    trainingUrl: row.trainingUrl,
                    dueDate: row.dueDate || undefined,
                    managerName,
                    managerEmail: managerEmail || assignedBy?.email || undefined,
                });
            })
        );

        return saved;
    }

    async listForEmployee(profileId: string) {
        return this.trainingRepo.find({
            where: { profile: { profile_id: profileId } },
            order: { createdAt: 'DESC' },
        });
    }

    async listForUser(userId: string) {
        const profile = await this.profilesRepo.findOne({
            where: { user: { user_id: userId } },
        });
        if (!profile) {
            throw new NotFoundException('Profile not found for user');
        }
        return this.listForEmployee(profile.profile_id);
    }

    async listAssignedByUser(email?: string, userId?: string) {
        let managerEmail = email;
        if (!managerEmail && userId) {
            const user = await this.usersRepo.findOne({ where: { user_id: userId } });
            managerEmail = user?.email;
        }
        if (!managerEmail) return [];

        const rows = await this.trainingRepo.find({
            where: { assignedBy: managerEmail },
            relations: { profile: { user: true } },
            order: { createdAt: 'DESC' },
        });

        // Enrich with latest uploaded certification matching training title
        return Promise.all(
            rows.map(async (row) => {
                const cert = await this.certificationRepo.findOne({
                    where: {
                        profile: { profile_id: row.profile?.profile_id },
                        certificationName: row.trainingTitle,
                        isUploaded: true,
                    },
                    order: { issueDate: 'DESC' },
                });
                return {
                    ...row,
                    certificationName: cert?.certificationName,
                    certificationIssueDate: cert?.issueDate || undefined,
                };
            })
        );
    }

    async updateStatus(trainingId: string, dto: UpdateTrainingStatusDto, actorProfileId?: string) {
        const training = await this.trainingRepo.findOne({
            where: { training_id: trainingId },
            relations: ['profile', 'profile.user'],
        });
        if (!training) {
            throw new NotFoundException('Training session not found');
        }

        if (actorProfileId && training.profile?.profile_id !== actorProfileId) {
            throw new NotFoundException('Training session not found for this user');
        }

        training.status = dto.status;

        if (dto.status === 'in_progress') {
            training.startDate = new Date().toISOString().slice(0, 10);
            const employeeUserId = training.profile?.user?.user_id;
            if (employeeUserId) {
                const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
                const employeeName =
                    [training.profile?.user?.firstName, training.profile?.user?.lastName]
                        .filter(Boolean)
                        .join(' ') ||
                    training.profile?.user?.email ||
                    'Employee';
                await Promise.all(
                    managers.map((mgrId) =>
                        this.notificationsService.create({
                            userId: mgrId,
                            type: 'training_started',
                            title: 'Training started',
                            message: `${employeeName} started ${training.trainingTitle} training`,
                            relatedEntityType: 'training_session',
                            relatedEntityId: training.training_id,
                        })
                    )
                );
            }
        }

        if (dto.status === 'completed') {
            training.endDate = dto.endDate ?? new Date().toISOString().slice(0, 10);
            training.description = dto.description ?? training.description;
            const employeeUserId = training.profile?.user?.user_id;
            if (employeeUserId) {
                const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
                const employeeName =
                    [training.profile?.user?.firstName, training.profile?.user?.lastName]
                        .filter(Boolean)
                        .join(' ') ||
                    training.profile?.user?.email ||
                    'Employee';
                await Promise.all(
                    managers.map((mgrId) =>
                        this.notificationsService.create({
                            userId: mgrId,
                            type: 'training_completed',
                            title: 'Training completed',
                            message: `${employeeName} completed ${training.trainingTitle} training${dto.description ? ` · Comment: ${dto.description}` : ''}`,
                            relatedEntityType: 'training_session',
                            relatedEntityId: training.training_id,
                        })
                    )
                );
            }
        }

        training.proofFilePath = dto.proofFilePath ?? training.proofFilePath;
        return this.trainingRepo.save(training);
    }

    async uploadProof(
        trainingId: string,
        file: Express.Multer.File,
        userId: string,
        issueDate?: string,
        description?: string,
    ) {
        const training = await this.trainingRepo.findOne({
            where: { training_id: trainingId },
            relations: { profile: { user: true } },
        });
        if (!training) {
            throw new NotFoundException('Training session not found');
        }
        if (training.profile?.user?.user_id !== userId) {
            throw new NotFoundException('Training session not found for this user');
        }

        await this.fileValidationService.validate(file, 'certification');

        // ✅ Validate buffer is not empty before sending to AI
        if (!file.buffer || file.buffer.length === 0) {
            throw new BadRequestException('Uploaded file is empty');
        }

        const manualDate = issueDate ? this.toDateOrThrow(issueDate, 'Invalid issue date') : null;

        // ✅ AI parsing — errors now propagate properly (not silently caught as fallback)
        const aiCert = await this.extractCertMetadataFromFile(
            file,
            userId,
            training.profile?.user?.firstName,
            training.profile?.user?.lastName,
            manualDate,
        );

        const parsedIssueDate = aiCert?.issueDate ?? null;
        const parsedName = aiCert?.name ?? null;
        const parsedIssuer = aiCert?.issuer ?? null;
        const parsedExpirationDate = aiCert?.expirationDate ?? null;
        const parsedRawText = aiCert?.rawText ?? null;
        const effectiveIssueDate = parsedIssueDate ?? manualDate ?? null;

        this.assertEmployeeNameMatchOrThrow(
            parsedRawText,
            training.profile?.user?.firstName,
            training.profile?.user?.lastName,
        );
        const certName =
            parsedName && parsedName.trim().length > 0
                ? parsedName.trim()
                : training.trainingTitle;

        // Enforce business rules when dates are available
        if (effectiveIssueDate && training.dueDate) {
            const due = new Date(training.dueDate);
            if (!isNaN(due.getTime()) && effectiveIssueDate.getTime() > due.getTime()) {
                throw new BadRequestException('Issue date must be on or before the due date');
            }
        }

        const storage = await this.fileStorageService.saveEmployeeFile(userId, file, 'Certifications');

        training.proofFilePath = storage.path;
        training.status = 'completed';
        training.endDate = new Date().toISOString().slice(0, 10);
        training.description = description ?? training.description;

        await this.trainingRepo.save(training);

        const issuerUsed = parsedIssuer && parsedIssuer.trim() ? parsedIssuer.trim() : training.provider || null;

        this.logger.log(
            `AI parsing result received: name="${parsedName || ''}" issuer="${parsedIssuer || ''}" issue_date="${parsedIssueDate ? parsedIssueDate.toISOString().slice(0, 10) : ''}"`
        );
        this.logger.log(
            `AI sanitized values: name="${certName}" issuer="${issuerUsed || ''}" issue_date="${effectiveIssueDate ? effectiveIssueDate.toISOString().slice(0, 10) : ''}"`
        );

        // Persist certification record
        const cert = this.certificationRepo.create({
            profile: training.profile,
            certificationName: certName,
            issuingOrganization: issuerUsed,
            issueDate: effectiveIssueDate,
            expirationDate: parsedExpirationDate,
            status: CertificationStatus.ACTIVE,
            filePath: storage.path,
            credentialId: training.trainingUrl || null,
            isUploaded: true,
        });
        await this.certificationRepo.save(cert);

        // Update metadata.json
        const issueDateIso = effectiveIssueDate ? effectiveIssueDate.toISOString().slice(0, 10) : undefined;
        const metadataName = certName;
        const metadataIssuer = issuerUsed || undefined;
        const metadataPayload = {
            name: metadataName,
            issuer: metadataIssuer,
            issue_date: issueDateIso,
            date_obtained: issueDateIso,
            expiration: cert.expirationDate ? cert.expirationDate.toISOString().slice(0, 10) : undefined,
        };

        await this.fileStorageService.addCertificationToMetadata(userId, metadataPayload);

        this.logger.log(
            `Metadata write payload: ${JSON.stringify(metadataPayload)}`
        );

        // Notify managers
        const employeeUserId = training.profile?.user?.user_id;
        if (employeeUserId) {
            const managers = await this.teamsService.getManagersForEmployee(employeeUserId);
            const employeeName =
                [training.profile?.user?.firstName, training.profile?.user?.lastName]
                    .filter(Boolean)
                    .join(' ') ||
                training.profile?.user?.email ||
                'Employee';
            await Promise.all(
                managers.map((mgrId) =>
                    this.notificationsService.create({
                        userId: mgrId,
                        type: 'training_completed',
                        title: 'Training completed',
                        message: `${employeeName} completed ${training.trainingTitle} training`,
                        relatedEntityType: 'training_session',
                        relatedEntityId: training.training_id,
                    })
                )
            );
        }

        return {
            trainingId: training.training_id,
            status: training.status,
            proofFilePath: training.proofFilePath,
        };
    }

    private toDateOrThrow(value: string, message: string): Date {
        const d = new Date(value);
        if (isNaN(d.getTime())) {
            throw new BadRequestException(message);
        }
        return d;
    }

    /**
     * Extract issue date, name and issuer from the uploaded certification using the AI service.
     *
     * KEY FIXES vs previous version:
     *  1. Uses native FormData + Blob in Node.js fetch for valid multipart boundaries.
     *  2. HTTP errors (resp.ok === false) now THROW instead of silently returning null/fallback.
     *  3. Network/timeout errors throw to prevent premature metadata writes.
     *  4. JSON parse errors throw so the caller knows something is wrong upstream.
     *  5. Full raw response is logged at debug level for easy diagnosis.
     */
    private async extractCertMetadataFromFile(
        file: Express.Multer.File,
        userId: string,
        firstName?: string,
        lastName?: string,
        manualIssueDate: Date | null = null,
    ): Promise<{ issueDate: Date | null; name?: string | null; issuer?: string | null; expirationDate?: Date | null; rawText?: string | null }> {
        const aiBase =
            this.configService.get<string>('AI_SERVICE_URL')?.replace(/\/+$/, '') ||
            'http://127.0.0.1:8000';
        const timeoutFromEnv = Number(
            this.configService.get<string>('AI_CERT_PARSE_TIMEOUT_MS') || '300000'
        );
        const timeoutMs =
            Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0 ? timeoutFromEnv : 300000;
        const maxAttemptsFromEnv = Number(
            this.configService.get<string>('AI_CERT_PARSE_MAX_ATTEMPTS') || '3'
        );
        const maxAttempts =
            Number.isFinite(maxAttemptsFromEnv) && maxAttemptsFromEnv > 0 ? Math.floor(maxAttemptsFromEnv) : 3;

        // ─── Build multipart form (Node.js-compatible) ────────────────────────────
        const form = new FormDataNode();
        form.append('user_id', userId);
        if (firstName) form.append('first_name', firstName);
        if (lastName) form.append('last_name', lastName);
        form.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype || 'application/octet-stream',
        });

        this.logger.debug(
            `Sending file to AI service: name="${file.originalname}" size=${file.buffer.length}B mimetype="${file.mimetype}" timeoutMs=${timeoutMs}`
        );

        // ─── HTTP call ────────────────────────────────────────────────────────────
        let resp: AxiosResponse<any> | null = null;
        let lastNetworkErrorDetails = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                resp = await axios.post(
                    `${aiBase}/api/v1/parsing/certification`,
                    form,
                    {
                        headers: form.getHeaders(),
                        timeout: timeoutMs,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity,
                        validateStatus: () => true,
                    },
                );
                break;
            } catch (err) {
                const base = err instanceof Error ? err.message : String(err);
                const cause =
                    err && typeof err === 'object' && 'cause' in err
                        ? String((err as { cause?: unknown }).cause ?? '')
                        : '';
                lastNetworkErrorDetails = cause ? `${base}; cause=${cause}` : base;
                this.logger.warn(
                    `AI service network failure (attempt ${attempt}/${maxAttempts}): ${lastNetworkErrorDetails}`
                );
                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                }
            }
        }

        if (!resp) {
            this.logger.error(`AI service unreachable after retries: ${lastNetworkErrorDetails || 'unknown error'}`);
            throw new ServiceUnavailableException(
                'AI parsing did not complete. Please retry once the AI service is available.'
            );
        }

        // ─── HTTP error — do NOT silently fall back, throw so caller is aware ─────
        if (resp.status < 200 || resp.status >= 300) {
            const body =
                typeof resp.data === 'string'
                    ? resp.data
                    : JSON.stringify(resp.data ?? {});
            this.logger.error(
                `AI cert parse HTTP error — status=${resp.status} body="${body}"`
            );
            // Throwing here propagates to uploadProof → user gets a proper error message
            throw new BadRequestException(
                `AI parsing service returned an error (${resp.status}). Please retry or contact support.`
            );
        }

        // ─── Parse JSON response ──────────────────────────────────────────────────
        const data: any = resp.data;
        if (!data || typeof data !== 'object') {
            this.logger.error(`AI service returned non-JSON response: ${String(data)}`);
            throw new BadRequestException('AI parsing service returned an invalid response. Please retry.');
        }

        // ✅ Log the raw AI response so you can see exactly what comes back
        this.logger.debug(`AI raw response: ${JSON.stringify(data)}`);

        // ─── Extract fields (support both flat and nested `metadata` structures) ──
        const dateStr: string | null =
            data.issue_date ||
            data.date_obtained ||
            data?.metadata?.date_obtained ||
            data?.metadata?.issue_date ||
            null;

        let parsedDate: Date | null = null;
        if (dateStr) {
            const parsed = new Date(dateStr);
            if (!isNaN(parsed.getTime())) {
                parsedDate = parsed;
            } else {
                this.logger.warn(`AI returned an unparseable date string: "${dateStr}"`);
            }
        } else {
            this.logger.warn('AI response contained no date field — will use manual date or null');
        }

        const name: string | null =
            data.certification_name ||
            data?.metadata?.certification_name ||
            data.name ||
            data?.metadata?.name ||
            null;

        const issuer: string | null =
            data.issuer ||
            data?.metadata?.issuer ||
            null;
        const expirationDateStr: string | null =
            data.expiration_date ||
            data.expiration ||
            data?.metadata?.expiration_date ||
            data?.metadata?.expiration ||
            null;
        let parsedExpirationDate: Date | null = null;
        if (expirationDateStr) {
            const parsed = new Date(expirationDateStr);
            if (!isNaN(parsed.getTime())) {
                parsedExpirationDate = parsed;
            }
        }

        this.logger.log(
            `AI extraction result: name="${name ?? 'null'}" issuer="${issuer ?? 'null'}" issue_date="${dateStr ?? 'null'}" expiration="${expirationDateStr ?? 'null'}"`
        );

        return {
            issueDate: parsedDate ?? manualIssueDate,
            name,
            issuer,
            expirationDate: parsedExpirationDate,
            rawText: typeof data.raw_text === 'string' ? data.raw_text : null,
        };
    }

    async getProofFile(trainingId: string, userId: string, userEmail?: string) {
        const training = await this.trainingRepo.findOne({
            where: { training_id: trainingId },
            relations: { profile: { user: true } },
        });
        if (!training) {
            throw new NotFoundException('Training session not found');
        }

        const isOwner = training.profile?.user?.user_id === userId;
        const isAssigner = !!userEmail && training.assignedBy === userEmail;
        if (!isOwner && !isAssigner) {
            throw new NotFoundException('Training session not found for this user');
        }

        if (!training.proofFilePath) {
            throw new NotFoundException('No proof file uploaded');
        }

        const absPath = path.isAbsolute(training.proofFilePath)
            ? training.proofFilePath
            : path.join(process.cwd(), training.proofFilePath);

        if (!fs.existsSync(absPath)) {
            throw new NotFoundException('Proof file not found on disk');
        }

        const ext = path.extname(absPath).toLowerCase();
        const mime =
            ext === '.pdf'
                ? 'application/pdf'
                : ext === '.png'
                    ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                        ? 'image/jpeg'
                        : 'application/octet-stream';

        const stream = fs.createReadStream(absPath);
        const filename = path.basename(absPath);
        return { stream, mime, filename };
    }

    private assertEmployeeNameMatchOrThrow(rawText: string | null, firstName?: string, lastName?: string) {
        const first = (firstName || '').trim();
        const last = (lastName || '').trim();
        if (!first || !last) return;
        if (!rawText || !rawText.trim()) {
            throw new BadRequestException('Unable to verify certificate owner name from parsed document.');
        }

        const normalizedText = this.normalizeForMatch(rawText);
        const expected = this.normalizeForMatch(`${first} ${last}`);
        const reversed = this.normalizeForMatch(`${last} ${first}`);
        if (normalizedText.includes(expected) || normalizedText.includes(reversed)) {
            return;
        }

        const words = normalizedText.split(' ').filter(Boolean);
        const nameWords = expected.split(' ').filter(Boolean);
        const minWindow = Math.max(1, nameWords.length - 1);
        const maxWindow = nameWords.length + 1;
        let best = 0;
        for (let size = minWindow; size <= maxWindow; size++) {
            for (let i = 0; i <= words.length - size; i++) {
                const window = words.slice(i, i + size).join(' ');
                const score = Math.max(
                    this.similarity(window, expected),
                    this.similarity(window, reversed),
                );
                if (score > best) best = score;
                if (score >= this.nameMatchThreshold) return;
            }
        }

        this.logger.warn(`Name match failed for profile name "${first} ${last}", bestScore=${best.toFixed(3)}`);
        throw new BadRequestException('Certificate owner name does not match your profile name.');
    }

    private normalizeForMatch(value: string): string {
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private similarity(a: string, b: string): number {
        const distance = this.levenshteinDistance(a, b);
        const maxLen = Math.max(a.length, b.length);
        return maxLen ? 1 - distance / maxLen : 1;
    }

    private levenshteinDistance(a: string, b: string): number {
        const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost,
                );
            }
        }
        return dp[a.length][b.length];
    }
}
