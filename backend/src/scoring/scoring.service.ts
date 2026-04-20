import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as FormData from 'form-data';

import { DocumentHash } from './entities/document-hash.entity';
import { ProjectRecord } from './entities/project-record.entity';
import { TrainingRecord } from './entities/training-record.entity';
import { ScoringTarget } from './entities/scoring-target.entity';
import { ScoringWeight } from './entities/scoring-weight.entity';
import { EmployeeScore } from './entities/employee-score.entity';
import { EmployeeProfile } from '../employees/entities/employee-profile.entity';
import { Certification } from '../certifications/entities/certification.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { TrainingSession } from '../training/training-session.entity';
import { ProjectParticipant, ParticipantRole } from '../projects/entities/participant.entity';
import { Project } from '../projects/entities/project.entity';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private readonly aiServiceBaseUrl: string;

  constructor(
    @InjectRepository(DocumentHash)
    private readonly docHashRepo: Repository<DocumentHash>,
    @InjectRepository(ProjectRecord)
    private readonly projectRecordRepo: Repository<ProjectRecord>,
    @InjectRepository(TrainingRecord)
    private readonly trainingRecordRepo: Repository<TrainingRecord>,
    @InjectRepository(ScoringTarget)
    private readonly targetRepo: Repository<ScoringTarget>,
    @InjectRepository(ScoringWeight)
    private readonly weightRepo: Repository<ScoringWeight>,
    @InjectRepository(EmployeeScore)
    private readonly scoreRepo: Repository<EmployeeScore>,
    @InjectRepository(EmployeeProfile)
    private readonly profileRepo: Repository<EmployeeProfile>,
    @InjectRepository(Certification)
    private readonly certRepo: Repository<Certification>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(TrainingSession)
    private readonly trainingSessionRepo: Repository<TrainingSession>,
    @InjectRepository(ProjectParticipant)
    private readonly participantRepo: Repository<ProjectParticipant>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.aiServiceBaseUrl =
      this.configService.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
  }

  // ── PV Upload (Team Manager → employee's profile) ──────────────────

  async uploadPv(
    file: Express.Multer.File,
    profileIds: string[],
    managerUserId: string,
    projectId?: string,
    projectName?: string,
    clientName?: string,
    complexity?: 'low' | 'medium' | 'high',
    employeeRole?: 'contributor' | 'technical_lead' | 'project_lead',
  ) {
    if (profileIds.length === 0) {
      throw new BadRequestException('Aucun employé sélectionné pour cet import PV');
    }

    // 1. Validate profiles exist
    const profiles = await this.profileRepo.find({
      where: profileIds.map((profileId) => ({ profile_id: profileId })),
      relations: ['user'],
    });
    const profileMap = new Map(profiles.map((profile) => [profile.profile_id, profile]));
    const missingProfileIds = profileIds.filter((profileId) => !profileMap.has(profileId));
    if (missingProfileIds.length > 0) {
      throw new NotFoundException(`Profils introuvables: ${missingProfileIds.join(', ')}`);
    }

    // 2. Resolve the project (existing or new)
    let resolvedProjectName: string;
    let resolvedClientName: string | null = null;
    let resolvedComplexity = complexity || 'medium';
    let resolvedCompletionDate: Date | null = null;
    const roleByProfileId = new Map<string, 'contributor' | 'technical_lead' | 'project_lead'>();

    if (projectId) {
      // Link to an existing project in the system
      const existingProject = await this.projectRepo.findOne({
        where: { project_id: projectId },
      });
      if (!existingProject) {
        throw new NotFoundException(`Projet ${projectId} non trouvé`);
      }
      resolvedProjectName = existingProject.projectName;
      resolvedClientName = existingProject.clientName || null;
      resolvedComplexity = (existingProject.complexity as any) || resolvedComplexity;
      resolvedCompletionDate = existingProject.endDate || null;

      const participants = await this.participantRepo.find({
        where: profileIds.map((profileId) => ({
          project: { project_id: projectId },
          profile: { profile_id: profileId },
        })),
        relations: ['profile'],
      });

      const participantMap = new Map(
        participants.map((participant) => [participant.profile.profile_id, participant]),
      );

      const invalidProfileIds = profileIds.filter((profileId) => !participantMap.has(profileId));
      if (invalidProfileIds.length > 0) {
        const invalidNames = invalidProfileIds.map((profileId) => {
          const profile = profileMap.get(profileId);
          return profile?.user
            ? `${profile.user.firstName || ''} ${profile.user.lastName || ''}`.trim() || profile.user.email
            : profileId;
        });

        this.logger.warn(
          `PV upload rejected for project ${projectId}: selected employees are not assigned to the project: ${invalidNames.join(', ')}`,
        );
        throw new BadRequestException(
          `Pour un projet déjà assigné, vous pouvez sélectionner uniquement les employés assignés au projet: ${invalidNames.join(', ')}`,
        );
      }

      for (const participant of participants) {
        const participantProfileId = participant.profile.profile_id;
        roleByProfileId.set(
          participantProfileId,
          (participant.role as any) || employeeRole || 'contributor',
        );
      }
    } else {
      // New project not in the system — name is required
      if (!projectName) {
        throw new BadRequestException(
          'Veuillez sélectionner un projet existant ou fournir un nom de projet',
        );
      }
      resolvedProjectName = projectName;
      resolvedClientName = clientName || null;

      for (const profileId of profileIds) {
        roleByProfileId.set(profileId, employeeRole || 'contributor');
      }
    }

    // 3. Call AI service to parse the PDF (for hash + any extra data)
    const formData = new FormData();
    formData.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append('user_id', managerUserId);

    let parsed: any;
    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/parse-document`,
        formData,
        { headers: formData.getHeaders() },
      );
      parsed = aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? 'unknown';
      this.logger.error(`AI parse failed: ${JSON.stringify(errorText)}`);
      throw new BadRequestException(
        `Erreur lors de l'analyse du document: ${JSON.stringify(errorText)}`,
      );
    }

    // 4. Reuse or create document hash once for the whole upload
    const existingHash = await this.docHashRepo.findOne({
      where: { fileHash: parsed.file_hash },
    });

    if (!existingHash) {
      const docHash = this.docHashRepo.create({
        fileHash: parsed.file_hash,
        documentType: parsed.document_type,
        originalFilename: file.originalname,
        uploadedBy: managerUserId,
      });
      await this.docHashRepo.save(docHash);
    } else {
      this.logger.log(
        `Reusing existing PV document hash ${parsed.file_hash.slice(0, 12)}... for ${profileIds.length} employee(s)`,
      );
    }

    // 5. Save one project record per selected employee
    const currentYear = new Date().getFullYear();
    const results: Array<{
      profileId: string;
      employeeName: string;
      status: 'created' | 'duplicate';
      message?: string;
      record?: any;
    }> = [];

    for (const profileId of profileIds) {
      const profile = profileMap.get(profileId)!;
      const resolvedRole = roleByProfileId.get(profileId) || employeeRole || 'contributor';
      const savedRecord = await this.saveProjectRecord(
        profileId,
        {
          ...parsed.parsed_data,
          project_name: resolvedProjectName,
          client_name: resolvedClientName,
          completion_date:
            this.formatDateForScoring(resolvedCompletionDate) || parsed.parsed_data?.completion_date || null,
        },
        parsed.file_hash,
        file.originalname,
        resolvedComplexity,
        resolvedRole,
        true,
        managerUserId,
      );

      const employeeName = profile.user
        ? `${profile.user.firstName || ''} ${profile.user.lastName || ''}`.trim() || profile.user.email
        : profileId;
      const resultStatus: 'created' | 'duplicate' =
        savedRecord.status === 'duplicate' ? 'duplicate' : 'created';

      results.push({
        profileId,
        employeeName,
        status: resultStatus,
        message: savedRecord.message,
        record: savedRecord.record,
      });

      if (resultStatus !== 'created') {
        continue;
      }

      if (profile.user) {
        await this.notificationsService.create({
          userId: profile.user.user_id,
          type: 'pv_uploaded',
          title: 'PV importé pour votre projet',
          message: `Un PV a été importé pour le projet "${resolvedProjectName}". Votre score sera mis à jour.`,
          relatedEntityType: 'project_record',
          relatedEntityId: savedRecord?.record?.record_id,
        }).catch((err) => this.logger.warn(`Notification PV failed for ${profileId}: ${err.message}`));
      }

      try {
        await this.computeScore(profileId, currentYear);
        this.logger.log(`Auto-recomputed score for profile ${profileId} after PV upload`);

        if (profile.user) {
          const updatedScore = await this.scoreRepo.findOne({
            where: { profileId, scoreYear: currentYear },
          });
          await this.notificationsService.create({
            userId: profile.user.user_id,
            type: 'score_updated',
            title: 'Score mis à jour',
            message: `Votre score a été recalculé : ${Number(updatedScore?.finalScore ?? 0).toFixed(1)} pts.`,
            relatedEntityType: 'employee_score',
            relatedEntityId: updatedScore?.score_id,
          }).catch((err) => this.logger.warn(`Notification score failed for ${profileId}: ${err.message}`));
        }
      } catch (err: any) {
        this.logger.warn(`Auto-recompute after PV upload failed for ${profileId}: ${err.message}`);
      }
    }

    const createdCount = results.filter((result) => result.status === 'created').length;
    const duplicateCount = results.length - createdCount;

    return {
      status: createdCount > 0 ? 'created' : 'duplicate',
      message:
        duplicateCount > 0
          ? `PV importé pour ${createdCount} employé(s), ${duplicateCount} doublon(s) ignoré(s).`
          : `PV importé pour ${createdCount} employé(s).`,
      parsed_data: parsed.parsed_data,
      results,
    };
  }

  // ── Training Sheet Upload (Employee → own profile) ────────────────────

  async uploadTrainingSheet(
    file: Express.Multer.File,
    userId: string,
  ) {
    // 1. Find the employee's own profile
    const profile = await this.profileRepo.findOne({
      where: { user: { user_id: userId } },
      relations: ['user'],
    });
    if (!profile) {
      throw new NotFoundException(
        `Aucun profil employé trouvé pour l'utilisateur connecté`,
      );
    }

    // 2. Call AI service to parse document
    const formData = new FormData();
    formData.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append('user_id', userId);

    let parsed: any;
    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/parse-document`,
        formData,
        { headers: formData.getHeaders() },
      );
      parsed = aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? 'unknown';
      this.logger.error(`AI parse failed: ${JSON.stringify(errorText)}`);
      throw new BadRequestException(
        `Erreur lors de l'analyse du document: ${JSON.stringify(errorText)}`,
      );
    }

    if (parsed.document_type !== 'training_sheet') {
      this.logger.warn(
        `Training sheet upload rejected for profile ${profile.profile_id}: detected document type=${parsed.document_type}, file=${file.originalname}`,
      );
      throw new BadRequestException(
        'Le document importé n\'a pas été reconnu comme une feuille de présence formateur.',
      );
    }

    const trainerValidation = this.validateTrainingSheetTrainer(
      parsed.parsed_data,
      profile.user,
    );
    if (!trainerValidation.isValid) {
      this.logger.warn(
        `Training sheet rejected for profile ${profile.profile_id}: ${trainerValidation.reason}; extractedTrainer="${parsed.parsed_data?.trainer_name || 'N/A'}"; expectedEmployee="${this.getEmployeeDisplayName(profile.user)}"; file=${file.originalname}; assumptions=${JSON.stringify(parsed.parsed_data?.assumptions || [])}`,
      );
      throw new BadRequestException(trainerValidation.message);
    }

    // 3. Check for duplicate
    const existingHash = await this.docHashRepo.findOne({
      where: { fileHash: parsed.file_hash },
    });
    if (existingHash) {
      throw new ConflictException(
        'Ce document a déjà été importé (doublon détecté par hash)',
      );
    }

    // 4. Save document hash
    const docHash = this.docHashRepo.create({
      fileHash: parsed.file_hash,
      documentType: 'training_sheet',
      originalFilename: file.originalname,
      uploadedBy: userId,
    });
    await this.docHashRepo.save(docHash);

    // 5. Save training record
    const savedRecord = await this.saveTrainingRecord(
      profile.profile_id,
      parsed.parsed_data,
      parsed.file_hash,
      file.originalname,
    );

    if (savedRecord.status !== 'created') {
      this.logger.warn(
        `Training sheet duplicate for profile ${profile.profile_id}: ${savedRecord.message || 'duplicate detected'}`,
      );
      return savedRecord;
    }

    const currentYear = new Date().getFullYear();
    try {
      await this.computeScore(profile.profile_id, currentYear);
      this.logger.log(
        `Training sheet accepted for profile ${profile.profile_id}; trainer="${parsed.parsed_data?.trainer_name}"; formation score recomputed for ${currentYear}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Training sheet saved for profile ${profile.profile_id} but score recompute failed: ${err.message}`,
      );
    }

    return savedRecord;
  }

  private formatDateForScoring(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString().split('T')[0];
    }

    if (typeof value === 'string') {
      const trimmedValue = value.trim();
      if (!trimmedValue) {
        return null;
      }

      const parsedDate = new Date(trimmedValue);
      return Number.isNaN(parsedDate.getTime())
        ? trimmedValue
        : parsedDate.toISOString().split('T')[0];
    }

    return null;
  }

  private async saveProjectRecord(
    profileId: string,
    parsedData: any,
    fileHash: string,
    filename: string,
    complexity?: string,
    employeeRole?: string,
    pvVerified: boolean = false,
    submittedBy?: string,
  ) {
    const projectName = parsedData.project_name || 'Projet non identifié';
    const clientName = parsedData.client_name || null;
    const completionDate = parsedData.completion_date
      ? new Date(parsedData.completion_date)
      : null;

    // Semantic dedup: check same project+client+date for this employee
    const existingQuery: any = {
      profileId,
      projectName,
      clientName: clientName || IsNull() as any,
    };
    if (completionDate) {
      existingQuery.completionDate = completionDate;
    }
    const existing = await this.projectRecordRepo.findOne({
      where: existingQuery,
    });

    if (existing) {
      this.logger.warn(
        `Projet en double (sémantique): ${projectName} / ${clientName} pour profil ${profileId}`,
      );
      return {
        status: 'duplicate',
        message: `Ce projet (${projectName}) est déjà enregistré pour cet employé à cette date`,
        existing_record: existing,
      };
    }

    // Determine role from parsed data if not provided
    let resolvedRole = employeeRole || 'contributor';
    if (!employeeRole && parsedData.team_members) {
      // Try to find this employee's role from team members
      // (would need name matching — use provided role for now)
    }

    const record = this.projectRecordRepo.create({
      profileId,
      projectName,
      clientName,
      projectDescription: parsedData.organization_context || null,
      completionDate,
      complexity: (complexity as any) || 'medium',
      employeeRole: resolvedRole as any,
      pvVerified,
      submittedBy: submittedBy || null,
      documentHash: fileHash,
      sourceFilename: filename,
      parsedData,
    });

    const saved = await this.projectRecordRepo.save(record);
    return {
      status: 'created',
      record: saved,
      parsed_data: parsedData,
    };
  }

  private async saveTrainingRecord(
    profileId: string,
    parsedData: any,
    fileHash: string,
    filename: string,
  ) {
    const trainingName = parsedData.training_name || 'Formation non identifiée';
    const clientName = parsedData.client_name || null;
    const startDate = parsedData.start_date
      ? new Date(parsedData.start_date)
      : null;

    // Semantic dedup
    const existing = await this.trainingRecordRepo.findOne({
      where: {
        profileId,
        trainingName,
        clientName: clientName || IsNull() as any,
        startDate: startDate || IsNull() as any,
      },
    });

    if (existing) {
      this.logger.warn(
        `Formation en double (sémantique): ${trainingName} / ${clientName} pour profil ${profileId}`,
      );
      return {
        status: 'duplicate',
        message: `Cette formation (${trainingName}) est déjà enregistrée`,
        existing_record: existing,
      };
    }

    const record = this.trainingRecordRepo.create({
      profileId,
      trainingName,
      trainerName: parsedData.trainer_name || null,
      clientName,
      location: parsedData.location || null,
      startDate,
      endDate: parsedData.end_date ? new Date(parsedData.end_date) : null,
      participantCount: parsedData.participant_count || 0,
      documentHash: fileHash,
      sourceFilename: filename,
      parsedData,
    });

    const saved = await this.trainingRecordRepo.save(record);
    this.logger.log(
      `Training record created for profile ${profileId}: training="${trainingName}", trainer="${parsedData.trainer_name || 'N/A'}", startDate=${parsedData.start_date || 'N/A'}`,
    );
    return {
      status: 'created',
      record: saved,
      parsed_data: parsedData,
    };
  }

  private getEmployeeDisplayName(user?: User | null): string {
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
    return name || user?.email || 'employé inconnu';
  }

  private normalizeNameTokens(value?: string | null): string[] {
    return (value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  private trainerMatchesEmployee(trainerName: string, user?: User | null): boolean {
    const trainerTokens = this.normalizeNameTokens(trainerName);
    const employeeTokens = this.normalizeNameTokens(this.getEmployeeDisplayName(user));

    if (trainerTokens.length === 0 || employeeTokens.length === 0) {
      return false;
    }

    if (trainerTokens.join(' ') === employeeTokens.join(' ')) {
      return true;
    }

    if (trainerTokens.length !== employeeTokens.length) {
      return false;
    }

    return [...trainerTokens].sort().join(' ') === [...employeeTokens].sort().join(' ');
  }

  private validateTrainingSheetTrainer(parsedData: any, user?: User | null): {
    isValid: boolean;
    reason: string;
    message: string;
  } {
    const trainerName = String(parsedData?.trainer_name || '').trim();
    const employeeName = this.getEmployeeDisplayName(user);

    if (!trainerName) {
      return {
        isValid: false,
        reason: 'trainer_name missing in parsed document',
        message:
          'Document rejeté : le nom du formateur est introuvable dans le PDF. La feuille n\'est acceptée que si le formateur correspond à l\'employé concerné.',
      };
    }

    if (!this.trainerMatchesEmployee(trainerName, user)) {
      return {
        isValid: false,
        reason: 'trainer_name does not match employee identity',
        message:
          `Document rejeté : le formateur extrait ("${trainerName}") ne correspond pas à l'employé attendu ("${employeeName}").`,
      };
    }

    return {
      isValid: true,
      reason: 'trainer_name matches employee identity',
      message: 'OK',
    };
  }

  // ── Targets ───────────────────────────────────────────────────────────

  async setTargets(
    profileId: string,
    targetYear: number,
    certTarget?: number,
    setBy?: string,
  ) {
    let target = await this.targetRepo.findOne({
      where: { profileId, targetYear },
    });

    if (target) {
      if (certTarget !== undefined) target.certificationTarget = certTarget;
      if (setBy) target.setBy = setBy;
    } else {
      target = this.targetRepo.create({
        profileId,
        targetYear,
        certificationTarget: certTarget ?? 2,
        setBy,
      });
    }

    const saved = await this.targetRepo.save(target);

    // Auto-recompute the employee's score if one already exists
    const existingScore = await this.scoreRepo.findOne({
      where: { profileId, scoreYear: targetYear },
    });
    if (existingScore) {
      try {
        await this.computeScore(profileId, targetYear);
        this.logger.log(`Score recomputed for ${profileId} after target change`);
      } catch (err) {
        this.logger.warn(`Failed to recompute score after target change: ${err.message}`);
      }
    }

    return saved;
  }

  async getTargets(profileId: string, year: number) {
    return this.targetRepo.findOne({
      where: { profileId, targetYear: year },
    });
  }

  // ── Weights ───────────────────────────────────────────────────────────

  async getWeights(): Promise<ScoringWeight> {
    let global = await this.weightRepo.findOne({
      where: { teamId: IsNull() as any },
    });

    if (!global) {
      global = this.weightRepo.create({
        teamId: null,
        projectWeight: 0.35,
        certificationWeight: 0.25,
        trainingWeight: 0.20,
        formationWeight: 0.20,
      });
      global = await this.weightRepo.save(global);
    }

    // Sanitize legacy data: if any weight is > 1, they were stored as whole numbers
    // (e.g. 5, 8, 4, 6) — normalize by dividing by their sum
    const pw = Number(global.projectWeight);
    const cw = Number(global.certificationWeight);
    const tw = Number(global.trainingWeight);
    const fw = Number(global.formationWeight);
    if (pw > 1 || cw > 1 || tw > 1 || fw > 1) {
      const sum = pw + cw + tw + fw;
      if (sum > 0) {
        global.projectWeight = Math.round((pw / sum) * 100) / 100;
        global.certificationWeight = Math.round((cw / sum) * 100) / 100;
        global.trainingWeight = Math.round((tw / sum) * 100) / 100;
        global.formationWeight = Math.round((fw / sum) * 100) / 100;
        await this.weightRepo.save(global);
        this.logger.log(`Sanitized legacy weights: ${pw},${cw},${tw},${fw} → ${global.projectWeight},${global.certificationWeight},${global.trainingWeight},${global.formationWeight}`);
      }
    }

    return global;
  }

  async updateWeights(
    projectWeight: number,
    certWeight: number,
    trainingWeight: number,
    formationWeight: number,
    updatedBy?: string,
  ) {
    // Validate: all weights must be 0-1 and sum must be ~1.0
    const weights = [projectWeight, certWeight, trainingWeight, formationWeight];
    if (weights.some((w) => w < 0 || w > 1)) {
      throw new BadRequestException('Each weight must be between 0 and 1');
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.05) {
      throw new BadRequestException(`Weights must sum to 1.0 (got ${sum.toFixed(2)})`);
    }

    let weight = await this.weightRepo.findOne({ where: { teamId: IsNull() as any } });

    if (weight) {
      weight.projectWeight = projectWeight;
      weight.certificationWeight = certWeight;
      weight.trainingWeight = trainingWeight;
      weight.formationWeight = formationWeight;
      weight.updatedBy = updatedBy || null;
    } else {
      weight = this.weightRepo.create({
        teamId: null,
        projectWeight,
        certificationWeight: certWeight,
        trainingWeight,
        formationWeight,
        updatedBy,
      });
    }

    const savedWeight = await this.weightRepo.save(weight);

    const currentYear = new Date().getFullYear();
    const existingScores = await this.scoreRepo.find({
      where: { scoreYear: currentYear },
    });

    for (const score of existingScores) {
      try {
        await this.computeScore(score.profileId, currentYear);
      } catch (err: any) {
        this.logger.warn(`Failed to recompute score for ${score.profileId} after weight update: ${err.message}`);
      }
    }

    return savedWeight;
  }

  // ── Score Computation ─────────────────────────────────────────────────

  async computeScore(profileId: string, year: number) {
    // ── 1. PROJETS : lire depuis project_participants + projects ──────
    //    On récupère uniquement les projets assignés par un manager (assigned_by IS NOT NULL).
    //    Les projets provenant du CV parsing (assigned_by = NULL) ne comptent pas dans le scoring.
    //    Ensuite on enrichit avec les PV uploadés (bonus vérification).

    const participations = await this.participantRepo.find({
      where: { profile: { profile_id: profileId }, assignedBy: Not(IsNull()) },
      relations: ['project'],
    });

    // Récupérer les PV vérifiés pour ce profil (par nom de projet)
    const pvRecords = await this.projectRecordRepo.find({
      where: { profileId, pvVerified: true },
    });
    const pvProjectNames = new Set(
      pvRecords.map((pv) => pv.projectName?.toLowerCase().trim()),
    );

    const projects = participations.map((p) => {
      const proj = p.project;
      const projectNameLower = proj?.projectName?.toLowerCase().trim() || '';
      const hasPv = pvProjectNames.has(projectNameLower);

      // Role is now an enum — normalize to lowercase for AI service compatibility
      const rawRole: string = p.role || ParticipantRole.CONTRIBUTOR;
      const scoringRole: string = rawRole.toLowerCase();

      const relevantProjectDate = proj?.endDate || proj?.startDate || null;

      return {
        project_name: proj?.projectName || 'Projet inconnu',
        complexity: ((proj?.complexity || 'medium') as string).toLowerCase(),
        role: scoringRole,
        completion_date: relevantProjectDate
          ? new Date(relevantProjectDate).toISOString().split('T')[0]
          : null,
        pv_verified: hasPv,
      };
    });

    // Enrichir la complexité et le rôle depuis les PV quand disponible
    for (const proj of projects) {
      const matchingPv = pvRecords.find(
        (pv) => pv.projectName?.toLowerCase().trim() === proj.project_name.toLowerCase().trim(),
      );
      if (matchingPv) {
        proj.complexity = (matchingPv.complexity || proj.complexity).toLowerCase();
        proj.role = ((matchingPv.employeeRole || proj.role) as string).toLowerCase();
        if (!proj.completion_date && matchingPv.completionDate) {
          proj.completion_date = matchingPv.completionDate.toISOString().split('T')[0];
        }
      }
    }

    // Ajouter aussi les projets PV qui ne sont pas dans project_participants
    const participatedNames = new Set(
      projects.map((p) => p.project_name.toLowerCase().trim()),
    );
    for (const pv of pvRecords) {
      const pvName = pv.projectName?.toLowerCase().trim() || '';
      if (!participatedNames.has(pvName)) {
        projects.push({
          project_name: pv.projectName,
          complexity: (pv.complexity || 'medium').toLowerCase(),
          role: ((pv.employeeRole || 'contributor') as string).toLowerCase(),
          completion_date: pv.completionDate
            ? pv.completionDate.toISOString().split('T')[0]
            : null,
          pv_verified: true,
        });
      }
    }

    const scoredProjects = projects.filter((project) => {
      if (!project.completion_date) {
        return false;
      }

      return new Date(project.completion_date).getFullYear() === year;
    });

    // ── 2. CERTIFICATIONS : depuis la table certifications ───────────
    //    Seules les certifications obtenues l'année du scoring comptent.

    const certCount = await this.certRepo
      .createQueryBuilder('c')
      .where('c.profile_id = :profileId', { profileId })
      .andWhere('c.status = :status', { status: 'active' })
      .andWhere('EXTRACT(YEAR FROM c.issue_date) = :year', { year })
      .getCount();

    // ── 3. TRAININGS : depuis la table training_sessions ───────────────
    //    Seuls les trainings assignés+complétés l'année du scoring comptent.
    //    COALESCE fallback: end_date → start_date → due_date → updated_at
    //    (dates are often NULL; updated_at is always set when status changes)

    const trainingCount = await this.trainingSessionRepo
      .createQueryBuilder('ts')
      .where('ts.profile_id = :profileId', { profileId })
      .andWhere('ts.status = :status', { status: 'completed' })
      .andWhere(
        '(EXTRACT(YEAR FROM ts.end_date) = :year OR EXTRACT(YEAR FROM ts.start_date) = :year OR EXTRACT(YEAR FROM ts.due_date) = :year OR EXTRACT(YEAR FROM ts.updated_at) = :year)',
        { year },
      )
      .getCount();

    // ── 4. FORMATIONS DISPENSÉES POUR CLIENTS : depuis la table training_records
    //    L'employé a dispensé des formations pour les clients (attestation de formateur).
    //    Comptées par année de start_date ou end_date.

    const formationCount = await this.trainingRecordRepo
      .createQueryBuilder('tr')
      .where('tr.profile_id = :profileId', { profileId })
      .andWhere(
        '(EXTRACT(YEAR FROM tr.end_date) = :year OR EXTRACT(YEAR FROM tr.start_date) = :year)',
        { year },
      )
      .getCount();

    // 4. Get targets (only certification target matters for scoring)
    const targets = await this.getTargets(profileId, year);
    const certTarget = targets?.certificationTarget ?? 2;

    // 5. Get weights (try team-specific, fall back to global)
    const weights = await this.getWeights();

    // 6. Build AI scoring input
    const scoringInput = {
      profile_id: profileId,
      score_year: year,
      projects: scoredProjects,
      certification_count: certCount,
      certification_target: certTarget,
      training_count: trainingCount,
      formation_count: formationCount,
      weights: {
        project_weight: Number(weights.projectWeight),
        certification_weight: Number(weights.certificationWeight),
        training_weight: Number(weights.trainingWeight),
        formation_weight: Number(weights.formationWeight),
      },
    };

    // 7. Call AI scoring engine
    let breakdown: any;
    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/compute-score`,
        scoringInput,
      );
      breakdown = aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? 'unknown';
      this.logger.warn(`AI score computation failed: ${JSON.stringify(errorText)}. Falling back to local scoring calculation.`);
      
      // Fallback: Local Scoring Calculation
      const projScore = scoredProjects.reduce((sum, p) => {
        const cMultiplier = p.complexity === 'high' ? 3.5 : p.complexity === 'low' ? 1.0 : 2.0;
        const rMultiplier = p.role === 'project_lead' ? 1.5 : p.role === 'technical_lead' ? 1.3 : 1.0;
        const pvBonus = p.pv_verified ? 1.25 : 1.0;

        return sum + (10 * cMultiplier * rMultiplier * pvBonus);
      }, 0);
      
      const effectiveTarget = Math.max(certTarget, 1);
      const certScore = (certCount / effectiveTarget) * 100;
      const trainScore = trainingCount * 10;
      const formScore = formationCount * 10;
      
      const wP = Number(weights.projectWeight);
      const wC = Number(weights.certificationWeight);
      const wT = Number(weights.trainingWeight);
      const wF = Number(weights.formationWeight);
      
      const finalS = (wP * projScore) + (wC * certScore) + (wT * trainScore) + (wF * formScore);
      
      breakdown = {
        project_score: Math.round(projScore * 100) / 100,
        certification_score: Math.round(certScore * 100) / 100,
        training_score: Math.round(trainScore * 100) / 100,
        formation_score: Math.round(formScore * 100) / 100,
        final_score: Math.round(finalS * 100) / 100,
      };
    }

    // 8. Upsert score record
    let scoreRecord = await this.scoreRepo.findOne({
      where: { profileId, scoreYear: year },
    });

    if (scoreRecord) {
      scoreRecord.projectScore = breakdown.project_score;
      scoreRecord.certificationScore = breakdown.certification_score;
      scoreRecord.trainingScore = breakdown.training_score;
      scoreRecord.formationScore = breakdown.formation_score;
      scoreRecord.finalScore = breakdown.final_score;
      scoreRecord.scoreDetails = breakdown;
    } else {
      scoreRecord = this.scoreRepo.create({
        profileId,
        scoreYear: year,
        projectScore: breakdown.project_score,
        certificationScore: breakdown.certification_score,
        trainingScore: breakdown.training_score,
        formationScore: breakdown.formation_score,
        finalScore: breakdown.final_score,
        scoreDetails: breakdown,
      });
    }

    const saved = await this.scoreRepo.save(scoreRecord);

    // Keep rankings up-to-date after every individual recompute
    try {
      await this.updateRankings(year);
    } catch (err: any) {
      this.logger.warn(`Rankings update failed: ${err.message}`);
    }

    return {
      score: saved,
      breakdown,
    };
  }

  // ── Batch Compute (Team / All) ────────────────────────────────────────

  async computeTeamScores(managerUserId: string, year: number) {
    // Get the manager's team members
    const manager = await this.userRepo.findOne({
      where: { user_id: managerUserId },
    });
    if (!manager) throw new NotFoundException('Manager non trouvé');

    // Find team members via team_members join table
    const profiles = await this.profileRepo
      .createQueryBuilder('ep')
      .innerJoin('team_members', 'tm', 'tm.employee_id = ep.user_id')
      .innerJoin('teams', 't', 't.team_id = tm.team_id')
      .where('t.manager_id = :managerId', { managerId: managerUserId })
      .getMany();

    const results = [];
    for (const profile of profiles) {
      try {
        const result = await this.computeScore(profile.profile_id, year);
        results.push(result);
      } catch (error) {
        this.logger.error(
          `Score computation failed for ${profile.profile_id}: ${error.message}`,
        );
        results.push({
          profileId: profile.profile_id,
          error: error.message,
        });
      }
    }

    // Update rankings
    await this.updateRankings(year);

    return results;
  }

  // ── Rankings ──────────────────────────────────────────────────────────

  async updateRankings(year: number) {
    const allScores = await this.scoreRepo.find({
      where: { scoreYear: year },
      order: { finalScore: 'DESC' },
    });

    const total = allScores.length;

    // 1. Compute global rankings
    for (let i = 0; i < allScores.length; i++) {
      allScores[i].rankGlobal = i + 1;
      allScores[i].percentile =
        total > 1
          ? Math.round(((total - (i + 1)) / total) * 10000) / 100
          : 100;
    }

    // 2. Compute team rankings (group employees by team, rank within each team)
    const teamMap = new Map<string, EmployeeScore[]>();
    for (const score of allScores) {
      const teamId = await this.getEmployeeTeamId(score.profileId);
      if (teamId) {
        if (!teamMap.has(teamId)) {
          teamMap.set(teamId, []);
        }
        teamMap.get(teamId)!.push(score);
      }
    }

    for (const [, teamScores] of teamMap) {
      // Already sorted by finalScore DESC (from global sort)
      for (let i = 0; i < teamScores.length; i++) {
        teamScores[i].rankInTeam = i + 1;
      }
    }

    await this.scoreRepo.save(allScores);
  }

  async getLeaderboard(year: number, teamId?: string, limit?: number) {
    let query = this.scoreRepo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.profile', 'p')
      .leftJoinAndSelect('p.user', 'u')
      .where('s.score_year = :year', { year });

    if (teamId) {
      query = query
        .innerJoin('team_members', 'tm', 'tm.employee_id = p.user_id')
        .andWhere('tm.team_id = :teamId', { teamId });
    }

    query = query.orderBy('s.final_score', 'DESC');

    if (limit) {
      query = query.limit(limit);
    }

    const scores = await query.getMany();

    return scores.map((score, index) => {
      const user = score.profile?.user;
      return {
        rank: index + 1,
        profileId: score.profileId,
        employeeName:
          user?.firstName && user?.lastName
            ? `${user.firstName} ${user.lastName}`
            : (user?.email ?? 'N/A'),
        finalScore: Number(score.finalScore),
        projectScore: Number(score.projectScore),
        certificationScore: Number(score.certificationScore),
        trainingScore: Number(score.trainingScore),
        formationScore: Number(score.formationScore),
        percentile: score.percentile != null ? Number(score.percentile) : null,
      };
    });
  }

  // ── Data Access ───────────────────────────────────────────────────────

  async getEmployeeScore(profileId: string, year: number) {
    const score = await this.scoreRepo.findOne({
      where: { profileId, scoreYear: year },
    });

    if (!score) {
      return null;
    }

    return {
      ...score,
      projectScore: Number(score.projectScore),
      certificationScore: Number(score.certificationScore),
      trainingScore: Number(score.trainingScore),
      formationScore: Number(score.formationScore),
      finalScore: Number(score.finalScore),
      percentile: score.percentile != null ? Number(score.percentile) : null,
    };
  }

  async getProjectRecords(profileId: string) {
    return this.projectRecordRepo.find({
      where: { profileId },
      order: { completionDate: 'DESC' },
    });
  }

  async getTrainingRecords(profileId: string) {
    return this.trainingRecordRepo.find({
      where: { profileId },
      order: { startDate: 'DESC' },
    });
  }

  async updateProjectRecord(
    recordId: string,
    complexity?: string,
    employeeRole?: string,
  ) {
    const record = await this.projectRecordRepo.findOne({
      where: { record_id: recordId },
    });
    if (!record)
      throw new NotFoundException(`Enregistrement projet ${recordId} non trouvé`);

    if (complexity) record.complexity = complexity as any;
    if (employeeRole) record.employeeRole = employeeRole as any;

    const saved = await this.projectRecordRepo.save(record);

    // Auto-recompute score for the current year after modifying the project record
    const currentYear = new Date().getFullYear();
    try {
      await this.computeScore(record.profileId, currentYear);
      this.logger.log(
        `Score recomputed for ${record.profileId} after project record update`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to recompute score after project update: ${err.message}`,
      );
    }

    return saved;
  }

  async listProjects(requestUserId: string, role?: string) {
    let profileIds: string[] = [];

    if (role === UserRole.BID_MANAGER) {
      const profileRows = await this.profileRepo
        .createQueryBuilder('ep')
        .innerJoin('ep.user', 'u')
        .where('u.role = :role', { role: UserRole.EMPLOYEE })
        .andWhere('u.status = :status', { status: 'active' })
        .select('ep.profile_id', 'profile_id')
        .getRawMany();

      profileIds = profileRows.map((r: any) => r.profile_id);
    } else {
      const teamRows = await this.profileRepo
        .createQueryBuilder('ep')
        .innerJoin('team_members', 'tm', 'tm.employee_id = ep.user_id')
        .innerJoin('teams', 't', 't.team_id = tm.team_id')
        .where('t.manager_id = :managerId', { managerId: requestUserId })
        .select('ep.profile_id', 'profile_id')
        .getRawMany();

      profileIds = teamRows.map((r: any) => r.profile_id);
    }

    if (profileIds.length === 0) return [];

    // Step 2: fetch participants for projects that include at least one team member
    const rows = await this.participantRepo
      .createQueryBuilder('pp')
      .innerJoin('pp.project', 'proj')
      .innerJoin('pp.profile', 'emp')
      .innerJoin('emp.user', 'u')
      .where('pp.profile_id IN (:...profileIds)', { profileIds })
      .select('proj.project_id', 'project_id')
      .addSelect('proj.projectName', 'projectName')
      .addSelect('proj.clientName', 'clientName')
      .addSelect('proj.complexity', 'complexity')
      .addSelect('proj.startDate', 'startDate')
      .addSelect('proj.endDate', 'endDate')
      .addSelect('pp.profile_id', 'profileId')
      .addSelect('pp.role', 'role')
      .addSelect("CONCAT(u.first_name, ' ', u.last_name)", 'participantName')
      .orderBy('proj.projectName', 'ASC')
      .getRawMany();

    // Step 3: group rows by project
    const projectMap = new Map<string, any>();
    for (const row of rows) {
      if (!projectMap.has(row.project_id)) {
        projectMap.set(row.project_id, {
          project_id: row.project_id,
          projectName: row.projectName,
          clientName: row.clientName,
          complexity: row.complexity,
          startDate: row.startDate,
          endDate: row.endDate,
          participants: [],
        });
      }
      projectMap.get(row.project_id).participants.push({
        profileId: row.profileId,
        role: row.role,
        name: row.participantName,
      });
    }

    return Array.from(projectMap.values());
  }

  async getScoreHistory(profileId: string) {
    return this.scoreRepo.find({
      where: { profileId },
      order: { scoreYear: 'DESC' },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Get the team ID for an employee by their profile ID.
   * Returns null if the employee is not assigned to any team.
   */
  private async getEmployeeTeamId(profileId: string): Promise<string | null> {
    const result = await this.profileRepo
      .createQueryBuilder('ep')
      .innerJoin('team_members', 'tm', 'tm.employee_id = ep.user_id')
      .where('ep.profile_id = :profileId', { profileId })
      .select('tm.team_id', 'team_id')
      .getRawOne();

    return result?.team_id || null;
  }
}
