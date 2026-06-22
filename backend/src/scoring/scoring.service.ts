import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, IsNull, Not } from "typeorm";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as FormData from "form-data";

import { DocumentHash } from "./entities/document-hash.entity";
import { ProjectRecord } from "./entities/project-record.entity";
import { TrainingRecord } from "./entities/training-record.entity";
import { ScoringTarget } from "./entities/scoring-target.entity";
import { EmployeeScore } from "./entities/employee-score.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { Certification } from "../certifications/entities/certification.entity";
import { User, UserRole } from "../users/entities/user.entity";
import { TrainingSession } from "../training/training-session.entity";
import { ProjectParticipant } from "../projects/entities/participant.entity";
import { Project } from "../projects/entities/project.entity";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  private readonly aiServiceBaseUrl: string;
  private readonly computeLocks = new Map<string, Promise<any>>();

  constructor(
    @InjectRepository(DocumentHash)
    private readonly docHashRepo: Repository<DocumentHash>,
    @InjectRepository(ProjectRecord)
    private readonly projectRecordRepo: Repository<ProjectRecord>,
    @InjectRepository(TrainingRecord)
    private readonly trainingRecordRepo: Repository<TrainingRecord>,
    @InjectRepository(ScoringTarget)
    private readonly targetRepo: Repository<ScoringTarget>,
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
      this.configService.get<string>("AI_SERVICE_URL") ||
      "http://localhost:8000";
  }

  // ── PV Upload (Team Manager → employee's profile) ──────────────────

  async previewPv(file: Express.Multer.File, userId: string) {
    const formData = new FormData();
    formData.append("file", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append("user_id", userId);

    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/parse-document`,
        formData,
        { headers: formData.getHeaders() },
      );
      return aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? "unknown";
      this.logger.error(
        `AI preview parse failed: ${JSON.stringify(errorText)}`,
      );
      throw new BadRequestException(
        `Erreur lors de l'analyse du document: ${JSON.stringify(errorText)}`,
      );
    }
  }

  async uploadPv(
    file: Express.Multer.File,
    profileIds: string[],
    managerUserId: string,
    projectId?: string,
    complexity?: "low" | "medium" | "high",
    profileEvaluations?: Array<{
      profileId: string;
      score?: number;
      contributionDescription?: string;
    }>,
  ) {
    if (profileIds.length === 0) {
      throw new BadRequestException(
        "Aucun employé sélectionné pour cet import PV",
      );
    }
    if (!projectId) {
      throw new BadRequestException(
        "Le projet est obligatoire pour importer un PV.",
      );
    }

    const managerUser = await this.userRepo.findOne({
      where: { user_id: managerUserId },
    });
    const managerName = managerUser
      ? `${managerUser.firstName || ""} ${managerUser.lastName || ""}`.trim() ||
        managerUser.email
      : "Votre manager";
    const isBidManager = managerUser?.role === UserRole.BID_MANAGER;

    const profiles = await this.profileRepo.find({
      where: profileIds.map((profileId) => ({ profile_id: profileId })),
      relations: ["user"],
    });
    const profileMap = new Map(
      profiles.map((profile) => [profile.profile_id, profile]),
    );
    const missingProfileIds = profileIds.filter(
      (profileId) => !profileMap.has(profileId),
    );
    if (missingProfileIds.length > 0) {
      throw new NotFoundException(
        `Profils introuvables: ${missingProfileIds.join(", ")}`,
      );
    }

    const project = await this.projectRepo.findOne({
      where: { project_id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Projet ${projectId} non trouvé`);
    }
    if (
      !isBidManager &&
      project.createdBy &&
      project.createdBy !== managerUserId
    ) {
      throw new ForbiddenException(
        "Vous pouvez importer un PV uniquement pour vos propres projets.",
      );
    }
    const participants = await this.participantRepo.find({
      where: profileIds.map((profileId) => ({
        project: { project_id: projectId },
        profile: { profile_id: profileId },
      })),
      relations: ["profile"],
    });
    const participantMap = new Map(
      participants.map((participant) => [
        participant.profile.profile_id,
        participant,
      ]),
    );
    const invalidProfileIds = profileIds.filter(
      (profileId) => !participantMap.has(profileId),
    );
    if (invalidProfileIds.length > 0) {
      const invalidNames = invalidProfileIds.map((profileId) => {
        const profile = profileMap.get(profileId);
        return profile?.user
          ? `${profile.user.firstName || ""} ${profile.user.lastName || ""}`.trim() ||
              profile.user.email
          : profileId;
      });
      throw new BadRequestException(
        `Vous pouvez sélectionner uniquement les employés assignés au projet: ${invalidNames.join(", ")}`,
      );
    }

    const evaluationByProfile = new Map<
      string,
      { score?: number; contributionDescription?: string }
    >();
    for (const item of profileEvaluations || []) {
      if (!item?.profileId || !profileIds.includes(item.profileId)) {
        continue;
      }
      const parsedScore =
        item.score === null || item.score === undefined
          ? undefined
          : Number(item.score);
      if (
        parsedScore !== undefined &&
        (!Number.isFinite(parsedScore) || parsedScore < 0 || parsedScore > 20)
      ) {
        throw new BadRequestException(
          "La note individuelle doit etre comprise entre 0 et 20.",
        );
      }
      evaluationByProfile.set(item.profileId, {
        score: Number.isFinite(parsedScore) ? parsedScore : undefined,
        contributionDescription:
          String(item.contributionDescription || "").trim() || undefined,
      });
    }

    for (const profileId of profileIds) {
      const participant = participantMap.get(profileId);
      if (!participant) continue;

      const evaluation = evaluationByProfile.get(profileId);
      const isOwnTeamMember =
        participant.assignmentType !== "external" ||
        participant.homeManagerId === managerUserId;

      if (
        !isBidManager &&
        evaluation?.score !== undefined &&
        !isOwnTeamMember
      ) {
        throw new ForbiddenException(
          "Vous ne pouvez attribuer une note qu'aux membres de votre propre équipe.",
        );
      }

      if (
        !isBidManager &&
        participant.assignmentType === "external" &&
        !evaluation?.contributionDescription
      ) {
        throw new BadRequestException(
          "La description de contribution est obligatoire pour un membre externe.",
        );
      }
    }

    let resolvedComplexity =
      complexity || (project.complexity as any) || "medium";

    const formData = new FormData();
    formData.append("file", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append("user_id", managerUserId);

    let parsed: any;
    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/parse-document`,
        formData,
        { headers: formData.getHeaders() },
      );
      parsed = aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? "unknown";
      this.logger.error(`AI parse failed: ${JSON.stringify(errorText)}`);
      throw new BadRequestException(
        `Erreur lors de l'analyse du document: ${JSON.stringify(errorText)}`,
      );
    }

    const parsedComplexity = String(
      parsed?.parsed_data?.complexity || "",
    ).toLowerCase();
    if (!complexity && ["low", "medium", "high"].includes(parsedComplexity)) {
      resolvedComplexity = parsedComplexity as any;
    }
    if (project.complexity !== resolvedComplexity) {
      project.complexity = resolvedComplexity;
      await this.projectRepo.save(project);
    }

    const existingHash = await this.docHashRepo.findOne({
      where: { fileHash: parsed.file_hash },
    });
    if (existingHash) {
      throw new ConflictException(
        "Ce PV a deja ete importe. Le document a ete bloque pour eviter un doublon.",
      );
    }

    const docHash = this.docHashRepo.create({
      fileHash: parsed.file_hash,
      documentType: parsed.document_type,
      originalFilename: file.originalname,
      uploadedBy: managerUserId,
    });
    await this.docHashRepo.save(docHash);

    const currentYear = new Date().getFullYear();
    const results: Array<{
      profileId: string;
      employeeName: string;
      status: "created" | "updated" | "duplicate";
      message?: string;
      record?: any;
    }> = [];

    const recomputeProjectScore = async (
      profileId: string,
      projectRecord?: any,
    ) => {
      await this.computeScore(profileId, currentYear);

      if (projectRecord?.completionDate) {
        const pvYear = new Date(projectRecord.completionDate).getFullYear();
        if (pvYear !== currentYear) {
          await this.computeScore(profileId, pvYear);
        }
      }
    };

    for (const profileId of profileIds) {
      const profile = profileMap.get(profileId)!;
      const participant = participantMap.get(profileId)!;
      const evaluation = evaluationByProfile.get(profileId);
      const hasScore = evaluation?.score !== undefined;
      const isExternal = participant.assignmentType === "external";
      const shouldEscalateToHomeManager = isExternal && !isBidManager;

      const evaluationPayload = shouldEscalateToHomeManager
        ? {
            individualScore: null,
            evaluationStatus: "pending_external_manager" as const,
            externalContributionDescription:
              evaluation?.contributionDescription || null,
            externalHomeManagerId: participant.homeManagerId || null,
            evaluatedByManagerId: null,
            evaluatedAt: null,
          }
        : {
            individualScore: hasScore ? Number(evaluation?.score) : null,
            evaluationStatus: "scored_by_own_manager" as const,
            externalContributionDescription: null,
            externalHomeManagerId: null,
            evaluatedByManagerId: hasScore ? managerUserId : null,
            evaluatedAt: hasScore ? new Date() : null,
          };

      const savedRecord = await this.saveProjectRecord(
        profileId,
        {
          ...parsed.parsed_data,
          project_name: project.projectName,
          client_name: project.clientName || null,
          completion_date:
            this.formatDateForScoring(project.endDate) ||
            parsed.parsed_data?.completion_date ||
            null,
        },
        parsed.file_hash,
        file.originalname,
        resolvedComplexity,
        true,
        managerUserId,
        evaluationPayload,
      );

      const employeeName = profile.user
        ? `${profile.user.firstName || ""} ${profile.user.lastName || ""}`.trim() ||
          profile.user.email
        : profileId;
      const resultStatus: "created" | "updated" | "duplicate" =
        savedRecord.status === "duplicate"
          ? "duplicate"
          : savedRecord.status === "updated"
            ? "updated"
            : "created";

      results.push({
        profileId,
        employeeName,
        status: resultStatus,
        message: savedRecord.message,
        record: savedRecord.record,
      });

      if (resultStatus === "duplicate") {
        try {
          await recomputeProjectScore(profileId, savedRecord.record);
          this.logger.log(
            `Auto-recomputed score for duplicate PV record on profile ${profileId}`,
          );
        } catch (err: any) {
          this.logger.warn(
            `Auto-recompute for duplicate PV on profile ${profileId} failed: ${err.message}`,
          );
        }
        continue;
      }

      if (profile.user) {
        await this.notificationsService
          .create({
            userId: profile.user.user_id,
            type: "pv_uploaded",
            title: "PV importe pour votre projet",
            message: `${managerName} a importe un PV pour le projet "${project.projectName}".`,
            relatedEntityType: "project_record",
            relatedEntityId: savedRecord?.record?.record_id,
          })
          .catch((err) =>
            this.logger.warn(
              `Notification PV failed for ${profileId}: ${err.message}`,
            ),
          );
      }

      if (evaluationPayload.evaluationStatus === "pending_external_manager") {
        if (evaluationPayload.externalHomeManagerId) {
          await this.notificationsService
            .create({
              userId: evaluationPayload.externalHomeManagerId,
              type: "external_member_evaluation_requested",
              title: "Evaluation externe requise",
              message: `Merci d'evaluer votre collaborateur sur "${project.projectName}".`,
              relatedEntityType: "project_record",
              relatedEntityId: savedRecord?.record?.record_id,
            })
            .catch((err) =>
              this.logger.warn(
                `External evaluation notification failed for ${profileId}: ${err.message}`,
              ),
            );
        }
        // Recompute score immediately so project complexity is reflected while the
        // home manager's individual evaluation is still pending.
        try {
          await recomputeProjectScore(profileId, savedRecord.record);
          this.logger.log(
            `Auto-recomputed score for external member ${profileId} after PV upload (complexity applied)`,
          );
        } catch (err: any) {
          this.logger.warn(
            `Auto-recompute for external member ${profileId} after PV upload failed: ${err.message}`,
          );
        }
        continue;
      }

      try {
        await recomputeProjectScore(profileId, savedRecord.record);
        this.logger.log(
          `Auto-recomputed score for profile ${profileId} after PV upload`,
        );

        if (profile.user) {
          const updatedScore = await this.scoreRepo.findOne({
            where: { profileId, scoreYear: currentYear },
          });
          await this.notificationsService
            .create({
              userId: profile.user.user_id,
              type: "score_updated",
              title: "Score mis a jour",
              message: `Votre score a ete recalcule : ${Number(updatedScore?.finalScore ?? 0).toFixed(1)} pts.`,
              relatedEntityType: "employee_score",
              relatedEntityId: updatedScore?.score_id,
            })
            .catch((err) =>
              this.logger.warn(
                `Notification score failed for ${profileId}: ${err.message}`,
              ),
            );
        }
      } catch (err: any) {
        this.logger.warn(
          `Auto-recompute after PV upload failed for ${profileId}: ${err.message}`,
        );
      }
    }

    const createdCount = results.filter(
      (result) => result.status === "created",
    ).length;
    const updatedCount = results.filter(
      (result) => result.status === "updated",
    ).length;
    const duplicateCount = results.length - createdCount - updatedCount;
    const importedCount = createdCount + updatedCount;

    return {
      status: importedCount > 0 ? "created" : "duplicate",
      message:
        importedCount === 0
          ? "This PV already exists for the selected participant(s). Upload skipped."
          : duplicateCount > 0
            ? `PV imported for ${importedCount} participant(s). ${duplicateCount} duplicate(s) were skipped because they already exist.`
            : `PV imported for ${importedCount} participant(s).`,
      parsed_data: parsed.parsed_data,
      results,
    };
  }

  async uploadTrainingSheet(file: Express.Multer.File, userId: string) {
    // 1. Find the employee's own profile
    const profile = await this.profileRepo.findOne({
      where: { user: { user_id: userId } },
      relations: ["user"],
    });
    if (!profile) {
      throw new NotFoundException(
        `Aucun profil employé trouvé pour l'utilisateur connecté`,
      );
    }

    // 2. Call AI service to parse document
    const formData = new FormData();
    formData.append("file", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    formData.append("user_id", userId);

    let parsed: any;
    try {
      const aiResponse = await axios.post(
        `${this.aiServiceBaseUrl}/api/v1/scoring/parse-document`,
        formData,
        { headers: formData.getHeaders() },
      );
      parsed = aiResponse.data;
    } catch (err: any) {
      const errorText = err?.response?.data ?? err?.message ?? "unknown";
      this.logger.error(`AI parse failed: ${JSON.stringify(errorText)}`);
      throw new BadRequestException(
        `Erreur lors de l'analyse du document: ${JSON.stringify(errorText)}`,
      );
    }

    if (parsed.document_type !== "training_sheet") {
      this.logger.warn(
        `Training sheet upload rejected for profile ${profile.profile_id}: detected document type=${parsed.document_type}, file=${file.originalname}`,
      );
      throw new BadRequestException(
        "Le document importé n'a pas été reconnu comme une feuille de présence formateur.",
      );
    }

    const trainerValidation = this.validateTrainingSheetTrainer(
      parsed.parsed_data,
      profile.user,
    );
    if (!trainerValidation.isValid) {
      this.logger.warn(
        `Training sheet rejected for profile ${profile.profile_id}: ${trainerValidation.reason}; extractedTrainer="${parsed.parsed_data?.trainer_name || "N/A"}"; expectedEmployee="${this.getEmployeeDisplayName(profile.user)}"; file=${file.originalname}; assumptions=${JSON.stringify(parsed.parsed_data?.assumptions || [])}`,
      );
      throw new BadRequestException(trainerValidation.message);
    }

    // 3. Check for duplicate
    const existingHash = await this.docHashRepo.findOne({
      where: { fileHash: parsed.file_hash },
    });
    if (existingHash) {
      throw new ConflictException(
        "Ce document a déjà été importé (doublon détecté par hash)",
      );
    }

    // 4. Save document hash
    const docHash = this.docHashRepo.create({
      fileHash: parsed.file_hash,
      documentType: "training_sheet",
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

    if (savedRecord.status !== "created") {
      this.logger.warn(
        `Training sheet duplicate for profile ${profile.profile_id}: ${savedRecord.message || "duplicate detected"}`,
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
      return Number.isNaN(value.getTime())
        ? null
        : value.toISOString().split("T")[0];
    }

    if (typeof value === "string") {
      const trimmedValue = value.trim();
      if (!trimmedValue) {
        return null;
      }

      const parsedDate = new Date(trimmedValue);
      return Number.isNaN(parsedDate.getTime())
        ? trimmedValue
        : parsedDate.toISOString().split("T")[0];
    }

    return null;
  }

  private async saveProjectRecord(
    profileId: string,
    parsedData: any,
    fileHash: string,
    filename: string,
    complexity?: string,
    pvVerified: boolean = false,
    submittedBy?: string,
    evaluation?: {
      individualScore?: number | null;
      evaluationStatus?:
        | "scored_by_own_manager"
        | "pending_external_manager"
        | "scored_by_home_manager";
      externalContributionDescription?: string | null;
      externalHomeManagerId?: string | null;
      evaluatedByManagerId?: string | null;
      evaluatedAt?: Date | null;
    },
  ) {
    const projectName = parsedData.project_name || "Projet non identifie";
    const clientName = parsedData.client_name || null;
    const parsedCompletionDate = parsedData.completion_date
      ? new Date(parsedData.completion_date)
      : null;
    const completionDate =
      parsedCompletionDate && !Number.isNaN(parsedCompletionDate.getTime())
        ? parsedCompletionDate
        : new Date();

    const clientFilter = clientName || (IsNull() as any);
    const exactMatch = await this.projectRecordRepo.findOne({
      where: {
        profileId,
        projectName,
        clientName: clientFilter,
        completionDate,
      },
    });
    if (exactMatch) {
      let changed = false;

      if (complexity && exactMatch.complexity !== complexity) {
        exactMatch.complexity = complexity as any;
        changed = true;
      }
      if (evaluation) {
        if (evaluation.individualScore !== undefined) {
          exactMatch.individualScore = evaluation.individualScore as any;
          changed = true;
        }
        if (
          evaluation.evaluationStatus &&
          exactMatch.evaluationStatus !== evaluation.evaluationStatus
        ) {
          exactMatch.evaluationStatus = evaluation.evaluationStatus as any;
          changed = true;
        }
        if (evaluation.externalContributionDescription !== undefined) {
          exactMatch.externalContributionDescription =
            evaluation.externalContributionDescription;
          changed = true;
        }
        if (evaluation.externalHomeManagerId !== undefined) {
          exactMatch.externalHomeManagerId = evaluation.externalHomeManagerId;
          changed = true;
        }
        if (evaluation.evaluatedByManagerId !== undefined) {
          exactMatch.evaluatedByManagerId = evaluation.evaluatedByManagerId;
          changed = true;
        }
        if (evaluation.evaluatedAt !== undefined) {
          exactMatch.evaluatedAt = evaluation.evaluatedAt;
          changed = true;
        }
      }

      if (changed) {
        exactMatch.parsedData = parsedData;
        exactMatch.sourceFilename = filename;
        exactMatch.documentHash = fileHash;
        const updated = await this.projectRecordRepo.save(exactMatch);
        return {
          status: "updated",
          record: updated,
          message: `Projet (${projectName}) mis a jour`,
        };
      }

      return {
        status: "duplicate",
        message: `Ce projet (${projectName}) est deja enregistre pour cet employe a cette date`,
        record: exactMatch,
      };
    }

    const nullDateMatch = await this.projectRecordRepo.findOne({
      where: {
        profileId,
        projectName,
        clientName: clientFilter,
        completionDate: IsNull() as any,
      },
    });
    if (nullDateMatch) {
      nullDateMatch.completionDate = completionDate;
      if (complexity) nullDateMatch.complexity = complexity as any;
      if (evaluation?.individualScore !== undefined) {
        nullDateMatch.individualScore = evaluation.individualScore as any;
      }
      if (evaluation?.evaluationStatus) {
        nullDateMatch.evaluationStatus = evaluation.evaluationStatus as any;
      }
      if (evaluation?.externalContributionDescription !== undefined) {
        nullDateMatch.externalContributionDescription =
          evaluation.externalContributionDescription;
      }
      if (evaluation?.externalHomeManagerId !== undefined) {
        nullDateMatch.externalHomeManagerId = evaluation.externalHomeManagerId;
      }
      if (evaluation?.evaluatedByManagerId !== undefined) {
        nullDateMatch.evaluatedByManagerId = evaluation.evaluatedByManagerId;
      }
      if (evaluation?.evaluatedAt !== undefined) {
        nullDateMatch.evaluatedAt = evaluation.evaluatedAt;
      }
      nullDateMatch.parsedData = parsedData;
      nullDateMatch.sourceFilename = filename;
      nullDateMatch.documentHash = fileHash;

      const migrated = await this.projectRecordRepo.save(nullDateMatch);
      return {
        status: "updated",
        record: migrated,
        message: `Date de completion mise a jour pour le projet (${projectName})`,
      };
    }

    const record = this.projectRecordRepo.create({
      profileId,
      projectName,
      clientName,
      projectDescription: parsedData.organization_context || null,
      completionDate,
      complexity: (complexity as any) || "medium",
      pvVerified,
      individualScore: evaluation?.individualScore ?? null,
      evaluationStatus: evaluation?.evaluationStatus || "scored_by_own_manager",
      externalContributionDescription:
        evaluation?.externalContributionDescription ?? null,
      externalHomeManagerId: evaluation?.externalHomeManagerId ?? null,
      evaluatedByManagerId: evaluation?.evaluatedByManagerId ?? null,
      evaluatedAt: evaluation?.evaluatedAt ?? null,
      submittedBy: submittedBy || null,
      documentHash: fileHash,
      sourceFilename: filename,
      parsedData,
    });

    const saved = await this.projectRecordRepo.save(record);
    return {
      status: "created",
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
    const trainingName = parsedData.training_name || "Formation non identifiée";
    const clientName = parsedData.client_name || null;
    const startDate = parsedData.start_date
      ? new Date(parsedData.start_date)
      : null;

    // Semantic dedup
    const existing = await this.trainingRecordRepo.findOne({
      where: {
        profileId,
        trainingName,
        clientName: clientName || (IsNull() as any),
        startDate: startDate || (IsNull() as any),
      },
    });

    if (existing) {
      this.logger.warn(
        `Formation en double (sémantique): ${trainingName} / ${clientName} pour profil ${profileId}`,
      );
      return {
        status: "duplicate",
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
      `Training record created for profile ${profileId}: training="${trainingName}", trainer="${parsedData.trainer_name || "N/A"}", startDate=${parsedData.start_date || "N/A"}`,
    );
    return {
      status: "created",
      record: saved,
      parsed_data: parsedData,
    };
  }

  private normalizeProjectComplexity(
    value?: string | null,
  ): "low" | "medium" | "high" {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();

    if (
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high"
    ) {
      return normalized;
    }

    return "medium";
  }

  private normalizeProjectReferenceDate(
    value?: string | Date | null,
  ): Date | null {
    if (!value) {
      return null;
    }

    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private getProjectRecordReferenceDate(
    record?: ProjectRecord | null,
  ): Date | null {
    if (!record) {
      return null;
    }

    return (
      this.normalizeProjectReferenceDate(record.completionDate) ||
      this.normalizeProjectReferenceDate(record.parsedData?.assignment_date) ||
      this.normalizeProjectReferenceDate(record.parsedData?.assignmentDate) ||
      this.normalizeProjectReferenceDate(record.createdAt)
    );
  }

  async ensureProvisionalProjectRecord(params: {
    profileId: string;
    projectName: string;
    clientName?: string | null;
    projectDescription?: string | null;
    assignmentDate?: Date | null;
    complexity?: string | null;
    assignmentType: "internal" | "external";
    assignmentSource: "team_assignment" | "cross_team_approval";
  }) {
    const assignmentDate =
      this.normalizeProjectReferenceDate(params.assignmentDate) || new Date();
    const complexity = this.normalizeProjectComplexity(params.complexity);

    const existing = await this.projectRecordRepo.findOne({
      where: {
        profileId: params.profileId,
        projectName: params.projectName,
        clientName: params.clientName || (IsNull() as any),
        completionDate: IsNull() as any,
      },
    });

    const parsedData = {
      assignment_date: assignmentDate.toISOString().split("T")[0],
      assignment_type: params.assignmentType,
      assignment_source: params.assignmentSource,
    };

    if (existing) {
      existing.projectDescription = params.projectDescription || null;
      existing.complexity = complexity;
      existing.evaluationStatus = "scored_by_own_manager";
      existing.parsedData = {
        ...(existing.parsedData || {}),
        ...parsedData,
      };
      return this.projectRecordRepo.save(existing);
    }

    return this.projectRecordRepo.save(
      this.projectRecordRepo.create({
        profileId: params.profileId,
        projectName: params.projectName,
        clientName: params.clientName || null,
        projectDescription: params.projectDescription || null,
        completionDate: null,
        complexity,
        pvVerified: false,
        individualScore: null,
        evaluationStatus: "scored_by_own_manager",
        externalContributionDescription: null,
        externalHomeManagerId: null,
        evaluatedByManagerId: null,
        evaluatedAt: null,
        submittedBy: null,
        documentHash: null,
        sourceFilename: null,
        parsedData,
      }),
    );
  }

  private getEmployeeDisplayName(user?: User | null): string {
    const name = [user?.firstName, user?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    return name || user?.email || "employé inconnu";
  }

  private normalizeNameTokens(value?: string | null): string[] {
    return (value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  private trainerMatchesEmployee(
    trainerName: string,
    user?: User | null,
  ): boolean {
    const trainerTokens = this.normalizeNameTokens(trainerName);
    const employeeTokens = this.normalizeNameTokens(
      this.getEmployeeDisplayName(user),
    );

    if (trainerTokens.length === 0 || employeeTokens.length === 0) {
      return false;
    }

    if (trainerTokens.join(" ") === employeeTokens.join(" ")) {
      return true;
    }

    if (trainerTokens.length !== employeeTokens.length) {
      return false;
    }

    return (
      [...trainerTokens].sort().join(" ") ===
      [...employeeTokens].sort().join(" ")
    );
  }

  private validateTrainingSheetTrainer(
    parsedData: any,
    user?: User | null,
  ): {
    isValid: boolean;
    reason: string;
    message: string;
  } {
    const trainerName = String(parsedData?.trainer_name || "").trim();
    const employeeName = this.getEmployeeDisplayName(user);

    if (!trainerName) {
      return {
        isValid: false,
        reason: "trainer_name missing in parsed document",
        message:
          "Document rejeté : le nom du formateur est introuvable dans le PDF. La feuille n'est acceptée que si le formateur correspond à l'employé concerné.",
      };
    }

    if (!this.trainerMatchesEmployee(trainerName, user)) {
      return {
        isValid: false,
        reason: "trainer_name does not match employee identity",
        message: `Document rejeté : le formateur extrait ("${trainerName}") ne correspond pas à l'employé attendu ("${employeeName}").`,
      };
    }

    return {
      isValid: true,
      reason: "trainer_name matches employee identity",
      message: "OK",
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
        this.logger.log(
          `Score recomputed for ${profileId} after target change`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to recompute score after target change: ${err.message}`,
        );
      }
    }

    return saved;
  }

  async getTargets(profileId: string, year: number) {
    return this.targetRepo.findOne({
      where: { profileId, targetYear: year },
    });
  }

  // ── Score Computation ─────────────────────────────────────────────────

  async computeScore(profileId: string, year: number) {
    const key = `${profileId}-${year}`;
    const inflight = this.computeLocks.get(key);
    if (inflight) return inflight;
    const promise = this._computeScoreImpl(profileId, year).finally(() => {
      if (this.computeLocks.get(key) === promise) this.computeLocks.delete(key);
    });
    this.computeLocks.set(key, promise);
    return promise;
  }

  private async _computeScoreImpl(profileId: string, year: number) {
    const participations = await this.participantRepo.find({
      where: { profile: { profile_id: profileId }, assignedBy: Not(IsNull()) },
      relations: ["project"],
    });

    const projectRecords = await this.projectRecordRepo.find({
      where: { profileId },
    });

    const normalizeProjectName = (value?: string | null) =>
      String(value || "")
        .trim()
        .toLowerCase();

    const projectRecordByName = new Map<string, ProjectRecord>();
    const sortedProjectRecords = [...projectRecords].sort((left, right) => {
      const pvDelta =
        Number(Boolean(right.pvVerified)) - Number(Boolean(left.pvVerified));
      if (pvDelta !== 0) {
        return pvDelta;
      }

      const leftDate = this.getProjectRecordReferenceDate(left)?.getTime() || 0;
      const rightDate =
        this.getProjectRecordReferenceDate(right)?.getTime() || 0;
      return rightDate - leftDate;
    });

    for (const record of sortedProjectRecords) {
      const key = normalizeProjectName(record.projectName);
      if (!projectRecordByName.has(key)) {
        projectRecordByName.set(key, record);
      }
    }

    const projects: Array<{
      project_name: string;
      complexity: "low" | "medium" | "high";
      completion_date: string | null;
      pv_verified: boolean;
      individual_score: number | null;
      evaluation_status:
        | "scored_by_own_manager"
        | "pending_external_manager"
        | "scored_by_home_manager";
    }> = [];

    for (const participation of participations) {
      const proj = participation.project;
      const projectName = proj?.projectName || "Projet inconnu";
      const projectKey = normalizeProjectName(projectName);
      const matchingRecord = projectRecordByName.get(projectKey);

      if (participation.assignmentType === "external" && !matchingRecord) {
        continue;
      }

      const completionDate =
        this.getProjectRecordReferenceDate(matchingRecord) ||
        this.normalizeProjectReferenceDate(proj?.endDate) ||
        this.normalizeProjectReferenceDate(proj?.startDate) ||
        null;
      const complexity = this.normalizeProjectComplexity(
        matchingRecord?.complexity || proj?.complexity,
      );

      projects.push({
        project_name: projectName,
        complexity,
        completion_date: completionDate
          ? new Date(completionDate).toISOString().split("T")[0]
          : null,
        pv_verified: Boolean(matchingRecord?.pvVerified),
        individual_score:
          matchingRecord?.individualScore === null ||
          matchingRecord?.individualScore === undefined
            ? null
            : Number(matchingRecord.individualScore),
        evaluation_status: (matchingRecord?.evaluationStatus ||
          "scored_by_own_manager") as any,
      });
    }

    const participatedNames = new Set(
      projects.map((p) => normalizeProjectName(p.project_name)),
    );
    for (const [key, record] of projectRecordByName.entries()) {
      if (participatedNames.has(key)) {
        continue;
      }
      const referenceDate = this.getProjectRecordReferenceDate(record);
      projects.push({
        project_name: record.projectName || "Projet inconnu",
        complexity: this.normalizeProjectComplexity(record.complexity),
        completion_date: referenceDate
          ? referenceDate.toISOString().split("T")[0]
          : null,
        pv_verified: Boolean(record.pvVerified),
        individual_score:
          record.individualScore === null ||
          record.individualScore === undefined
            ? null
            : Number(record.individualScore),
        evaluation_status: (record.evaluationStatus ||
          "scored_by_own_manager") as any,
      });
    }

    const yearProjects = projects.filter((project) => {
      if (!project.completion_date) return false;
      return new Date(project.completion_date).getFullYear() === year;
    });
    const pendingExternalProjects = yearProjects.filter(
      (project) => project.evaluation_status === "pending_external_manager",
    );
    const scoredProjects = yearProjects.filter(
      (project) => project.evaluation_status !== "pending_external_manager",
    );

    const complexityBase: Record<"low" | "medium" | "high", number> = {
      low: 45,
      medium: 65,
      high: 85,
    };
    const roundScore = (value: number) => Math.round(value * 100) / 100;
    const projectItems = yearProjects.map((project) => {
      const managerScoreRaw =
        project.evaluation_status === "pending_external_manager"
          ? null
          : project.individual_score;
      const ceiling = complexityBase[project.complexity] ?? 65;

      let contributionScore = 0;
      let scoringMethod:
        | "execution_x_complexity"
        | "legacy_manager_score"
        | "pending_no_score" = "pending_no_score";
      let explanation =
        project.evaluation_status === "pending_external_manager"
          ? `Awaiting the employee's home manager review. No score counted yet (0/100).`
          : `No execution score recorded yet. Project contributes 0 until a score is given.`;

      if (managerScoreRaw !== null && managerScoreRaw !== undefined) {
        const numericManagerScore = Number(managerScoreRaw);
        if (numericManagerScore > 20) {
          // Legacy records stored on a /100 scale — keep as-is
          contributionScore = Math.max(0, Math.min(100, numericManagerScore));
          scoringMethod = "legacy_manager_score";
          explanation = `Legacy score on /100 scale: ${roundScore(contributionScore)}/100.`;
        } else {
          // New formula: execution score × complexity ceiling
          const clampedScore = Math.max(0, Math.min(20, numericManagerScore));
          contributionScore = roundScore((clampedScore / 20) * ceiling);
          scoringMethod = "execution_x_complexity";
          explanation = `Execution ${roundScore(clampedScore)}/20 × ${project.complexity} ceiling (${ceiling}) = ${roundScore(contributionScore)}/100.`;
        }
      }

      return {
        project_name: project.project_name,
        complexity: project.complexity,
        completion_date: project.completion_date,
        pv_verified: project.pv_verified,
        evaluation_status: project.evaluation_status,
        manager_score_raw:
          managerScoreRaw === null || managerScoreRaw === undefined
            ? null
            : roundScore(Number(managerScoreRaw)),
        manager_score_scale_max: 20,
        contribution_score: roundScore(contributionScore),
        scoring_method: scoringMethod,
        explanation,
      };
    });
    // All year projects contribute to the score.
    // Pending external projects (awaiting home manager score) use the complexity-based score
    // so that external employees benefit from project complexity immediately upon PV upload.
    const projectContributions = projectItems.map(
      (project) => project.contribution_score,
    );
    const projectScore = projectContributions.reduce(
      (sum, value) => sum + value,
      0,
    );

    const certCount = await this.certRepo
      .createQueryBuilder("c")
      .where("c.profile_id = :profileId", { profileId })
      .andWhere("c.status = :status", { status: "active" })
      .andWhere("EXTRACT(YEAR FROM c.issue_date) = :year", { year })
      .getCount();

    const trainingCount = await this.trainingSessionRepo
      .createQueryBuilder("ts")
      .where("ts.profile_id = :profileId", { profileId })
      .andWhere("ts.status = :status", { status: "completed" })
      .andWhere(
        "(EXTRACT(YEAR FROM ts.end_date) = :year OR EXTRACT(YEAR FROM ts.start_date) = :year OR EXTRACT(YEAR FROM ts.due_date) = :year OR EXTRACT(YEAR FROM ts.updated_at) = :year)",
        { year },
      )
      .getCount();

    const formationCount = await this.trainingRecordRepo
      .createQueryBuilder("tr")
      .where("tr.profile_id = :profileId", { profileId })
      .andWhere(
        "(EXTRACT(YEAR FROM tr.end_date) = :year OR EXTRACT(YEAR FROM tr.start_date) = :year)",
        { year },
      )
      .getCount();

    const targets = await this.getTargets(profileId, year);
    const certTarget = targets?.certificationTarget ?? 2;

    const effectiveTarget = Math.max(certTarget, 1);
    const certificationScore = Math.min(
      100,
      (certCount / effectiveTarget) * 100,
    );
    const trainingScore = trainingCount * 20;
    const formationScore = formationCount * 25;

    const finalScore =
      (projectScore + certificationScore + trainingScore + formationScore) / 4;

    const headline =
      finalScore >= 85
        ? {
            tone: "excellent",
            title: "Excellent momentum",
            message:
              "Your current year is tracking at a very high level across the scoring pillars.",
          }
        : finalScore >= 65
          ? {
              tone: "strong",
              title: "Strong progress",
              message:
                "You have a solid score foundation and a clear path to move higher.",
            }
          : finalScore >= 40
            ? {
                tone: "developing",
                title: "Good base to build on",
                message:
                  "You already have visible progress. The next actions below can lift your score quickly.",
              }
            : {
                tone: "starting",
                title: "Your score is just getting started",
                message:
                  "More validated activity this year will quickly improve your score.",
              };

    const nextActions: string[] = [];
    if (pendingExternalProjects.length > 0) {
      nextActions.push(
        `${pendingExternalProjects.length} external project(s) are currently counted with a provisional complexity-based score until your home manager finalizes the review.`,
      );
    }
    if (certCount < effectiveTarget) {
      nextActions.push(
        `You have ${certCount} certification(s) for a target of ${effectiveTarget}. One more certification will increase this pillar immediately.`,
      );
    }
    if (trainingCount < 5) {
      nextActions.push(
        `Each completed training adds 20 points to the training pillar.`,
      );
    }
    if (formationCount < 4) {
      nextActions.push(
        `Each delivered formation adds 25 points to the formation pillar.`,
      );
    }
    if (projectItems.length === 0) {
      nextActions.push(
        "No in-year project is currently counted. Projects only contribute once they fall inside the scoring year.",
      );
    }

    const breakdown = {
      project_score: roundScore(projectScore),
      certification_score: roundScore(certificationScore),
      training_score: roundScore(trainingScore),
      formation_score: roundScore(formationScore),
      final_score: roundScore(finalScore),
      score_formula: "unweighted_average_of_4_pillars",
      manager_score_scale_max: 20,
      project_count: yearProjects.length,
      pending_external_count: pendingExternalProjects.length,
      scored_project_count: scoredProjects.length,
      evaluated_projects: projectItems.filter(
        (project) => project.evaluation_status !== "pending_external_manager",
      ),
      pending_external_projects: projectItems.filter(
        (project) => project.evaluation_status === "pending_external_manager",
      ),
      headline,
      scale: {
        manager_score_max: 20,
        pillar_score_max: 100,
        final_score_max: 100,
      },
      formulas: {
        final:
          "Final score = (Projects + Certifications + Trainings + Formations) / 4",
        projects:
          "Contribution = (execution score / 20) × complexity ceiling. Low complexity: ceiling 45 | Medium: 65 | High: 85. No execution score yet = 0/100 (no fallback). Same rule applies to both internal and external members.",
        certifications: `Certification score = min(100, (${certCount} / ${effectiveTarget}) x 100)`,
        trainings: `Training score = ${trainingCount} x 20`,
        formations: `Formation score = ${formationCount} x 25`,
      },
      workflow: {
        scoring_year: year,
        no_score_fallback: false,
        next_actions: nextActions,
      },
      pillars: {
        projects: {
          score: roundScore(projectScore),
          total_projects_in_year: yearProjects.length,
          scored_projects: scoredProjects.length,
          pending_external_projects: pendingExternalProjects.length,
          items: projectItems,
        },
        certifications: {
          score: roundScore(certificationScore),
          count: certCount,
          target: certTarget,
          effective_target: effectiveTarget,
          progress_percent: roundScore((certCount / effectiveTarget) * 100),
          explanation:
            certTarget > 0
              ? `${certCount} certification(s) counted for a target of ${certTarget}.`
              : `${certCount} certification(s) counted. A minimum target of 1 is used internally to avoid division by zero.`,
        },
        trainings: {
          score: roundScore(trainingScore),
          count: trainingCount,
          points_per_completed_training: 20,
          explanation: `${trainingCount} completed training(s) counted this year. This pillar is not capped.`,
        },
        formations: {
          score: roundScore(formationScore),
          count: formationCount,
          points_per_delivered_formation: 25,
          explanation: `${formationCount} delivered formation(s) counted this year. This pillar is not capped.`,
        },
      },
    };

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

  async computeTeamScores(managerUserId: string, year: number) {
    // Get the manager's team members
    const manager = await this.userRepo.findOne({
      where: { user_id: managerUserId },
    });
    if (!manager) throw new NotFoundException("Manager non trouvé");

    // Find team members via team_members join table
    const profiles = await this.profileRepo
      .createQueryBuilder("ep")
      .innerJoin("team_members", "tm", "tm.employee_id = ep.user_id")
      .innerJoin("teams", "t", "t.team_id = tm.team_id")
      .where("t.manager_id = :managerId", { managerId: managerUserId })
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

  /** Recompute scores for ALL employee profiles (bid_manager action). */
  async computeAllScores(year: number) {
    const profiles = await this.profileRepo.find();
    const results = [];
    for (const profile of profiles) {
      try {
        const result = await this.computeScore(profile.profile_id, year);
        results.push(result);
      } catch (error) {
        this.logger.error(
          `Score computation failed for ${profile.profile_id}: ${error.message}`,
        );
        results.push({ profileId: profile.profile_id, error: error.message });
      }
    }
    await this.updateRankings(year);
    return results;
  }

  // ── Rankings ──────────────────────────────────────────────────────────

  async updateRankings(year: number) {
    const allScores = await this.scoreRepo.find({
      where: { scoreYear: year },
      order: { finalScore: "DESC" },
    });

    const total = allScores.length;

    // 1. Compute global rankings
    for (let i = 0; i < allScores.length; i++) {
      allScores[i].rankGlobal = i + 1;
      allScores[i].percentile =
        total > 1 ? Math.round(((total - (i + 1)) / total) * 10000) / 100 : 100;
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
      .createQueryBuilder("s")
      .leftJoinAndSelect("s.profile", "p")
      .leftJoinAndSelect("p.user", "u")
      .where("s.score_year = :year", { year });

    if (teamId) {
      query = query
        .innerJoin("team_members", "tm", "tm.employee_id = p.user_id")
        .andWhere("tm.team_id = :teamId", { teamId });
    }

    query = query.orderBy("s.final_score", "DESC");

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
            : (user?.email ?? "N/A"),
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
      order: { completionDate: "DESC" },
    });
  }

  async getTrainingRecords(profileId: string) {
    return this.trainingRecordRepo.find({
      where: { profileId },
      order: { startDate: "DESC" },
    });
  }

  async updateProjectRecord(recordId: string, complexity?: string) {
    const record = await this.projectRecordRepo.findOne({
      where: { record_id: recordId },
    });
    if (!record) {
      throw new NotFoundException(
        `Enregistrement projet ${recordId} non trouve`,
      );
    }

    if (complexity) record.complexity = complexity as any;

    const saved = await this.projectRecordRepo.save(record);

    const currentYear = new Date().getFullYear();
    try {
      await this.computeScore(record.profileId, currentYear);
      this.logger.log(
        `Score recomputed for ${record.profileId} after project record update`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to recompute score after project update: ${err.message}`,
      );
    }

    return saved;
  }

  async listPendingExternalEvaluations(managerUserId: string) {
    const rows = await this.projectRecordRepo
      .createQueryBuilder("pr")
      .leftJoin("pr.profile", "ep")
      .leftJoin("ep.user", "u")
      .where("pr.evaluation_status = :status", {
        status: "pending_external_manager",
      })
      .andWhere("pr.external_home_manager_id = :managerUserId", {
        managerUserId,
      })
      .orderBy("pr.created_at", "DESC")
      .select("pr.record_id", "recordId")
      .addSelect("pr.profile_id", "profileId")
      .addSelect("pr.project_name", "projectName")
      .addSelect("pr.client_name", "clientName")
      .addSelect("pr.complexity", "complexity")
      .addSelect(
        "pr.external_contribution_description",
        "externalContributionDescription",
      )
      .addSelect("pr.completion_date", "completionDate")
      .addSelect("pr.submitted_by", "submittedBy")
      .addSelect("pr.created_at", "createdAt")
      .addSelect(
        "CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))",
        "employeeName",
      )
      .addSelect("u.email", "employeeEmail")
      .getRawMany();

    return rows.map((row: any) => ({
      recordId: row.recordId,
      profileId: row.profileId,
      projectName: row.projectName,
      clientName: row.clientName,
      complexity: row.complexity,
      externalContributionDescription: row.externalContributionDescription,
      completionDate: row.completionDate,
      submittedBy: row.submittedBy,
      createdAt: row.createdAt,
      employeeName:
        String(row.employeeName || "").trim() ||
        row.employeeEmail ||
        "Employee",
    }));
  }

  async listPendingInternalEvaluations(managerUserId: string) {
    const rows = await this.projectRecordRepo
      .createQueryBuilder("pr")
      .leftJoin("pr.profile", "ep")
      .leftJoin("ep.user", "u")
      .innerJoin("team_members", "tm", "tm.employee_id = ep.user_id")
      .innerJoin("teams", "t", "t.team_id = tm.team_id")
      .where("t.manager_id = :managerUserId", { managerUserId })
      .andWhere("pr.evaluation_status = :status", {
        status: "scored_by_own_manager",
      })
      .andWhere("pr.individual_score IS NULL")
      .andWhere(
        "COALESCE(pr.parsed_data ->> 'assignment_type', 'internal') = :assignmentType",
        {
          assignmentType: "internal",
        },
      )
      .orderBy("pr.created_at", "DESC")
      .select("pr.record_id", "recordId")
      .addSelect("pr.profile_id", "profileId")
      .addSelect("pr.project_name", "projectName")
      .addSelect("pr.client_name", "clientName")
      .addSelect("pr.project_description", "projectDescription")
      .addSelect("pr.complexity", "complexity")
      .addSelect("pr.completion_date", "completionDate")
      .addSelect(
        "COALESCE(pr.parsed_data ->> 'assignment_date', '')",
        "assignmentDate",
      )
      .addSelect("pr.created_at", "createdAt")
      .addSelect(
        "CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))",
        "employeeName",
      )
      .addSelect("u.email", "employeeEmail")
      .getRawMany();

    return rows.map((row: any) => ({
      recordId: row.recordId,
      profileId: row.profileId,
      projectName: row.projectName,
      clientName: row.clientName,
      projectDescription: row.projectDescription,
      complexity: row.complexity,
      completionDate: row.completionDate,
      assignmentDate: row.assignmentDate || null,
      createdAt: row.createdAt,
      employeeName:
        String(row.employeeName || "").trim() ||
        row.employeeEmail ||
        "Employee",
    }));
  }

  async scoreExternalEvaluation(
    recordId: string,
    managerUserId: string,
    score: number,
  ) {
    if (!Number.isFinite(score) || score < 0 || score > 20) {
      throw new BadRequestException(
        "Le score doit etre compris entre 0 et 20.",
      );
    }

    const record = await this.projectRecordRepo.findOne({
      where: { record_id: recordId },
    });
    if (!record) {
      throw new NotFoundException(
        `Enregistrement projet ${recordId} non trouve`,
      );
    }
    if (record.evaluationStatus !== "pending_external_manager") {
      throw new BadRequestException(
        "Cette evaluation externe a deja ete traitee.",
      );
    }
    if (record.externalHomeManagerId !== managerUserId) {
      throw new ForbiddenException(
        "Vous ne pouvez evaluer que les membres de votre equipe.",
      );
    }
    // Note: isManagerOfProfile check is intentionally omitted here.
    // The externalHomeManagerId check above is the correct authorization for cross-team evaluations.
    // The employee being evaluated may belong to a different team by design.

    record.individualScore = score as any;
    record.evaluationStatus = "scored_by_home_manager";
    record.evaluatedByManagerId = managerUserId;
    record.evaluatedAt = new Date();
    const saved = await this.projectRecordRepo.save(record);

    const completionYear = saved.completionDate
      ? new Date(saved.completionDate).getFullYear()
      : new Date().getFullYear();
    await this.computeScore(saved.profileId, completionYear);
    if (completionYear !== new Date().getFullYear()) {
      await this.computeScore(saved.profileId, new Date().getFullYear());
    }

    const profile = await this.profileRepo.findOne({
      where: { profile_id: saved.profileId },
      relations: ["user"],
    });
    if (profile?.user?.user_id) {
      await this.notificationsService
        .create({
          userId: profile.user.user_id,
          type: "score_updated",
          title: "Score mis a jour",
          message: "Votre evaluation externe a ete finalisee.",
          relatedEntityType: "project_record",
          relatedEntityId: saved.record_id,
        })
        .catch((err) =>
          this.logger.warn(
            `Employee external score notification failed: ${err.message}`,
          ),
        );
    }

    return saved;
  }

  async scoreInternalEvaluation(
    recordId: string,
    managerUserId: string,
    score: number,
  ) {
    if (!Number.isFinite(score) || score < 0 || score > 20) {
      throw new BadRequestException(
        "Le score doit etre compris entre 0 et 20.",
      );
    }

    const record = await this.projectRecordRepo.findOne({
      where: { record_id: recordId },
    });
    if (!record) {
      throw new NotFoundException(
        `Enregistrement projet ${recordId} non trouve`,
      );
    }
    if (!(await this.isManagerOfProfile(managerUserId, record.profileId))) {
      throw new ForbiddenException(
        "Ce collaborateur ne fait pas partie de votre equipe.",
      );
    }
    if (
      String(record.parsedData?.assignment_type || "internal") !== "internal"
    ) {
      throw new BadRequestException(
        "Cette notation directe est reservee aux projets internes.",
      );
    }
    if (record.evaluationStatus === "pending_external_manager") {
      throw new BadRequestException(
        "Ce projet attend une evaluation externe, pas une notation interne directe.",
      );
    }

    record.individualScore = score as any;
    record.evaluationStatus = "scored_by_own_manager";
    record.evaluatedByManagerId = managerUserId;
    record.evaluatedAt = new Date();
    const saved = await this.projectRecordRepo.save(record);

    const referenceYear =
      this.getProjectRecordReferenceDate(saved)?.getFullYear() ||
      new Date().getFullYear();
    await this.computeScore(saved.profileId, referenceYear);
    if (referenceYear !== new Date().getFullYear()) {
      await this.computeScore(saved.profileId, new Date().getFullYear());
    }

    const profile = await this.profileRepo.findOne({
      where: { profile_id: saved.profileId },
      relations: ["user"],
    });
    if (profile?.user?.user_id) {
      await this.notificationsService
        .create({
          userId: profile.user.user_id,
          type: "score_updated",
          title: "Score mis a jour",
          message:
            "Votre manager a finalise la notation de votre projet interne.",
          relatedEntityType: "project_record",
          relatedEntityId: saved.record_id,
        })
        .catch((err) =>
          this.logger.warn(
            `Employee internal score notification failed: ${err.message}`,
          ),
        );
    }

    return saved;
  }

  async scoreInternalProject(
    managerUserId: string,
    projectId: string,
    profileEvaluations: Array<{ profileId: string; score: number }>,
  ) {
    if (!projectId) {
      throw new BadRequestException("Le projet est obligatoire.");
    }
    if (!profileEvaluations?.length) {
      throw new BadRequestException("Au moins une évaluation est requise.");
    }

    const project = await this.projectRepo.findOne({
      where: { project_id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Projet ${projectId} non trouvé`);
    }
    if (project.projectType !== "internal") {
      throw new BadRequestException(
        "Ce flux est réservé aux projets internes.",
      );
    }

    const managerUser = await this.userRepo.findOne({
      where: { user_id: managerUserId },
    });
    const isBidManager = managerUser?.role === UserRole.BID_MANAGER;

    if (
      !isBidManager &&
      project.createdBy &&
      project.createdBy !== managerUserId
    ) {
      throw new ForbiddenException(
        "Vous pouvez évaluer uniquement vos propres projets.",
      );
    }

    const profileIds = profileEvaluations.map((e) => e.profileId);
    const participants = await this.participantRepo.find({
      where: profileIds.map((profileId) => ({
        project: { project_id: projectId },
        profile: { profile_id: profileId },
      })),
      relations: ["profile", "profile.user"],
    });
    const participantMap = new Map(
      participants.map((p) => [p.profile.profile_id, p]),
    );

    const currentYear = new Date().getFullYear();
    const complexity = (project.complexity || "medium") as
      | "low"
      | "medium"
      | "high";
    const completionDate = project.endDate
      ? new Date(project.endDate)
      : new Date();
    const projectName = project.projectName;
    const clientName = project.clientName || null;

    const results: Array<{
      profileId: string;
      employeeName: string;
      score: number;
      recordId: string;
    }> = [];

    for (const { profileId, score } of profileEvaluations) {
      if (!Number.isFinite(score) || score < 0 || score > 20) {
        throw new BadRequestException(
          "Le score doit être compris entre 0 et 20.",
        );
      }
      const participant = participantMap.get(profileId);
      if (!participant) {
        throw new BadRequestException(
          `Le profil ${profileId} n'est pas assigné à ce projet.`,
        );
      }

      const existing = await this.projectRecordRepo.findOne({
        where: {
          profileId,
          projectName,
          clientName: clientName || (IsNull() as any),
        },
      });

      let record: ProjectRecord;
      if (existing) {
        existing.individualScore = score as any;
        existing.evaluationStatus = "scored_by_own_manager";
        existing.evaluatedByManagerId = managerUserId;
        existing.evaluatedAt = new Date();
        existing.complexity = complexity;
        if (!existing.completionDate) existing.completionDate = completionDate;
        record = await this.projectRecordRepo.save(existing);
      } else {
        record = await this.projectRecordRepo.save(
          this.projectRecordRepo.create({
            profileId,
            projectName,
            clientName,
            projectDescription: project.projectDescription || null,
            completionDate,
            complexity,
            pvVerified: false,
            individualScore: score as any,
            evaluationStatus: "scored_by_own_manager",
            evaluatedByManagerId: managerUserId,
            evaluatedAt: new Date(),
            submittedBy: managerUserId,
            parsedData: {
              assignment_type: "internal",
              project_name: projectName,
            },
          }),
        );
      }

      await this.computeScore(profileId, currentYear);
      if (completionDate.getFullYear() !== currentYear) {
        await this.computeScore(profileId, completionDate.getFullYear());
      }

      const profile = participant.profile;
      const employeeName = profile.user
        ? `${profile.user.firstName || ""} ${profile.user.lastName || ""}`.trim() ||
          profile.user.email
        : profileId;

      if (profile.user?.user_id) {
        await this.notificationsService
          .create({
            userId: profile.user.user_id,
            type: "score_updated",
            title: "Score mis à jour",
            message: `Votre manager a évalué votre participation au projet interne "${projectName}".`,
            relatedEntityType: "project_record",
            relatedEntityId: record.record_id,
          })
          .catch((err) =>
            this.logger.warn(
              `Internal score notification failed: ${err.message}`,
            ),
          );
      }

      results.push({
        profileId,
        employeeName,
        score,
        recordId: record.record_id,
      });
    }

    return {
      message: `${results.length} évaluation(s) enregistrée(s) avec succès`,
      results,
    };
  }

  async listProjects(requestUserId: string, role?: string) {
    const query = this.participantRepo
      .createQueryBuilder("pp")
      .innerJoin("pp.project", "proj")
      .innerJoin("pp.profile", "emp")
      .innerJoin("emp.user", "u")
      .andWhere("LOWER(proj.projectName) != :unknown", {
        unknown: "unknown project",
      })
      .select("proj.project_id", "project_id")
      .addSelect("proj.projectName", "projectName")
      .addSelect("proj.clientName", "clientName")
      .addSelect("proj.projectType", "projectType")
      .addSelect("proj.complexity", "complexity")
      .addSelect("proj.startDate", "startDate")
      .addSelect("proj.endDate", "endDate")
      .addSelect("pp.profile_id", "profileId")
      .addSelect("pp.assignment_type", "assignmentType")
      .addSelect("pp.home_manager_id", "homeManagerId")
      .addSelect(
        "CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))",
        "participantName",
      )
      .addSelect("u.email", "participantEmail")
      .orderBy("proj.projectName", "ASC");

    if (role !== UserRole.BID_MANAGER) {
      query.andWhere("proj.createdBy = :managerId", {
        managerId: requestUserId,
      });
    }

    const rows = await query.getRawMany();

    const projectMap = new Map<string, any>();
    for (const row of rows) {
      if (!projectMap.has(row.project_id)) {
        projectMap.set(row.project_id, {
          project_id: row.project_id,
          projectName: row.projectName,
          clientName: row.clientName,
          projectType: row.projectType || "internal",
          complexity: row.complexity,
          startDate: row.startDate,
          endDate: row.endDate,
          participants: [],
        });
      }
      projectMap.get(row.project_id).participants.push({
        profileId: row.profileId,
        assignmentType: row.assignmentType || "internal",
        homeManagerId: row.homeManagerId || null,
        name:
          String(row.participantName || "").trim() ||
          row.participantEmail ||
          "Employee",
      });
    }

    return Array.from(projectMap.values());
  }

  async getScoreHistory(profileId: string) {
    return this.scoreRepo.find({
      where: { profileId },
      order: { scoreYear: "DESC" },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Get the team ID for an employee by their profile ID.
   * Returns null if the employee is not assigned to any team.
   */
  private async isManagerOfProfile(
    managerUserId: string,
    profileId: string,
  ): Promise<boolean> {
    const row = await this.profileRepo
      .createQueryBuilder("ep")
      .innerJoin("team_members", "tm", "tm.employee_id = ep.user_id")
      .innerJoin("teams", "t", "t.team_id = tm.team_id")
      .where("ep.profile_id = :profileId", { profileId })
      .andWhere("t.manager_id = :managerUserId", { managerUserId })
      .select("ep.profile_id", "profile_id")
      .getRawOne();
    return Boolean(row?.profile_id);
  }

  private async getEmployeeTeamId(profileId: string): Promise<string | null> {
    const result = await this.profileRepo
      .createQueryBuilder("ep")
      .innerJoin("team_members", "tm", "tm.employee_id = ep.user_id")
      .where("ep.profile_id = :profileId", { profileId })
      .select("tm.team_id", "team_id")
      .getRawOne();

    return result?.team_id || null;
  }
}
