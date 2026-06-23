import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as path from "path";
import { existsSync } from "fs";
import { FileStorageService } from "../file-storage/file-storage.service";
import { MetadataSyncService } from "../file-storage/metadata-sync.service";
import {
  Certification,
  CertificationStatus,
} from "./entities/certification.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { RagService } from "../rag/rag.service";
import { FileValidationService } from "../file-validation/file-validation.service";
import { formatIsoDate, normalizeFlexibleDate } from "../utils/date-normalizer";
import { TeamsService } from "../teams/teams.service";
import { ScoringService } from "../scoring/scoring.service";
import {
  CreateCertificationDto,
  UpdateCertificationDto,
} from "./dto/certification.dto";

@Injectable()
export class CertificationsService {
  private readonly logger = new Logger(CertificationsService.name);
  private readonly aiServiceBaseUrl: string;

  constructor(
    private readonly fileStorageService: FileStorageService,
    private readonly configService: ConfigService,
    @InjectRepository(Certification)
    private readonly certificationRepository: Repository<Certification>,
    @InjectRepository(EmployeeProfile)
    private readonly profileRepository: Repository<EmployeeProfile>,
    private readonly ragService: RagService,
    private readonly fileValidationService: FileValidationService,
    private readonly teamsService: TeamsService,
    private readonly scoringService: ScoringService,
    private readonly metadataSyncService: MetadataSyncService,
  ) {
    this.aiServiceBaseUrl =
      this.configService.get<string>("AI_SERVICE_URL")?.replace(/\/+$/, "") ||
      "http://127.0.0.1:8000";
  }

  async saveEmployeeCertification(
    user: any,
    file: Express.Multer.File,
    expectedCertificationName?: string,
  ) {
    await this.fileValidationService.validate(file, "certification");
    const userId = typeof user === "string" ? user : user.user_id || user.id;

    // #3 Defense-in-depth: a proof can only be accepted for a user whose name is
    // configured. Otherwise the AI ownership check (_verify_user_name) is skipped
    // and ANY document would pass. The CV upload is what populates these names.
    const firstName =
      typeof user === "object" && user ? (user.firstName as string) : undefined;
    const lastName =
      typeof user === "object" && user ? (user.lastName as string) : undefined;
    if (!firstName?.trim() || !lastName?.trim()) {
      throw new BadRequestException(
        "Veuillez d'abord configurer votre nom (importez votre CV) avant d'ajouter un justificatif de certification.",
      );
    }

    // 1. Call AI service for OCR parsing
    let parsedData = null;
    try {
      const formData = new FormData();
      formData.append("user_id", userId);

      if (typeof user === "object" && user) {
        if (user.firstName) formData.append("first_name", user.firstName);
        if (user.lastName) formData.append("last_name", user.lastName);
      }

      const blob = new Blob([file.buffer as any], { type: file.mimetype });
      formData.append("file", blob, file.originalname);

      const aiUrl = `${this.aiServiceBaseUrl}/api/v1/parsing/certification`;
      const aiResponse = await fetch(aiUrl, {
        method: "POST",
        body: formData,
      });

      if (aiResponse.ok) {
        parsedData = await aiResponse.json();
        this.logger.log(
          `AI parsing successful for certification: ${JSON.stringify(parsedData)}`,
        );
      } else {
        this.logger.error(
          `AI parsing failed (${aiResponse.status}) for ${aiUrl}: ${aiResponse.statusText}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error && typeof error === "object" && "cause" in error
          ? String((error as { cause?: unknown }).cause)
          : undefined;
      this.logger.error(
        `Error during AI parsing (base URL: ${this.aiServiceBaseUrl}): ${message}${cause ? ` | cause: ${cause}` : ""}`,
      );
    }

    if (!parsedData || !parsedData.success) {
      throw new BadRequestException(
        parsedData?.error ||
          "Failed to parse certification or verify name match.",
      );
    }

    // #1 Strict binding: when the proof is uploaded for a specific "À confirmer"
    // card, the OCR'd certification name MUST match that card. Otherwise we would
    // silently create a different verified certification next to the targeted one.
    const parsedCertName = (parsedData.certification_name || "").trim();
    if (
      expectedCertificationName?.trim() &&
      !this.certificationNamesMatch(parsedCertName, expectedCertificationName)
    ) {
      this.logger.warn(
        `[AUDIT][certification.proof] user=${userId} result=REJECTED_MISMATCH ` +
          `expected="${expectedCertificationName.trim()}" parsed="${parsedCertName}"`,
      );
      throw new BadRequestException(
        `Le justificatif détecté (« ${parsedCertName || "inconnu"} ») ne correspond pas à la certification ciblée (« ${expectedCertificationName.trim()} »). Vérifiez que vous importez le bon document.`,
      );
    }

    const parsedExpirationDate = normalizeFlexibleDate(
      parsedData.expiration_date,
      "end",
    );
    const parsedIssueDate = normalizeFlexibleDate(
      parsedData.issue_date,
      "start",
    );
    const certName = (parsedData.certification_name || "Certification").trim();
    const preferredFileName = certName.slice(0, 120);

    // 2. Save file to storage
    const storageResult = await this.fileStorageService.saveEmployeeFile(
      userId,
      file,
      "Certifications",
      { preferredFileName, overwrite: true },
    );

    // 3. Update metadata.json with certification
    await this.fileStorageService.addCertificationToMetadata(userId, {
      name: parsedData.certification_name,
      issuer: parsedData.issuer,
      expiration:
        formatIsoDate(parsedExpirationDate) ||
        parsedData.expiration_date ||
        null,
    });

    // 4. Save to database
    await this.saveCertificationToDatabase(
      userId,
      parsedData,
      parsedIssueDate,
      parsedExpirationDate,
      storageResult.path,
    );

    // #7 Audit trail for every accepted proof (who, what, when, signals).
    this.logger.log(
      `[AUDIT][certification.proof] user=${userId} result=ACCEPTED ` +
        `cert="${certName}" issuer="${parsedData.issuer || ""}" ` +
        `credentialId="${parsedData.credential_id || ""}" ` +
        `issueDate="${formatIsoDate(parsedIssueDate) || ""}" ` +
        `expiration="${formatIsoDate(parsedExpirationDate) || ""}" ` +
        `file="${storageResult.filename}"`,
    );

    return {
      ...storageResult,
      parsed_data: parsedData,
    };
  }

  private async saveCertificationToDatabase(
    userId: string,
    parsedData: any,
    parsedIssueDate: Date | null,
    parsedExpirationDate: Date | null,
    filePath?: string,
  ) {
    // Find user's profile
    const profile = await this.profileRepository.findOne({
      where: { user: { user_id: userId } },
    });

    if (!profile) {
      this.logger.warn(`No profile found for user ${userId}, skipping DB save`);
      return;
    }

    // Find a certification already listed for this employee that this proof
    // corresponds to, so the upload upgrades it instead of creating a near
    // duplicate. Matching is lenient (casing / accents / punctuation / OCR
    // formatting differences) — prefer an exact name match, then an as-yet
    // unverified entry, then any lenient match (e.g. re-uploading proof for an
    // already verified cert just refreshes it).
    const certName = parsedData.certification_name || "Unknown Certification";
    const profileCerts = await this.certificationRepository.find({
      where: { profile: { profile_id: profile.profile_id } },
    });
    const existingCert =
      profileCerts.find((c) => c.certificationName === certName) ??
      profileCerts.find(
        (c) =>
          !c.isUploaded &&
          this.certificationNamesMatch(c.certificationName, certName),
      ) ??
      profileCerts.find((c) =>
        this.certificationNamesMatch(c.certificationName, certName),
      ) ??
      null;

    if (existingCert) {
      // Upgrade the matched cert to a verified uploaded cert. Every field now
      // comes from the analysed certificate (the source of truth), including
      // the name, so a prior parsing error is corrected by the upload.
      existingCert.certificationName =
        certName || existingCert.certificationName;
      existingCert.isUploaded = true;
      existingCert.issuingOrganization =
        parsedData.issuer || existingCert.issuingOrganization;
      existingCert.issueDate = parsedIssueDate || existingCert.issueDate;
      existingCert.expirationDate =
        parsedExpirationDate || existingCert.expirationDate;
      existingCert.credentialId =
        parsedData.credential_id || existingCert.credentialId;
      existingCert.filePath = filePath || existingCert.filePath;

      await this.certificationRepository.save(existingCert);
      this.logger.log(
        `Upgraded existing certification to uploaded status for user ${userId}`,
      );
    } else {
      // Create and save new certification
      const certification = this.certificationRepository.create({
        profile: profile,
        certificationName: certName,
        issuingOrganization: parsedData.issuer,
        issueDate: parsedIssueDate,
        expirationDate: parsedExpirationDate,
        credentialId: parsedData.credential_id,
        filePath: filePath,
        isUploaded: true,
      });

      await this.certificationRepository.save(certification);
      this.logger.log(
        `Saved new verified certification to database for user ${userId}`,
      );
    }

    // Trigger RAG Sync
    await this.ragService.triggerUserSync(userId);

    // Trigger score recomputation so the certification is immediately reflected.
    // Use the cert's issue year if available, else current year.
    const certYear = parsedIssueDate?.getFullYear() ?? new Date().getFullYear();
    try {
      await this.scoringService.computeScore(profile.profile_id, certYear);
      this.logger.log(
        `Score recomputed for profile ${profile.profile_id} after certification upload (year ${certYear})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Score recompute failed after certification upload for ${profile.profile_id}: ${err.message}`,
      );
    }
  }

  /**
   * Self-service: create a manual (unverified) certification entry so an
   * employee can correct a CV parsing error. Always created with
   * isUploaded=false — proof verification is the only path to is_uploaded=true.
   */
  async createCertification(userId: string, dto: CreateCertificationDto) {
    const profile = await this.profileRepository.findOne({
      where: { user: { user_id: userId } },
    });
    if (!profile) {
      throw new NotFoundException("Employee profile not found");
    }

    const certification = this.certificationRepository.create({
      profile,
      certificationName: dto.certificationName.trim(),
      issuingOrganization: dto.issuingOrganization?.trim() || null,
      issueDate: dto.issueDate
        ? normalizeFlexibleDate(dto.issueDate, "start")
        : null,
      expirationDate: dto.expirationDate
        ? normalizeFlexibleDate(dto.expirationDate, "end")
        : null,
      credentialId: dto.credentialId?.trim() || null,
      isUploaded: false,
    });

    await this.certificationRepository.save(certification);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return certification;
  }

  /**
   * Self-service: edit a certification's metadata. Blocked once a proof has
   * been verified (isUploaded=true) — editing name/dates after verification
   * would let an employee rename a verified cert into an unverified claim
   * without ever re-proving it. Verified certs can only be removed (delete),
   * not renamed; corrections to a verified cert require re-uploading proof
   * via the existing /certifications/upload flow.
   */
  async updateCertification(
    userId: string,
    certificationId: string,
    dto: UpdateCertificationDto,
  ) {
    const cert = await this.certificationRepository.findOne({
      where: { certification_id: certificationId },
      relations: ["profile", "profile.user"],
    });
    if (!cert || cert.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Certification not found");
    }
    if (cert.isUploaded) {
      throw new BadRequestException(
        "Cette certification est vérifiée et ne peut plus être modifiée ici. Supprimez-la puis ré-importez un justificatif si nécessaire.",
      );
    }

    if (dto.certificationName !== undefined) {
      cert.certificationName = dto.certificationName.trim();
    }
    if (dto.issuingOrganization !== undefined) {
      cert.issuingOrganization = dto.issuingOrganization?.trim() || null;
    }
    if (dto.issueDate !== undefined) {
      cert.issueDate = dto.issueDate
        ? normalizeFlexibleDate(dto.issueDate, "start")
        : null;
    }
    if (dto.expirationDate !== undefined) {
      cert.expirationDate = dto.expirationDate
        ? normalizeFlexibleDate(dto.expirationDate, "end")
        : null;
    }
    if (dto.credentialId !== undefined) {
      cert.credentialId = dto.credentialId?.trim() || null;
    }

    await this.certificationRepository.save(cert);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return cert;
  }

  async deleteCertification(userId: string, certificationId: string) {
    const cert = await this.certificationRepository.findOne({
      where: { certification_id: certificationId },
      relations: ["profile", "profile.user"],
    });
    if (!cert || cert.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Certification not found");
    }

    await this.certificationRepository.remove(cert);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return { success: true };
  }

  /**
   * Get global certification statistics for BID managers
   */
  async getGlobalCertStats() {
    const today = new Date();
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    // Strict gating: only verified (proof-uploaded) certifications are reported.
    const all = await this.certificationRepository
      .createQueryBuilder("cert")
      .leftJoinAndSelect("cert.profile", "profile")
      .where("cert.is_uploaded = true")
      .getMany();

    const stats = {
      total: all.length,
      active: 0,
      expiringSoon: 0,
      expired: 0,
      expiringThisMonth: 0,
    };

    const byOrg: Record<string, number> = {};

    for (const cert of all) {
      const status = this.calculateStatus(cert.expirationDate);
      if (status === CertificationStatus.ACTIVE) stats.active++;
      else if (status === CertificationStatus.EXPIRING_SOON)
        stats.expiringSoon++;
      else if (status === CertificationStatus.EXPIRED) stats.expired++;

      if (cert.expirationDate) {
        const exp = new Date(cert.expirationDate);
        if (exp >= today && exp <= endOfMonth) stats.expiringThisMonth++;
      }

      const org = cert.issuingOrganization?.split(" ")[0] || "Other";
      byOrg[org] = (byOrg[org] || 0) + 1;
    }

    const byOrgArray = Object.entries(byOrg)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    return { ...stats, byOrg: byOrgArray };
  }

  /**
   * Get all certifications for team members managed by a specific manager
   */
  async getTeamCertifications(managerUserId: string) {
    // Get team members
    const teamMembers =
      await this.teamsService.getMembersForManager(managerUserId);

    if (teamMembers.length === 0) {
      return [];
    }

    // Get profile IDs for team members
    const profileIds = teamMembers
      .map((member) => member.profileId)
      .filter(Boolean);

    if (profileIds.length === 0) {
      return [];
    }

    // Query certifications for all team members with employee details
    const certifications = await this.certificationRepository
      .createQueryBuilder("cert")
      .leftJoinAndSelect("cert.profile", "profile")
      .leftJoinAndSelect("profile.user", "user")
      .where("cert.profile.profile_id IN (:...profileIds)", { profileIds })
      .andWhere("cert.is_uploaded = true")
      .orderBy("cert.expirationDate", "ASC")
      .getMany();

    // Map to include employee information
    return certifications.map((cert) => ({
      certification_id: cert.certification_id,
      certificationName: cert.certificationName,
      issuingOrganization: cert.issuingOrganization,
      issueDate: cert.issueDate,
      expirationDate: cert.expirationDate,
      status: this.calculateStatus(cert.expirationDate),
      credentialId: cert.credentialId,
      hasProof: Boolean(cert.filePath),
      employeeId: cert.profile?.user?.user_id,
      employeeName: cert.profile?.user
        ? `${cert.profile.user.firstName || ""} ${cert.profile.user.lastName || ""}`.trim() ||
          cert.profile.user.email
        : "Unknown",
      employeeEmail: cert.profile?.user?.email,
    }));
  }

  /**
   * Whether the OCR'd certification name matches the targeted "À confirmer" card.
   * Lenient (equality / containment / strong token overlap) so legitimate OCR
   * formatting differences still pass, while a clearly different certificate
   * (e.g. Azure proof dropped on an AWS card) is rejected.
   */
  private certificationNamesMatch(a: string, b: string): boolean {
    const na = this.normalizeCertNameForMatch(a);
    const nb = this.normalizeCertNameForMatch(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;

    const ta = new Set(na.split(" ").filter(Boolean));
    const tb = new Set(nb.split(" ").filter(Boolean));
    const [shorter, longer] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    if (shorter.size === 0) return false;
    let common = 0;
    shorter.forEach((t) => {
      if (longer.has(t)) common += 1;
    });
    return common / shorter.size >= 0.6;
  }

  private normalizeCertNameForMatch(value: string): string {
    return (value || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  /**
   * Resolve a certification's stored proof file for download, with strict
   * path-traversal protection (the resolved path must stay inside storage root).
   * Returns null when the requester is not allowed or no proof exists.
   */
  async getCertificationProof(
    certificationId: string,
    requester: { userId: string; role?: string },
  ): Promise<{ absolutePath: string; fileName: string } | null> {
    const cert = await this.certificationRepository.findOne({
      where: { certification_id: certificationId },
      relations: ["profile", "profile.user"],
    });
    if (!cert || !cert.filePath) {
      return null;
    }

    // Owner can always view their own proof. Managers/BID can view team proofs.
    const isOwner = cert.profile?.user?.user_id === requester.userId;
    const isManager =
      requester.role === "team_manager" || requester.role === "bid_manager";
    if (!isOwner && !isManager) {
      return null;
    }

    const storageRoot = path.resolve(this.fileStorageService.getStorageRoot());
    const absolutePath = path.resolve(process.cwd(), cert.filePath);
    if (
      absolutePath !== storageRoot &&
      !absolutePath.startsWith(storageRoot + path.sep)
    ) {
      this.logger.warn(
        `[AUDIT][certification.proof] BLOCKED path traversal attempt cert=${certificationId} path=${cert.filePath}`,
      );
      return null;
    }
    if (!existsSync(absolutePath)) {
      return null;
    }

    return { absolutePath, fileName: path.basename(absolutePath) };
  }

  /**
   * Calculate certification status based on expiration date
   */
  private calculateStatus(expirationDate: Date | null): CertificationStatus {
    if (!expirationDate) {
      return CertificationStatus.ACTIVE;
    }

    const now = new Date();
    const expDate = new Date(expirationDate);
    const daysUntilExpiration = Math.ceil(
      (expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilExpiration < 0) {
      return CertificationStatus.EXPIRED;
    } else if (daysUntilExpiration <= 30) {
      return CertificationStatus.EXPIRING_SOON;
    } else {
      return CertificationStatus.ACTIVE;
    }
  }

  /**
   * Get certification statistics for a team
   */
  async getTeamCertificationStats(managerUserId: string) {
    const certifications = await this.getTeamCertifications(managerUserId);

    const stats = {
      total: certifications.length,
      active: 0,
      expiring_soon: 0,
      expired: 0,
    };

    certifications.forEach((cert) => {
      switch (cert.status) {
        case CertificationStatus.ACTIVE:
          stats.active++;
          break;
        case CertificationStatus.EXPIRING_SOON:
          stats.expiring_soon++;
          break;
        case CertificationStatus.EXPIRED:
          stats.expired++;
          break;
      }
    });

    return stats;
  }
}
