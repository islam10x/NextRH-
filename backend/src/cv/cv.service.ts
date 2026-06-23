import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import { MetadataSnapshot } from "./entities/metadata-snapshot.entity";
import { User } from "../users/entities/user.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { WorkExperience } from "../employees/entities/work-experience.entity";
import { Education } from "../employees/entities/education.entity";
import {
  Certification,
  CertificationStatus,
} from "../certifications/entities/certification.entity";
import { Project } from "../projects/entities/project.entity";
import { ProjectParticipant } from "../projects/entities/participant.entity";
import { FileStorageService } from "../file-storage/file-storage.service";
import { MetadataSyncService } from "../file-storage/metadata-sync.service";
import { RagService } from "../rag/rag.service";
import { FileValidationService } from "../file-validation/file-validation.service";
import {
  normalizeFlexibleDate,
  parseFlexibleDateRange,
} from "../utils/date-normalizer";
import { AIGenerationService } from "../ai-generation/ai-generation.service";
import { CvTemplatesService } from "../cv-templates/cv-templates.service";
import { UpdateProfileBasicsDto } from "./dto/update-profile-basics.dto";
import {
  CreateWorkExperienceDto,
  UpdateWorkExperienceDto,
} from "./dto/work-experience.dto";
import { CreateEducationDto, UpdateEducationDto } from "./dto/education.dto";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

@Injectable()
export class CvService {
  private readonly logger = new Logger(CvService.name);
  private readonly aiServiceBaseUrl: string;
  private static readonly NEXT_STEP_COMPANY_KEYS = new Set([
    "nextstepit",
    "nextstep",
  ]);

  constructor(
    @InjectRepository(MetadataSnapshot)
    private metadataRepository: Repository<MetadataSnapshot>,
    @InjectRepository(EmployeeProfile)
    private profileRepository: Repository<EmployeeProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(WorkExperience)
    private experienceRepository: Repository<WorkExperience>,
    @InjectRepository(Education)
    private educationRepository: Repository<Education>,
    @InjectRepository(Certification)
    private certificationRepository: Repository<Certification>,
    @InjectRepository(Project)
    private projectRepository: Repository<Project>,
    @InjectRepository(ProjectParticipant)
    private participantRepository: Repository<ProjectParticipant>,
    private readonly fileStorageService: FileStorageService,
    private readonly metadataSyncService: MetadataSyncService,
    private readonly configService: ConfigService,
    private readonly ragService: RagService,
    private readonly fileValidationService: FileValidationService,
    private readonly aiGenerationService: AIGenerationService,
    private readonly cvTemplatesService: CvTemplatesService,
  ) {
    this.aiServiceBaseUrl =
      this.configService.get<string>("AI_SERVICE_URL")?.replace(/\/+$/, "") ||
      "http://127.0.0.1:8000";
  }

  /**
   * Returns a flat DTO of the employee's full CV profile pulled from the DB
   * plus skills from the metadata.json file.
   */
  async getMyProfile(userId: string) {
    const user = await this.userRepository.findOne({
      where: { user_id: userId },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const fullName =
      [this.cleanText(user.firstName), this.cleanText(user.lastName)]
        .filter(Boolean)
        .join(" ") || user.email;

    const profile = await this.profileRepository.findOne({
      where: { user: { user_id: userId } },
      relations: [
        "workExperiences",
        "educations",
        "certifications",
        "projectParticipations",
        "projectParticipations.project",
        "projectParticipations.project.skills",
      ],
    });

    // Skills live in the metadata.json file (populated during CV parse)
    this.logger.error(
      `[STABILIZATION] ATTEMPTING DATA RECOVERY FOR USER: ${userId}`,
    );

    const metaData = await this.fileStorageService.getEmployeeMetadata(userId);
    const rawMeta = await this.fileStorageService.getRawMetadata(userId);
    // DB column is the source of truth once the employee has corrected it;
    // fall back to the value parsed from the CV (metadata.json) otherwise.
    const phone =
      this.cleanText(profile?.phone) ||
      this.cleanText(rawMeta?.structured_data?.phone) ||
      null;
    let address = this.cleanText(profile?.address) || null;
    if (!address) {
      // Parsed address often has trailing artifacts; cut at section headers.
      const rawAddress: string = this.cleanText(
        rawMeta?.structured_data?.address,
      );
      address = rawAddress
        ? this.stripAtFirstSectionMarker(rawAddress) || null
        : null;
    }
    const cvFilename = rawMeta?.filename || null;
    const fallbackCertifications =
      this.extractCertificationsFromMetadata(rawMeta);
    const toDateString = (value: Date | string | null | undefined) => {
      if (!value) return null;
      try {
        const dateObj =
          value instanceof Date ? value : new Date(String(value).trim());
        if (!isNaN(dateObj.getTime())) {
          return dateObj.toISOString().split("T")[0];
        }
      } catch (e) {
        // fall through
      }
      if (typeof value === "string" && value.trim()) return value.trim();
      return null;
    };

    const fallbackWorkExperiences = (
      rawMeta?.structured_data?.experience ||
      rawMeta?.structured_data?.work_experiences ||
      []
    ).map((exp: any, i: number) => ({
      id: `fb-exp-${i}`,
      jobTitle: exp.jobTitle || exp.title || exp.job_title || null,
      companyName: exp.companyName || exp.company || exp.company_name || null,
      startDate: toDateString(exp.startDate || exp.start_date || null),
      endDate: toDateString(exp.endDate || exp.end_date || null),
      isCurrent: exp.isCurrent || exp.is_current || false,
      description: exp.description || null,
    }));

    const fallbackEducations = (
      rawMeta?.structured_data?.education ||
      rawMeta?.structured_data?.educations ||
      []
    ).map((edu: any, i: number) => ({
      id: `fb-edu-${i}`,
      degree: edu.degree || edu.diploma || null,
      fieldOfStudy: edu.fieldOfStudy || edu.field_of_study || null,
      institution: edu.institution || edu.school || null,
      endDate: toDateString(edu.endDate || edu.end_date || edu.date || null),
      startDate: toDateString(edu.startDate || edu.start_date || null),
    }));

    const fallbackProjects = (rawMeta?.structured_data?.projects || []).map(
      (proj: any, i: number) => ({
        id: `fb-proj-${i}`,
        name: proj.projectName || proj.name || proj.project_name || null,
        client: proj.client || null,
        description: proj.description || null,
        startDate: toDateString(proj.startDate || proj.start_date || null),
        endDate: toDateString(proj.endDate || proj.end_date || null),
        skills: proj.skills || [],
      }),
    );

    if (!profile) {
      return {
        profileId: null,
        profile_id: null,
        name: fullName,
        email: user.email,
        phone,
        address,
        cvFilename,
        currentPosition: null,
        professionalSummary:
          profile?.professionalSummary ||
          (rawMeta?.structured_data?.summary as string) ||
          null,
        totalExperienceYears: profile?.totalExperienceYears || null,
        skills:
          metaData.skills && metaData.skills.length > 0
            ? metaData.skills
            : rawMeta?.structured_data?.skills || [],
        lastUpdate: metaData.last_update ?? null,
        workExperiences: fallbackWorkExperiences,
        educations: fallbackEducations,
        certifications: fallbackCertifications,
        projects: fallbackProjects,
      };
    }

    const workExperiencesFromDb = (profile.workExperiences ?? []).map(
      (exp) => ({
        id: exp.experience_id,
        jobTitle: this.cleanText(exp.jobTitle),
        companyName: this.cleanText(exp.companyName),
        startDate: toDateString(exp.startDate),
        endDate: toDateString(exp.endDate),
        isCurrent: exp.isCurrent,
        description: this.cleanText(exp.description),
      }),
    );
    const workExperiences =
      workExperiencesFromDb.length > 0
        ? workExperiencesFromDb
        : fallbackWorkExperiences;

    const educationsFromDb = (profile.educations ?? [])
      .map((edu) => {
        const normalized = this.normalizeEducationEntry({
          degree: edu.degree,
          fieldOfStudy: edu.fieldOfStudy,
          institution: edu.institution,
          endDate: edu.endDate,
        });

        if (!normalized) {
          return null;
        }

        return {
          id: edu.education_id,
          degree: normalized.degree,
          fieldOfStudy: normalized.fieldOfStudy,
          institution: normalized.institution,
          endDate: toDateString(normalized.endDate),
        };
      })
      .filter(Boolean);
    const educations =
      educationsFromDb.length > 0 ? educationsFromDb : fallbackEducations;

    const certByKey = new Map<
      string,
      {
        id: string;
        name: string;
        issuingOrganization: string | null;
        issueDate: string | null;
        expirationDate: string | null;
        status: CertificationStatus;
        isUploaded: boolean;
      }
    >();

    for (const cert of profile.certifications ?? []) {
      const cleanedName = this.normalizeCertificationName(
        cert.certificationName,
      );
      if (!this.isUsableCertificationName(cleanedName)) {
        continue;
      }

      const key = this.normalizeCertKey(cleanedName);
      const existing = certByKey.get(key);
      const normalizedIssuer = this.cleanText(cert.issuingOrganization) || null;
      const normalizedIssueDate = toDateString(cert.issueDate);
      const normalizedExpirationDate = toDateString(cert.expirationDate);

      if (!existing) {
        certByKey.set(key, {
          id: cert.certification_id,
          name: cleanedName,
          issuingOrganization: normalizedIssuer,
          issueDate: normalizedIssueDate,
          expirationDate: normalizedExpirationDate,
          status: cert.status,
          isUploaded: cert.isUploaded ?? false,
        });
        continue;
      }

      existing.issuingOrganization =
        existing.issuingOrganization || normalizedIssuer;
      existing.issueDate = existing.issueDate || normalizedIssueDate;
      existing.expirationDate =
        existing.expirationDate || normalizedExpirationDate;
      if (
        existing.status !== CertificationStatus.ACTIVE &&
        cert.status === CertificationStatus.ACTIVE
      ) {
        existing.status = cert.status;
      }
      if (!existing.isUploaded && (cert.isUploaded ?? false)) {
        existing.isUploaded = true;
      }
    }

    let certifications = Array.from(certByKey.values());
    if (certifications.length === 0 && fallbackCertifications.length > 0) {
      certifications = fallbackCertifications;
    }

    let projects = (profile.projectParticipations ?? [])
      .map((p) => {
        const projectName = this.cleanText(p.project?.projectName);
        const rawClientName = this.cleanText(p.project?.clientName);
        const projectDescription = this.normalizeProjectDescription(
          p.description || p.project?.projectDescription || "",
          rawClientName,
        );
        const clientName = this.normalizeProjectClientName(rawClientName);
        const role = this.normalizeProjectRole(p.role);

        return {
          id: p.participant_id,
          name: projectName || "Unknown Project",
          generatedTitle: this.cleanText(p.project?.generatedTitle) || null,
          client: clientName,
          description: projectDescription,
          role,
          skills: (p.project?.skills ?? [])
            .map((s) => this.cleanText(s.skillName))
            .filter(Boolean),
          startDate: toDateString(p.project?.startDate),
          endDate: toDateString(p.project?.endDate),
        };
      })
      .filter(
        (project) =>
          !(
            project.name.toLowerCase() === "unknown project" &&
            !project.client &&
            !project.description
          ),
      );

    if (projects.length === 0) {
      const rawMetadata = await this.fileStorageService.getRawMetadata(userId);
      const fileProjects =
        rawMetadata?.projects || rawMetadata?.structured_data?.projects;
      if (Array.isArray(fileProjects) && fileProjects.length > 0) {
        projects = fileProjects.map((p: any, idx: number) => ({
          id: `file-prj-${idx}`,
          name: p.name || p.displayTitle || "Project",
          generatedTitle: p.generatedTitle || null,
          client: p.client || "",
          startDate: toDateString(p.startDate || p.date || ""),
          endDate: toDateString(p.endDate || ""),
          description: p.description || "",
          role: p.role || "",
          skills: p.skills || [],
        }));
      }
    }

    if (projects.length === 0 && fallbackProjects.length > 0) {
      projects = fallbackProjects;
    }

    return {
      profileId: profile.profile_id,
      profile_id: profile.profile_id,
      name: fullName,
      email: user.email,
      phone,
      address,
      cvFilename,
      currentPosition: profile.currentPosition ?? null,
      professionalSummary:
        profile.professionalSummary ??
        (this.cleanText(rawMeta?.structured_data?.summary) || null),
      totalExperienceYears: profile.totalExperienceYears ?? null,
      skills: metaData.skills ?? [],
      lastUpdate: metaData.last_update ?? null,
      workExperiences,
      educations,
      certifications,
      projects,
    };
  }

  private extractCertificationsFromMetadata(rawMeta: any) {
    const structuredCerts = rawMeta?.structured_data?.certifications;
    const topLevelCerts = rawMeta?.certifications;
    const rawCerts = [
      ...(Array.isArray(structuredCerts) ? structuredCerts : []),
      ...(Array.isArray(topLevelCerts) ? topLevelCerts : []),
    ];
    if (rawCerts.length === 0) {
      return [];
    }

    const formatDate = (value: Date | null) =>
      value ? value.toISOString().split("T")[0] : null;
    const deduped = new Map<
      string,
      {
        name: string;
        issuer: string | null;
        issue: Date | null;
        expiration: Date | null;
        isUploaded: boolean;
      }
    >();

    rawCerts.forEach((cert: any) => {
      if (cert == null) return;
      if (typeof cert === "string") {
        const name = this.normalizeCertificationName(cert);
        if (!this.isUsableCertificationName(name)) return;
        const key = this.normalizeCertKey(name);
        if (!deduped.has(key)) {
          deduped.set(key, {
            name,
            issuer: null,
            issue: null,
            expiration: null,
            isUploaded: false,
          });
        }
        return;
      }
      if (typeof cert !== "object") return;

      const name = this.normalizeCertificationName(
        cert.name || cert.certification_name,
      );
      if (!this.isUsableCertificationName(name)) return;
      const key = this.normalizeCertKey(name);

      const issuer =
        this.cleanText(
          cert.issuer || cert.issuing_organization || cert.issuingOrganization,
        ) || null;
      const issueDate = normalizeFlexibleDate(
        cert.date_obtained || cert.issue_date || cert.issueDate,
        "start",
      );
      const expirationDate = normalizeFlexibleDate(
        cert.expiration_date ||
          cert.expiry_date ||
          cert.expirationDate ||
          cert.expiration,
        "end",
      );
      const isUploaded = Boolean(cert.is_uploaded ?? cert.isUploaded);

      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, {
          name,
          issuer,
          issue: issueDate,
          expiration: expirationDate,
          isUploaded,
        });
        return;
      }
      if (!existing.issuer && issuer) existing.issuer = issuer;
      if (!existing.issue && issueDate) existing.issue = issueDate;
      if (!existing.expiration && expirationDate)
        existing.expiration = expirationDate;
      if (!existing.isUploaded && isUploaded) existing.isUploaded = true;
    });

    const now = new Date();
    const expiringSoonCutoff = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );

    return Array.from(deduped.values()).map((cert, index) => {
      let status: CertificationStatus = CertificationStatus.ACTIVE;
      if (cert.expiration) {
        if (cert.expiration < now) {
          status = CertificationStatus.EXPIRED;
        } else if (cert.expiration <= expiringSoonCutoff) {
          status = CertificationStatus.EXPIRING_SOON;
        }
      }
      return {
        id: `meta-${index}`,
        name: cert.name,
        issuingOrganization: cert.issuer,
        issueDate: formatDate(cert.issue),
        expirationDate: formatDate(cert.expiration),
        status,
        isUploaded: cert.isUploaded,
      };
    });
  }

  /**
   * Core Logic: Physical file storage management
   * Consolidated: Saves file AND triggers parsing
   */
  private extractWorkExperiencesFromMetadata(rawMeta: any) {
    const structuredExperiences = rawMeta?.structured_data?.experience;
    const topLevelExperiences = rawMeta?.experience;
    const rawExperiences = [
      ...(Array.isArray(structuredExperiences) ? structuredExperiences : []),
      ...(Array.isArray(topLevelExperiences) ? topLevelExperiences : []),
    ];

    if (rawExperiences.length === 0) {
      return [];
    }

    const formatDate = (value: Date | null) =>
      value ? value.toISOString().split("T")[0] : null;

    return rawExperiences
      .map((exp: any, index: number) => {
        if (!exp || typeof exp !== "object") {
          return null;
        }

        const rawStartDate = this.cleanText(
          exp.start_date || exp.period || exp.date_range || exp.date,
        );
        const rawEndDate = this.cleanText(exp.end_date);
        const rawTitle = this.cleanText(exp.title || exp.job_title || exp.role);
        const rawCompany = this.cleanText(
          exp.company || exp.company_name || exp.organisme,
        );
        const description = this.cleanText(exp.description);
        if (
          !rawStartDate &&
          !rawEndDate &&
          !rawTitle &&
          !rawCompany &&
          !description
        ) {
          return null;
        }

        const parsedRange = parseFlexibleDateRange(rawStartDate);
        const explicitStartDate = normalizeFlexibleDate(rawStartDate, "start");
        const explicitEndDate = normalizeFlexibleDate(rawEndDate, "end");
        const isCurrent =
          Boolean(exp.is_current) ||
          parsedRange.isCurrent ||
          (/^(?:depuis|since)\b/i.test(rawStartDate) && !rawEndDate);

        const startDate =
          formatDate(explicitStartDate) ||
          formatDate(parsedRange.startDate) ||
          rawStartDate ||
          null;
        const endDate = isCurrent
          ? null
          : formatDate(explicitEndDate) ||
            formatDate(parsedRange.endDate) ||
            rawEndDate ||
            null;

        if (!rawTitle && !rawCompany && !description) {
          return null;
        }

        return {
          id: `meta-exp-${index}`,
          jobTitle: rawTitle || "Unknown Role",
          companyName: rawCompany || "Unknown Company",
          startDate,
          endDate,
          isCurrent,
          description,
        };
      })
      .filter(Boolean);
  }

  private extractEducationsFromMetadata(rawMeta: any) {
    const structuredEducation = rawMeta?.structured_data?.education;
    const topLevelEducation = rawMeta?.education;
    const rawEducation = [
      ...(Array.isArray(structuredEducation) ? structuredEducation : []),
      ...(Array.isArray(topLevelEducation) ? topLevelEducation : []),
    ];

    if (rawEducation.length === 0) {
      return [];
    }

    return rawEducation
      .map((edu: any, index: number) => {
        if (!edu || typeof edu !== "object") {
          return null;
        }

        const rawEndDate = this.cleanText(
          edu.end_date || edu.graduation_date || edu.date,
        );
        const parsedRange = parseFlexibleDateRange(rawEndDate);
        const normalized = this.normalizeEducationEntry({
          degree: edu.degree,
          fieldOfStudy:
            edu.field_of_study ||
            edu.fieldOfStudy ||
            edu.major ||
            edu.specialization ||
            null,
          institution: edu.institution || edu.school || edu.establishment,
          endDate:
            normalizeFlexibleDate(rawEndDate, "end") ||
            parsedRange.endDate ||
            parsedRange.startDate,
        });

        if (!normalized) {
          return null;
        }

        return {
          id: `meta-edu-${index}`,
          degree: normalized.degree,
          fieldOfStudy: normalized.fieldOfStudy,
          institution: normalized.institution,
          endDate: this.formatMetadataDate(normalized.endDate, rawEndDate),
        };
      })
      .filter(Boolean);
  }

  async saveEmployeeCv(userId: string, file: Express.Multer.File) {
    let updatedUser = null;

    await this.fileValidationService.validate(file, "cv");

    // 1. Parse CV FIRST to get the name
    try {
      const formData = new FormData();
      formData.append("user_id", userId);
      const blob = new Blob([file.buffer as any], { type: file.mimetype });
      formData.append("file", blob, file.originalname);

      const aiUrl = `${this.aiServiceBaseUrl}/api/v1/parsing/cv`;
      const aiResponse = await fetch(aiUrl, {
        method: "POST",
        body: formData,
      });

      if (aiResponse.ok) {
        const parsingResult = this.normalizeParsedPayload(
          await aiResponse.json(),
        );
        this.logger.log(`AI parsing successful for user ${userId}`);

        // 2. Update user names in DB BEFORE creating folder
        await this.updateUserNames(userId, parsingResult);

        // Fetch the updated user
        updatedUser = await this.userRepository.findOne({
          where: { user_id: userId },
        });

        // 3. NOW save the file (folder will use updated name from DB)
        const storageResult = await this.fileStorageService.saveEmployeeFile(
          userId,
          file,
          "CV",
        );

        // 4. Save the full parsed data to metadata.json
        await this.fileStorageService.saveMetadata(userId, parsingResult);

        // 5. Process and store structured data in database
        const processingResult = await this.processCvData(
          userId,
          parsingResult,
        );

        // 6. Keep metadata summary aligned with computed profile experience.
        await this.fileStorageService.updateExperienceYearsInMetadata(
          userId,
          processingResult.totalExperienceYears,
        );

        return {
          ...storageResult,
          user: updatedUser,
        };
      } else {
        this.logger.error(
          `AI parsing failed (${aiResponse.status}) for ${aiUrl}: ${aiResponse.statusText}`,
        );
        throw new Error("AI parsing failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error && typeof error === "object" && "cause" in error
          ? String((error as { cause?: unknown }).cause)
          : undefined;
      this.logger.error(
        `Error during AI parsing orchestration (base URL: ${this.aiServiceBaseUrl}): ${message}${cause ? ` | cause: ${cause}` : ""}`,
      );
      throw error;
    }
  }

  /**
   * Update user's firstName and lastName from parsed CV data
   */
  private async updateUserNames(userId: string, data: any) {
    const user = await this.userRepository.findOne({
      where: { user_id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    let updated = false;
    if (data.structured_data?.first_name) {
      user.firstName = this.cleanText(data.structured_data.first_name);
      updated = true;
    }
    if (data.structured_data?.last_name) {
      user.lastName = this.cleanText(data.structured_data.last_name);
      updated = true;
    }

    if (updated) {
      await this.userRepository.save(user);
      this.logger.log(
        `Updated user ${userId} names: ${user.firstName} ${user.lastName}`,
      );
    }
  }

  /**
   * Your Logic: Advanced CV data parsing into database
   */
  async processCvData(userId: string, data: any) {
    this.logger.log(`Processing CV data for user ${userId}`);
    const normalizedData = this.normalizeParsedPayload(data);

    // 1. Find User
    const user = await this.userRepository.findOne({
      where: { user_id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    // 2. Find or Create Profile
    let profile = await this.profileRepository.findOne({
      where: { user: { user_id: userId } },
      relations: ["workExperiences", "educations", "certifications"],
    });

    if (!profile) {
      this.logger.log(`Creating new profile for user ${userId}`);
      profile = this.profileRepository.create({
        user: user,
      });
      profile = await this.profileRepository.save(profile);
    }

    // 3. Save Metadata Snapshot
    await this.metadataRepository
      .createQueryBuilder()
      .update(MetadataSnapshot)
      .set({ isCurrent: false })
      .where("profile_id = :profileId", { profileId: profile.profile_id })
      .andWhere("is_current = true")
      .execute();

    const snapshot = this.metadataRepository.create({
      profile: profile,
      metadataJson: normalizedData,
      isCurrent: true,
    });
    await this.metadataRepository.save(snapshot);

    // 3b. Persist parsed contact details + summary on the profile so the DB is
    // the source of truth (metadata.json is only a fallback). Only overwrite
    // when the parse actually found a value, so a re-upload that misses one of
    // these does not wipe a value the employee previously corrected.
    const parsedStructured = normalizedData.structured_data ?? {};
    const parsedPhone = this.cleanText(parsedStructured.phone);
    const parsedAddress = this.stripAtFirstSectionMarker(
      this.cleanText(parsedStructured.address),
    );
    const parsedSummary = this.cleanText(parsedStructured.summary);
    if (parsedPhone) profile.phone = parsedPhone;
    if (parsedAddress) profile.address = parsedAddress;
    if (parsedSummary) profile.professionalSummary = parsedSummary;
    if (parsedPhone || parsedAddress || parsedSummary) {
      await this.profileRepository.save(profile);
    }

    // 4. Populate Work Experience
    if (normalizedData.structured_data?.experience) {
      await this.experienceRepository.delete({
        profile: { profile_id: profile.profile_id },
      });

      const experiences = normalizedData.structured_data.experience
        .map((exp: any) => {
          const newExp = new WorkExperience();
          const rawRange =
            exp.date_range || exp.period || exp.date || exp.start_date || "";
          const parsedRange = parseFlexibleDateRange(rawRange);
          const explicitStart = normalizeFlexibleDate(exp.start_date, "start");
          const explicitEnd = normalizeFlexibleDate(exp.end_date, "end");

          newExp.profile = profile;
          newExp.jobTitle = this.cleanText(exp.title) || "Unknown Role";
          newExp.companyName = this.cleanText(exp.company) || "Unknown Company";
          newExp.startDate = parsedRange.startDate || explicitStart;
          newExp.endDate = explicitEnd || parsedRange.endDate;
          newExp.isCurrent = Boolean(exp.is_current) || parsedRange.isCurrent;
          newExp.description = this.cleanText(exp.description);
          return newExp;
        })
        .filter((exp: WorkExperience) =>
          Boolean(exp.jobTitle || exp.companyName),
        );

      this.applyLatestNextStepAsCurrent(experiences);
      await this.experienceRepository.save(experiences);

      profile.totalExperienceYears =
        this.calculateTotalExperienceYears(experiences);
      await this.profileRepository.save(profile);
    }

    // 5. Populate Education
    if (normalizedData.structured_data?.education) {
      await this.educationRepository.delete({
        profile: { profile_id: profile.profile_id },
      });

      const educations = normalizedData.structured_data.education
        .map((edu: any) => {
          const rawEducationDate =
            edu.end_date || edu.graduation_date || edu.date || "";
          const parsedEducationRange = parseFlexibleDateRange(rawEducationDate);
          const normalized = this.normalizeEducationEntry({
            degree: edu.degree,
            fieldOfStudy:
              edu.field_of_study || edu.major || edu.specialization || null,
            institution: edu.institution,
            endDate:
              parsedEducationRange.endDate ||
              normalizeFlexibleDate(rawEducationDate, "end") ||
              parsedEducationRange.startDate,
          });

          if (!normalized) {
            return null;
          }

          const newEdu = new Education();
          newEdu.profile = profile;
          newEdu.degree = normalized.degree;
          newEdu.fieldOfStudy = normalized.fieldOfStudy;
          newEdu.institution = normalized.institution || null;
          newEdu.endDate = normalized.endDate || null;
          return newEdu;
        })
        .filter(Boolean) as Education[];
      if (educations.length > 0) {
        await this.educationRepository.save(educations);
      }
    }

    // 6. Populate Certifications
    await this.certificationRepository
      .createQueryBuilder()
      .delete()
      .from(Certification)
      .where("profile_id = :profileId", { profileId: profile.profile_id })
      .andWhere("is_uploaded = false")
      .execute();

    const normalizeCertName = (value: string) =>
      this.cleanText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();

    const uploadedCerts = await this.certificationRepository.find({
      where: { profile: { profile_id: profile.profile_id }, isUploaded: true },
    });
    const uploadedNames = new Set(
      uploadedCerts.map((cert) =>
        normalizeCertName(cert.certificationName || ""),
      ),
    );

    if (Array.isArray(normalizedData.structured_data?.certifications)) {
      const certifications = normalizedData.structured_data.certifications
        .map((cert: any) => {
          const name = this.normalizeCertificationName(
            cert?.name || "Unknown Certification",
          );
          if (!this.isUsableCertificationName(name)) {
            return null;
          }
          if (uploadedNames.has(normalizeCertName(name))) {
            return null;
          }
          const newCert = new Certification();
          newCert.profile = profile;
          newCert.certificationName = name;
          newCert.issuingOrganization =
            this.cleanText(cert.issuer || cert.issuing_organization) || null;
          newCert.issueDate = normalizeFlexibleDate(
            cert.date_obtained || cert.issue_date || cert.issueDate,
            "start",
          );
          newCert.expirationDate = normalizeFlexibleDate(
            cert.expiration_date || cert.expiry_date || cert.expirationDate,
            "end",
          );
          newCert.isUploaded = false;
          return newCert;
        })
        .filter(Boolean) as Certification[];

      if (certifications.length > 0) {
        await this.certificationRepository.save(certifications);
      }
    }

    // 7. Populate Projects
    if (normalizedData.structured_data?.projects) {
      await this.participantRepository.delete({
        profile: { profile_id: profile.profile_id },
      });

      const processedProjectIds = new Set<string>();

      for (const projectData of normalizedData.structured_data.projects) {
        const projectName =
          this.cleanText(projectData.name) || "Unknown Project";
        const rawClientName = this.cleanText(projectData.client);
        const projectDesc = this.normalizeProjectDescription(
          projectData.description,
          rawClientName,
        );
        const clientName = this.normalizeProjectClientName(rawClientName);

        if (
          projectName.toLowerCase() === "unknown project" &&
          !projectDesc &&
          !clientName
        ) {
          continue;
        }

        let project = await this.projectRepository.findOne({
          where: {
            projectName: projectName,
            projectDescription: projectDesc,
            clientName: clientName,
          },
        });

        if (!project) {
          project = this.projectRepository.create({
            projectName: projectName,
            projectDescription: projectDesc,
            clientName: clientName,
          });
        }

        // Parse and store project dates
        const rawDate = projectData.date || projectData.dates || null;
        if (rawDate) {
          const dateRange = parseFlexibleDateRange(rawDate);
          if (dateRange.startDate) project.startDate = dateRange.startDate;
          if (dateRange.endDate) project.endDate = dateRange.endDate;
        }

        project = await this.projectRepository.save(project);

        if (processedProjectIds.has(project.project_id)) {
          continue;
        }

        // Do not block CV upload on AI title generation.
        // Title backfill runs asynchronously here (and also via cron).
        if (
          project.projectName?.toLowerCase() === "unknown project" &&
          !project.generatedTitle &&
          projectDesc
        ) {
          void this.aiGenerationService
            .generateAndStoreTitle(project)
            .catch((err) => {
              this.logger.warn(
                `Failed to generate title for project ${project.project_id}: ${err?.message ?? err}`,
              );
            });
        }

        const participant = this.participantRepository.create({
          profile: profile,
          project: project,
          description: projectDesc,
          role: this.normalizeProjectRole(projectData.role) || "contributor",
        });
        await this.participantRepository.save(participant);
        processedProjectIds.add(project.project_id);
      }
    }

    // 8. Trigger RAG Sync
    await this.ragService.triggerUserSync(userId);

    return {
      message: "CV processed successfully",
      profileId: profile.profile_id,
      totalExperienceYears: profile.totalExperienceYears ?? null,
    };
  }

  private normalizeParsedPayload(data: any): any {
    const source = data && typeof data === "object" ? { ...data } : {};
    const structuredSource =
      source.structured_data && typeof source.structured_data === "object"
        ? { ...source.structured_data }
        : {};

    structuredSource.first_name = this.cleanText(structuredSource.first_name);
    structuredSource.last_name = this.cleanText(structuredSource.last_name);
    structuredSource.email = this.cleanText(structuredSource.email);
    structuredSource.phone = this.cleanText(structuredSource.phone);
    structuredSource.address = this.stripAtFirstSectionMarker(
      this.cleanText(structuredSource.address),
    );

    const experiencesRaw = this.pickFirstArray(
      structuredSource.experience,
      source.experience,
      structuredSource.experiences,
      source.experiences,
      structuredSource.work_experience,
      source.work_experience,
    );
    structuredSource.experience = experiencesRaw
      .map((exp: any) => ({
        ...exp,
        start_date: this.cleanText(
          exp?.start_date || exp?.period || exp?.date_range || exp?.date,
        ),
        end_date: this.cleanText(exp?.end_date),
        company: this.cleanText(exp?.company),
        title: this.cleanText(exp?.title),
        description: this.cleanText(exp?.description),
      }))
      .filter((exp: any) => exp.company || exp.title || exp.description);

    const certificationsRaw = this.pickFirstArray(
      structuredSource.certifications,
      source.certifications,
      structuredSource.certification,
      source.certification,
      structuredSource.certifs,
      source.certifs,
    );
    const normalizedCerts = this.normalizeCertificationRows(certificationsRaw);

    const certByKey = new Map<
      string,
      { name: string; date_obtained?: string }
    >();
    for (const cert of normalizedCerts) {
      const key = this.normalizeCertKey(cert.name);
      if (!key) {
        continue;
      }
      const existing = certByKey.get(key);
      if (!existing) {
        certByKey.set(key, { ...cert });
        continue;
      }
      if (!existing.date_obtained && cert.date_obtained) {
        existing.date_obtained = cert.date_obtained;
      }
    }

    const cleanedCertifications = Array.from(certByKey.values());
    structuredSource.certifications = cleanedCertifications;
    source.certifications = cleanedCertifications.map((cert) => ({
      name: cert.name,
      date_obtained: cert.date_obtained || "",
      is_uploaded: false,
    }));

    const educationNarratives: string[] = [];
    const educationRaw = this.pickFirstArray(
      structuredSource.education,
      source.education,
      structuredSource.formations,
      source.formations,
      structuredSource.academic_education,
      source.academic_education,
      structuredSource.formation_academique,
      source.formation_academique,
    );
    structuredSource.education = educationRaw
      .map((edu: any) => {
        const rawEndDate = this.cleanText(
          edu?.end_date || edu?.graduation_date || edu?.date,
        );
        const normalized = this.normalizeEducationEntry({
          degree: edu?.degree,
          fieldOfStudy:
            edu?.field_of_study || edu?.major || edu?.specialization || null,
          institution: edu?.institution,
          endDate:
            normalizeFlexibleDate(rawEndDate, "end") ||
            parseFlexibleDateRange(rawEndDate).endDate ||
            parseFlexibleDateRange(rawEndDate).startDate,
        });

        if (!normalized) {
          const noisyInstitution = this.cleanText(edu?.institution);
          if (noisyInstitution) {
            educationNarratives.push(noisyInstitution);
          }
          return null;
        }

        const normalizedEducation: Record<string, string> = {
          degree: normalized.degree,
          institution: normalized.institution || "",
          end_date: this.formatMetadataDate(normalized.endDate, rawEndDate),
        };
        if (normalized.fieldOfStudy) {
          normalizedEducation.field_of_study = normalized.fieldOfStudy;
        }
        return normalizedEducation;
      })
      .filter(Boolean);

    const projectsRaw = this.pickFirstArray(
      structuredSource.projects,
      source.projects,
      structuredSource.project_experience,
      source.project_experience,
      structuredSource.realisations,
      source.realisations,
    );
    const normalizedProjects = projectsRaw
      .map((project: any) => {
        const name = this.cleanText(project?.name);
        const date = this.cleanText(project?.date || project?.dates);
        const rawClient = this.cleanText(project?.client);
        const description = this.normalizeProjectDescription(
          project?.description,
          rawClient,
        );
        const client = this.normalizeProjectClientName(rawClient) || "";

        if (
          (name || "Unknown Project").toLowerCase() === "unknown project" &&
          !description &&
          !client
        ) {
          return null;
        }

        return {
          name: name || "Unknown Project",
          date,
          client,
          description,
        };
      })
      .filter(Boolean) as Array<{
      name: string;
      date: string;
      client: string;
      description: string;
    }>;

    if (educationNarratives.length > 0) {
      const narrative = this.cleanText(educationNarratives.join(" "));
      if (narrative) {
        if (normalizedProjects.length > 0) {
          normalizedProjects[0].description = this.normalizeProjectDescription(
            normalizedProjects[0].description,
            narrative,
          );
        } else {
          normalizedProjects.push({
            name: "Unknown Project",
            date: "",
            client: "",
            description: this.normalizeProjectDescription("", narrative),
          });
        }
      }
    }
    structuredSource.projects = normalizedProjects;

    const skillsRaw = this.pickFirstArray(
      structuredSource.skills,
      source.skills,
      structuredSource.technical_skills,
      source.technical_skills,
      structuredSource.competences,
      source.competences,
    );
    structuredSource.skills = Array.from(
      new Set(
        skillsRaw.map((skill: any) => this.cleanText(skill)).filter(Boolean),
      ),
    );
    source.skills = structuredSource.skills;

    source.structured_data = structuredSource;
    return source;
  }

  private normalizeCompanyName(value: string): string {
    return this.cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  private cleanText(value: unknown): string {
    if (value == null) {
      return "";
    }

    const raw = String(value);
    const normalizedEncoding = this.fixMojibake(raw);
    return normalizedEncoding
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private pickFirstArray(...candidates: unknown[]): any[] {
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
    return [];
  }

  private fixMojibake(value: string): string {
    const input = value || "";
    if (!/(?:Ã.|Â|â[\u0080-\u00BF]{1,3}|ï¿½)/.test(input)) {
      return input;
    }

    try {
      const decoded = Buffer.from(input, "latin1").toString("utf8");
      if (!decoded) {
        return input;
      }
      return this.encodingNoiseScore(decoded) < this.encodingNoiseScore(input)
        ? decoded
        : input;
    } catch {
      return input;
    }
  }

  private encodingNoiseScore(value: string): number {
    return (value.match(/(?:Ã.|Â|â[\u0080-\u00BF]{1,3}|ï¿½)/g) || []).length;
  }

  private stripAtFirstSectionMarker(
    value: string,
    keepLeadingMarker: boolean = false,
  ): string {
    const text = this.cleanText(value);
    if (!text) {
      return "";
    }

    const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const marker = folded.match(
      /\b(?:experience|formation|certif|certification|competence|competences|skills?|education|projects?|projets?)\b/i,
    );
    if (!marker || marker.index == null) {
      return text.trim();
    }
    if (keepLeadingMarker && marker.index === 0) {
      return text.trim();
    }

    return text.slice(0, marker.index).trim();
  }

  private normalizeCertificationName(value: unknown): string {
    let text = this.cleanText(value);
    if (!text) {
      return "";
    }

    text = text.replace(/^date\s*d['’]?\s*obtention\s*[:\-]?\s*/i, "");
    text = text.replace(/^date\s*obtention\s*[:\-]?\s*/i, "");
    text = text.replace(/^certifications?\s*[:\-]?\s*/i, "");
    return text.trim();
  }

  private isUsableCertificationName(value: string): boolean {
    const text = this.cleanText(value);
    if (!text) {
      return false;
    }
    if (!/[A-Za-z\u00C0-\u024F]/.test(text)) {
      return false;
    }

    const compact = text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\./g, "")
      .trim()
      .toLowerCase();
    if (
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}$/.test(
        compact,
      ) ||
      /^(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)$/.test(
        compact,
      ) ||
      /^(janv|fev|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)\s+\d{1,2}$/.test(
        compact,
      )
    ) {
      return false;
    }

    return true;
  }

  private isCertificationDateLabel(value: string): boolean {
    const text = this.cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\./g, "")
      .trim()
      .toLowerCase();
    if (!text) {
      return false;
    }

    return (
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(,\s*\d{4})?$/.test(
        text,
      ) ||
      /^(janv|fev|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)\s+\d{1,2}(,\s*\d{4})?$/.test(
        text,
      ) ||
      /^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(\s+\d{4})?$/.test(
        text,
      )
    );
  }

  private mergeCertificationDate(dateLabel: string, dateHint: string): string {
    const label = this.cleanText(dateLabel);
    const hint = this.cleanText(dateHint);
    if (!label) {
      return hint;
    }
    if (/\d{4}/.test(label)) {
      return label;
    }

    const yearMatch = hint.match(/(19|20)\d{2}/);
    if (yearMatch) {
      return `${label}, ${yearMatch[0]}`;
    }

    return label;
  }

  private normalizeCertificationRows(
    certificationsRaw: any[],
  ): Array<{ name: string; date_obtained?: string }> {
    const tokens: Array<{
      name: string;
      dateHint: string;
      leadingDay: string | null;
      fromSplitTail: boolean;
      dateHintConsumedByPrevious?: boolean;
    }> = [];

    for (const cert of certificationsRaw ?? []) {
      const rawName = this.cleanText(
        typeof cert === "string"
          ? cert
          : cert?.name ||
              cert?.certification_name ||
              cert?.title ||
              cert?.certification ||
              cert?.label ||
              "",
      );
      const rawDate = this.cleanText(
        typeof cert === "string"
          ? ""
          : cert?.date_obtained ||
              cert?.issue_date ||
              cert?.issueDate ||
              cert?.date ||
              cert?.obtained_on ||
              "",
      );

      let name = this.normalizeCertificationName(rawName);
      let dateHint = rawDate;

      if (
        this.isCertificationDateLabel(name) &&
        this.isUsableCertificationName(dateHint)
      ) {
        const swappedName = this.normalizeCertificationName(dateHint);
        if (swappedName) {
          dateHint = name;
          name = swappedName;
        }
      }

      if (!name) {
        continue;
      }

      const split = this.splitEmbeddedCertificationNames(name);
      if (split) {
        tokens.push({
          name: split.first,
          dateHint,
          leadingDay: split.dayForFirst,
          fromSplitTail: false,
        });
        tokens.push({
          name: split.second,
          dateHint: "",
          leadingDay: null,
          fromSplitTail: true,
        });
        continue;
      }

      const leadingDayMatch = name.match(/^(\d{1,2})\s*\/\s*(.+)$/);
      if (leadingDayMatch) {
        const remainder = this.normalizeCertificationName(leadingDayMatch[2]);
        if (remainder) {
          tokens.push({
            name: remainder,
            dateHint,
            leadingDay: leadingDayMatch[1].padStart(2, "0"),
            fromSplitTail: false,
          });
          continue;
        }
      }

      tokens.push({
        name,
        dateHint,
        leadingDay: null,
        fromSplitTail: false,
      });
    }

    const normalized: Array<{ name: string; date_obtained?: string }> = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const name = this.normalizeCertificationName(token.name);
      if (!this.isUsableCertificationName(name)) {
        continue;
      }

      let dateHint = this.cleanText(token.dateHint);
      let day = token.leadingDay;

      // When one row leaks into the next cert name, recover date/day from the next row.
      if (token.fromSplitTail) {
        const next = tokens[i + 1];
        if (next) {
          const nextDateHint = this.cleanText(next.dateHint);
          if (!dateHint && nextDateHint) {
            dateHint = nextDateHint;
          }
          if (!day && next.leadingDay) {
            day = next.leadingDay;
            next.leadingDay = null;
          }
        }
      }

      // Handle shifted days like "... 23/ CyberOps" where day belongs to previous cert.
      if (!day && dateHint) {
        const next = tokens[i + 1];
        if (
          next?.leadingDay &&
          this.sameMonthYearHint(dateHint, next.dateHint)
        ) {
          day = next.leadingDay;
          next.leadingDay = null;
          next.dateHintConsumedByPrevious = true;
        }
      }

      let dateObtained = dateHint;
      if (day) {
        dateObtained = this.mergeDayWithDateHint(day, dateHint);
      }
      if (
        token.dateHintConsumedByPrevious &&
        !token.leadingDay &&
        this.hasMonthYearHint(dateHint)
      ) {
        dateObtained = "";
      }

      if (dateObtained) {
        normalized.push({ name, date_obtained: dateObtained });
      } else {
        normalized.push({ name });
      }
    }

    return normalized;
  }

  private splitEmbeddedCertificationNames(
    value: string,
  ): { first: string; second: string; dayForFirst: string } | null {
    const text = this.cleanText(value);
    if (!text) {
      return null;
    }

    const match = text.match(
      /^(.+?)(\d{1,2})\s*\/\s*([A-Za-z\u00C0-\u024F].+)$/,
    );
    if (!match) {
      return null;
    }

    const first = this.normalizeCertificationName(match[1]);
    const second = this.normalizeCertificationName(match[3]);
    if (
      !this.isUsableCertificationName(first) ||
      !this.isUsableCertificationName(second)
    ) {
      return null;
    }

    return {
      first,
      second,
      dayForFirst: match[2].padStart(2, "0"),
    };
  }

  private hasFullCertificationDate(value: string): boolean {
    const text = this.cleanText(value).replace(/\s+/g, "");
    if (!text) {
      return false;
    }

    return (
      /^\d{1,2}[\/-]\d{1,2}[\/-](19|20)\d{2}$/.test(text) ||
      /^(19|20)\d{2}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(text)
    );
  }

  private hasMonthYearHint(value: string): boolean {
    const text = this.cleanText(value).replace(/\s+/g, "");
    if (!text) {
      return false;
    }

    return /^(\d{1,2}[\/-](19|20)\d{2}|(19|20)\d{2}[\/-]\d{1,2})$/.test(text);
  }

  private sameMonthYearHint(left: string, right: string): boolean {
    if (!this.hasMonthYearHint(left) || !this.hasMonthYearHint(right)) {
      return false;
    }

    const leftDate = normalizeFlexibleDate(left, "start");
    const rightDate = normalizeFlexibleDate(right, "start");
    if (!leftDate || !rightDate) {
      return false;
    }

    return (
      leftDate.getUTCFullYear() === rightDate.getUTCFullYear() &&
      leftDate.getUTCMonth() === rightDate.getUTCMonth()
    );
  }

  private mergeDayWithDateHint(day: string, dateHint: string): string {
    const cleanDay = this.cleanText(day)
      .match(/\d{1,2}/)?.[0]
      ?.padStart(2, "0");
    const hint = this.cleanText(dateHint);

    if (!hint) {
      return "";
    }
    if (!cleanDay) {
      return hint;
    }
    if (this.hasFullCertificationDate(hint)) {
      return hint;
    }

    const monthYear = hint.match(/^(\d{1,2})[\/-](\d{4})$/);
    if (monthYear) {
      return `${cleanDay}/${monthYear[1].padStart(2, "0")}/${monthYear[2]}`;
    }

    const yearMonth = hint.match(/^(\d{4})[\/-](\d{1,2})$/);
    if (yearMonth) {
      return `${cleanDay}/${yearMonth[2].padStart(2, "0")}/${yearMonth[1]}`;
    }

    const textualMonthYear = hint.match(/^([A-Za-z\u00C0-\u024F]+)\s+(\d{4})$/);
    if (textualMonthYear) {
      return `${cleanDay} ${textualMonthYear[1]} ${textualMonthYear[2]}`;
    }

    return this.mergeCertificationDate(cleanDay, hint);
  }

  private formatMetadataDate(value: Date | null, rawValue: string): string {
    const raw = this.cleanText(rawValue);
    if (raw && /^(19|20)\d{2}$/.test(raw)) {
      return raw;
    }
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value.toISOString().split("T")[0];
    }
    return raw;
  }

  private normalizeCertKey(value: string): string {
    return this.cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  private normalizeProjectClientName(value: unknown): string | null {
    const text = this.cleanText(value);
    if (!text) {
      return null;
    }

    if (this.isNarrativeProjectText(text)) {
      return null;
    }

    return text;
  }

  private normalizeProjectDescription(
    description: unknown,
    maybeNarrativeClient?: unknown,
  ): string {
    const descriptionText = this.cleanText(description);
    const clientText = this.cleanText(maybeNarrativeClient);
    const clauses: string[] = [];

    if (clientText && this.isNarrativeProjectText(clientText)) {
      clauses.push(...this.splitProjectNarrativeIntoClauses(clientText));
    }
    if (descriptionText) {
      clauses.push(...this.splitProjectNarrativeIntoClauses(descriptionText));
    }

    if (clauses.length === 0) {
      return "";
    }

    const merged: string[] = [];
    for (const chunk of clauses) {
      const cleanedChunk = this.cleanText(chunk);
      if (!cleanedChunk) {
        continue;
      }

      if (merged.length > 0 && /^[a-z]/.test(cleanedChunk)) {
        let targetIndex = merged.length - 1;
        if (/^des\s+proc/i.test(cleanedChunk)) {
          const suivantsIndex = merged.findIndex((value) =>
            /suivants?\.?$/i.test(value.trim()),
          );
          if (suivantsIndex >= 0) {
            targetIndex = suivantsIndex;
          }
        } else if (/^fonctionnement du/i.test(cleanedChunk)) {
          const leBonIndex = merged.findIndex((value) =>
            /\ble bon\b/i.test(value),
          );
          if (leBonIndex >= 0) {
            targetIndex = leBonIndex;
          }
        }

        if (
          /^fonctionnement du/i.test(cleanedChunk) &&
          /\ble bon\s+Maintenance informatique\b/i.test(merged[targetIndex])
        ) {
          const clause = cleanedChunk.replace(/[.!?]+$/, "");
          merged[targetIndex] = merged[targetIndex].replace(
            /\ble bon\s+Maintenance informatique\b/i,
            `le bon ${clause} et la maintenance informatique`,
          );
          continue;
        }

        const previous = merged[targetIndex].replace(/[.!?]+$/, "");
        merged[targetIndex] = `${previous} ${cleanedChunk}`;
      } else {
        merged.push(cleanedChunk);
      }
    }

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const sentence of merged) {
      const normalizedSentence = sentence
        .replace(
          /\ble bon\s+Maintenance informatique\b/gi,
          "le bon fonctionnement du réseau et la maintenance informatique",
        )
        .replace(
          /\bfonctionnement du r[ée]seaux\b/gi,
          "fonctionnement du réseau",
        )
        .replace(/\bconseils technique\b/gi, "conseils techniques")
        .trim();

      if (!normalizedSentence) {
        continue;
      }

      const key = normalizedSentence
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();

      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      unique.push(
        /[.!?]$/.test(normalizedSentence)
          ? normalizedSentence
          : `${normalizedSentence}.`,
      );
    }

    return unique.join(" ").trim();
  }

  private splitProjectNarrativeIntoClauses(value: string): string[] {
    if (!value) {
      return [];
    }

    let text = this.cleanText(value);
    text = text
      .replace(/\.\.+/g, ".")
      .replace(/\s*;\s*/g, ". ")
      .replace(/\s{2,}/g, " ")
      .replace(
        /\b(Effectuer|Assister|Participer|Analyser|Analyse|Reporting|C[âa]blage|Configuration)\b/g,
        "||$1",
      )
      .trim();

    return text
      .split("||")
      .flatMap((part) => part.split(/(?<=[.!?])\s+/))
      .map((chunk) => this.cleanText(chunk.replace(/^[•\-–]\s*/, "")))
      .filter(Boolean);
  }

  private isNarrativeProjectText(value: string): boolean {
    const text = this.cleanText(value);
    if (!text) {
      return false;
    }

    const words = text.split(/\s+/).filter(Boolean);
    return (
      words.length > 8 ||
      /[.!?]/.test(text) ||
      /^(participer|effectuer|assister|analyse|analyser|maintenance|reporting|configuration|cablage|fonctionnement|mise)/i.test(
        text,
      )
    );
  }

  private normalizeProjectRole(value: unknown): string | null {
    const text = this.cleanText(value);
    if (!text) {
      return null;
    }

    const normalized = text.toLowerCase();

    if (
      normalized === "project_lead" ||
      /(?:\bproject\b.*\blead\b|\blead\b.*\bproject\b|\bchef(?:fe)?\s+de\s+projet\b)/i.test(
        normalized,
      )
    ) {
      return "project_lead";
    }

    if (
      normalized === "technical_lead" ||
      /(?:\btech(?:nical|nique)?\b.*\blead\b|\blead\b.*\btech(?:nical|nique)?\b|\bchef(?:fe)?\s+de\s+projet\s+tech(?:nique)?\b)/i.test(
        normalized,
      )
    ) {
      return "technical_lead";
    }

    if (
      normalized === "contributor" ||
      normalized === "contributeur" ||
      normalized.includes("contributor") ||
      normalized.includes("contributeur")
    ) {
      return "contributor";
    }

    // The role column is an enum in production, so unknown free-text roles
    // must gracefully fall back to a valid enum value.
    if (text.split(/\s+/).length > 6 && /[.!?]/.test(text)) {
      return null;
    }

    return "contributor";
  }

  private normalizeEducationEntry(input: {
    degree?: unknown;
    fieldOfStudy?: unknown;
    institution?: unknown;
    endDate?: Date | null;
  }): {
    degree: string;
    fieldOfStudy: string | null;
    institution: string | null;
    endDate: Date | null;
  } | null {
    const degreeRaw = this.cleanText(input.degree);
    const fieldRaw = this.cleanText(input.fieldOfStudy);
    const institutionRaw = this.cleanText(input.institution);

    const degree =
      this.stripAtFirstSectionMarker(degreeRaw, true) || "Unknown Degree";
    const fieldOfStudy = this.stripAtFirstSectionMarker(fieldRaw, true) || null;
    const institution =
      this.stripAtFirstSectionMarker(institutionRaw, true) || null;

    const degreeUnknown = /^unknown degree$/i.test(degree);
    const institutionLooksNarrative =
      !!institution &&
      (institution.length > 180 ||
        (institution.split(/\s+/).length > 18 &&
          /(?:incident|maintenance|sur site|distance|reporting|analyse|diagnostique|r[ée]seaux)/i.test(
            institution,
          )));

    if (
      (degreeUnknown && !institution) ||
      (degreeUnknown && institutionLooksNarrative)
    ) {
      return null;
    }

    return {
      degree,
      fieldOfStudy,
      institution,
      endDate: input.endDate || null,
    };
  }

  private isNextStepCompany(value: string): boolean {
    const normalized = this.normalizeCompanyName(value);
    const compact = normalized.replace(/\s+/g, "");
    return CvService.NEXT_STEP_COMPANY_KEYS.has(compact);
  }

  private applyLatestNextStepAsCurrent(experiences: WorkExperience[]) {
    if (!experiences?.length) {
      return;
    }

    const now = new Date();
    let latestIndex = -1;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < experiences.length; i += 1) {
      const exp = experiences[i];
      const referenceDate =
        exp.endDate || exp.startDate || (exp.isCurrent ? now : null);
      if (!referenceDate) {
        continue;
      }
      const ts = referenceDate.getTime();
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestIndex = i;
      }
    }

    if (latestIndex < 0) {
      return;
    }

    const latestExp = experiences[latestIndex];
    if (this.isNextStepCompany(latestExp.companyName || "")) {
      latestExp.isCurrent = true;
      latestExp.endDate = null;
    }
  }

  /**
   * Self-service CV editing: lets an employee correct parsing errors in their
   * own previewed CV. Every method here is scoped to the calling user via
   * profile.user.user_id, mirroring the ownership pattern used in
   * ProjectsService.updateParticipation.
   */
  private async getOwnProfileOrThrow(userId: string): Promise<EmployeeProfile> {
    const profile = await this.profileRepository.findOne({
      where: { user: { user_id: userId } },
    });
    if (!profile) {
      throw new NotFoundException("Employee profile not found");
    }
    return profile;
  }

  async updateProfileBasics(userId: string, dto: UpdateProfileBasicsDto) {
    const profile = await this.getOwnProfileOrThrow(userId);

    if (dto.currentPosition !== undefined) {
      profile.currentPosition = dto.currentPosition.trim();
    }
    if (dto.professionalSummary !== undefined) {
      profile.professionalSummary = dto.professionalSummary.trim();
    }
    if (dto.totalExperienceYears !== undefined) {
      profile.totalExperienceYears = dto.totalExperienceYears;
    }
    if (dto.phone !== undefined) {
      profile.phone = this.cleanText(dto.phone) || null;
    }
    if (dto.address !== undefined) {
      profile.address = this.cleanText(dto.address) || null;
    }

    await this.profileRepository.save(profile);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async createWorkExperience(userId: string, dto: CreateWorkExperienceDto) {
    const profile = await this.getOwnProfileOrThrow(userId);
    const isCurrent = Boolean(dto.isCurrent);

    const experience = this.experienceRepository.create({
      profile,
      jobTitle: dto.jobTitle.trim(),
      companyName: dto.companyName.trim(),
      startDate: dto.startDate
        ? normalizeFlexibleDate(dto.startDate, "start")
        : null,
      endDate:
        isCurrent || !dto.endDate
          ? null
          : normalizeFlexibleDate(dto.endDate, "end"),
      isCurrent,
      description: dto.description?.trim() || "",
    });

    await this.experienceRepository.save(experience);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async updateWorkExperience(
    userId: string,
    experienceId: string,
    dto: UpdateWorkExperienceDto,
  ) {
    const experience = await this.experienceRepository.findOne({
      where: { experience_id: experienceId },
      relations: ["profile", "profile.user"],
    });
    if (!experience || experience.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Work experience not found");
    }

    if (dto.jobTitle !== undefined) experience.jobTitle = dto.jobTitle.trim();
    if (dto.companyName !== undefined)
      experience.companyName = dto.companyName.trim();
    if (dto.isCurrent !== undefined) experience.isCurrent = dto.isCurrent;
    if (dto.startDate !== undefined) {
      experience.startDate = dto.startDate
        ? normalizeFlexibleDate(dto.startDate, "start")
        : null;
    }
    if (dto.endDate !== undefined) {
      experience.endDate = dto.endDate
        ? normalizeFlexibleDate(dto.endDate, "end")
        : null;
    }
    if (experience.isCurrent) experience.endDate = null;
    if (dto.description !== undefined)
      experience.description = dto.description.trim();

    await this.experienceRepository.save(experience);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async deleteWorkExperience(userId: string, experienceId: string) {
    const experience = await this.experienceRepository.findOne({
      where: { experience_id: experienceId },
      relations: ["profile", "profile.user"],
    });
    if (!experience || experience.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Work experience not found");
    }

    await this.experienceRepository.remove(experience);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async createEducation(userId: string, dto: CreateEducationDto) {
    const profile = await this.getOwnProfileOrThrow(userId);

    const education = this.educationRepository.create({
      profile,
      degree: dto.degree.trim(),
      fieldOfStudy: dto.fieldOfStudy?.trim() || null,
      institution: dto.institution?.trim() || null,
      endDate: dto.endDate ? normalizeFlexibleDate(dto.endDate, "end") : null,
    });

    await this.educationRepository.save(education);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async updateEducation(
    userId: string,
    educationId: string,
    dto: UpdateEducationDto,
  ) {
    const education = await this.educationRepository.findOne({
      where: { education_id: educationId },
      relations: ["profile", "profile.user"],
    });
    if (!education || education.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Education entry not found");
    }

    if (dto.degree !== undefined) education.degree = dto.degree.trim();
    if (dto.fieldOfStudy !== undefined)
      education.fieldOfStudy = dto.fieldOfStudy?.trim() || null;
    if (dto.institution !== undefined)
      education.institution = dto.institution?.trim() || null;
    if (dto.endDate !== undefined) {
      education.endDate = dto.endDate
        ? normalizeFlexibleDate(dto.endDate, "end")
        : null;
    }

    await this.educationRepository.save(education);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  async deleteEducation(userId: string, educationId: string) {
    const education = await this.educationRepository.findOne({
      where: { education_id: educationId },
      relations: ["profile", "profile.user"],
    });
    if (!education || education.profile?.user?.user_id !== userId) {
      throw new NotFoundException("Education entry not found");
    }

    await this.educationRepository.remove(education);
    await this.metadataSyncService.syncFromDb(userId);
    await this.ragService.triggerUserSync(userId);
    return this.getMyProfile(userId);
  }

  /**
   * Backfill project dates from stored metadata.json files.
   * Matches projects via the user's project_participants, comparing by
   * normalized client name to handle encoding mismatches between metadata and DB.
   */
  async backfillProjectDates(): Promise<{ updated: number; skipped: number }> {
    const users = await this.userRepository.find();
    let updated = 0;
    let skipped = 0;

    for (const user of users) {
      try {
        const rawMeta = await this.fileStorageService.getRawMetadata(
          user.user_id,
        );
        const metaProjects = rawMeta?.structured_data?.projects;
        if (!metaProjects?.length) continue;

        // Load this user's profile with project participations
        const profile = await this.profileRepository.findOne({
          where: { user: { user_id: user.user_id } },
          relations: ["projectParticipations", "projectParticipations.project"],
        });
        if (!profile?.projectParticipations?.length) continue;

        // For each DB project, try to find a matching metadata entry by client name
        for (const participation of profile.projectParticipations) {
          const project = participation.project;
          if (!project || (project.startDate && project.endDate)) {
            skipped++;
            continue;
          }

          const dbClient = this.normalizeCompanyName(project.clientName || "");

          // Find matching metadata project by normalized client name
          const metaMatch = metaProjects.find((mp: any) => {
            const metaClient = this.normalizeCompanyName(mp.client || "");
            return metaClient && dbClient && metaClient === dbClient;
          });

          if (!metaMatch) {
            skipped++;
            continue;
          }

          const rawDate = metaMatch.date || metaMatch.dates || null;
          if (!rawDate) {
            skipped++;
            continue;
          }

          const dateRange = parseFlexibleDateRange(rawDate);
          if (dateRange.startDate || dateRange.endDate) {
            if (dateRange.startDate) project.startDate = dateRange.startDate;
            if (dateRange.endDate) project.endDate = dateRange.endDate;
            await this.projectRepository.save(project);
            updated++;
            this.logger.log(
              `Backfilled dates for project "${project.projectName}" (client: ${project.clientName}): ${rawDate}`,
            );
          } else {
            skipped++;
          }
        }
      } catch (err) {
        this.logger.warn(
          `Backfill error for user ${user.user_id}: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Backfill complete: ${updated} updated, ${skipped} skipped`,
    );
    return { updated, skipped };
  }
  /**
   * Generate a CV from a template file and employee profile data.
   * Sends the template + employee data to the AI service which replaces
   * personal fields while preserving the original template formatting.
   */
  async generateCv(
    employeeId: string,
    templateFile: Express.Multer.File,
    outputFormat: "docx" | "pdf" = "docx",
    language: "en" | "fr" | "original" | string = "original",
    engine: "primary" | "fallback" = "primary",
    options: { requestingUserId?: string | null; recordHistory?: boolean } = {},
  ): Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    warnings?: string;
  }> {
    // 1. Load employee profile data
    const profileData = await this.getMyProfile(employeeId);

    if (!profileData.name || profileData.name.trim().length < 2) {
      throw new NotFoundException(
        `Employee ${employeeId} has no usable name in their profile. ` +
          "Please ensure the employee has a first and last name set.",
      );
    }

    // 2. Build structured employee payload expected by the AI service (both engines)
    const employeePayload = {
      name: profileData.name,
      title: profileData.currentPosition || "",
      email: profileData.email || "",
      phone: profileData.phone || "",
      address: profileData.address || "",
      summary: profileData.professionalSummary || "",
      skills: profileData.skills || [],
      workExperiences: (profileData.workExperiences || [])
        .filter((exp: any) => exp.jobTitle && exp.companyName)
        .map((exp: any) => ({
          title: exp.jobTitle,
          jobTitle: exp.jobTitle,
          company: exp.companyName,
          companyName: exp.companyName,
          dates: [exp.startDate, exp.isCurrent ? "Present" : exp.endDate]
            .filter(Boolean)
            .join(" - "),
          description: exp.description || "",
        })),
      educations: (profileData.educations || []).map((edu: any) => ({
        degree: edu.degree,
        institution: edu.institution,
        fieldOfStudy: edu.fieldOfStudy || "",
        dates: edu.endDate || "",
      })),
      languages: [],
      certifications: (profileData.certifications || []).map((c: any) => ({
        name: c.name || "",
        issueDate: c.issueDate || "",
        issuingOrganization: c.issuingOrganization || "",
      })),
      projects: (profileData.projects || []).map((p: any) => {
        const rawName = (p.name || "").trim();
        const isUnknown =
          !rawName || rawName.toLowerCase() === "unknown project";
        return {
          name: isUnknown ? p.generatedTitle || "" : rawName,
          description: p.description || "",
          role: p.role || "",
          skills: p.skills || [],
          client: p.client || "",
          startDate: p.startDate || "",
          endDate: p.endDate || "",
        };
      }),
    };

    // 3. Call AI service /generation/cv
    const formData = new FormData();
    const blob = new Blob([templateFile.buffer as any], {
      type: templateFile.mimetype,
    });
    formData.append("template", blob, templateFile.originalname);
    formData.append("employee_data", JSON.stringify(employeePayload));
    formData.append("output_format", outputFormat);
    formData.append("language", language);
    formData.append("engine", engine);

    const aiUrl = `${this.aiServiceBaseUrl}/api/v1/generation/cv`;
    this.logger.log(
      `Calling AI generation service: ${aiUrl} (format: ${outputFormat})`,
    );

    // 300s timeout: local Ollama inference on CPU can take 60-120s per call
    // with up to 3 sequential LLM calls plus LibreOffice PDF conversion.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    let aiResponse: globalThis.Response;
    try {
      aiResponse = await fetch(aiUrl, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(
          "CV generation timed out (180s). The template may be too complex.",
        );
      }
      throw new Error(`AI service unreachable: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text().catch(() => "Unknown error");
      this.logger.error(
        `AI generation failed (${aiResponse.status}): ${errorText}`,
      );
      if (aiResponse.status === 400) {
        throw new Error(`Invalid input: ${errorText}`);
      }
      throw new Error(`CV generation failed: ${errorText}`);
    }

    const arrayBuffer = await aiResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detect actual output format from AI service response headers.
    // The AI service sets X-CV-Format to the actual format returned (which
    // may differ from the requested format when PDF conversion fails and it
    // falls back to DOCX).
    const actualFormat = (
      aiResponse.headers.get("x-cv-format") || outputFormat
    ).toLowerCase();
    const isPdfFailed = aiResponse.headers.get("x-pdf-failed") === "true";
    const effectiveFormat = isPdfFailed ? "docx" : actualFormat;

    // Derive filename from Content-Disposition or build one
    const contentDisposition =
      aiResponse.headers.get("content-disposition") || "";
    const ext = effectiveFormat === "pdf" ? ".pdf" : ".docx";
    let filename = `${profileData.name.replace(/\s+/g, "_")}_CV${ext}`;
    const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
    if (filenameMatch) {
      filename = filenameMatch[1];
    }

    const mimeType =
      effectiveFormat === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    if (isPdfFailed) {
      this.logger.warn(
        `PDF conversion failed in AI service — returning DOCX instead (format requested: ${outputFormat})`,
      );
    }

    // Forward the AI service's warning header (best-effort, opaque JSON) so
    // the controller can surface it back to the client untouched.
    const warnings = aiResponse.headers.get("x-cv-warnings") || undefined;

    // Auto-save the template to the user's history once generation has
    // succeeded (re-uploads of the same bytes bump usage stats instead of
    // duplicating). Best-effort — a save failure must not block the
    // response.
    const shouldRecord = options.recordHistory !== false;
    if (shouldRecord && options.requestingUserId) {
      try {
        await this.cvTemplatesService.recordGenerationUsage({
          userId: options.requestingUserId,
          file: templateFile,
          language,
        });
      } catch (exc) {
        this.logger.warn(
          `Auto-saving template to history failed (non-fatal): ${(exc as Error)?.message || exc}`,
        );
      }
    }

    return { buffer, filename, mimeType, warnings };
  }

  /**
   * Re-generate a CV using a template the bid manager has already used
   * before (i.e. a row from cv-templates owned by them). Avoids the need
   * to re-upload the same file.
   */
  async generateCvFromHistory(
    userId: string,
    templateId: string,
    employeeId: string,
    outputFormat: "docx" | "pdf" = "docx",
    language: "en" | "fr" | "original" | string = "original",
    engine: "primary" | "fallback" = "primary",
  ): Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    warnings?: string;
  }> {
    const template = await this.cvTemplatesService.getOwnedTemplate(
      templateId,
      userId,
    );
    const {
      buffer: fileBuffer,
      mimetype,
      filename,
    } = await this.cvTemplatesService.loadTemplateBuffer(template);

    const mockFile: Express.Multer.File = {
      fieldname: "template",
      originalname: filename,
      encoding: "7bit",
      mimetype,
      buffer: fileBuffer,
      size: fileBuffer.length,
      stream: null as any,
      destination: "",
      filename: "",
      path: "",
    };

    const result = await this.generateCv(
      employeeId,
      mockFile,
      outputFormat,
      language,
      engine,
      // The template is already in history — just bump its usage row.
      { requestingUserId: userId, recordHistory: false },
    );

    try {
      await this.cvTemplatesService.bumpUsage(template.template_id);
    } catch (exc) {
      this.logger.warn(
        `Bumping template usage failed (non-fatal): ${(exc as Error)?.message || exc}`,
      );
    }

    return result;
  }

  /**
   * Generate a CV using the employee's own uploaded CV as the template.
   * Finds the stored CV file and uses it as the template.
   */
  async generateCvFromStoredTemplate(
    employeeId: string,
    targetEmployeeId: string,
    outputFormat: "docx" | "pdf" = "docx",
    language: string = "en",
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const baseDir =
      await this.fileStorageService.findBaseDirByOwner(employeeId);
    if (!baseDir) {
      throw new NotFoundException(
        `No stored CV found for employee ${employeeId}`,
      );
    }

    // Look for CV file - only .docx is supported for reliable processing
    const possibleFiles = ["CV.docx"];
    let cvFilePath: string | null = null;
    for (const fname of possibleFiles) {
      const fullPath = path.join(baseDir, fname);
      if (fs.existsSync(fullPath)) {
        cvFilePath = fullPath;
        break;
      }
    }

    if (!cvFilePath) {
      throw new NotFoundException(
        `No DOCX CV file found for employee ${employeeId}`,
      );
    }

    const fileBuffer = await fsPromises.readFile(cvFilePath);

    const mockFile: Express.Multer.File = {
      fieldname: "template",
      originalname: path.basename(cvFilePath),
      encoding: "7bit",
      mimetype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: fileBuffer,
      size: fileBuffer.length,
      stream: null as any,
      destination: "",
      filename: "",
      path: "",
    };

    return this.generateCv(targetEmployeeId, mockFile, outputFormat, language);
  }

  private calculateTotalExperienceYears(
    experiences: WorkExperience[],
  ): number | null {
    if (!experiences?.length) {
      return null;
    }

    const now = new Date();
    const intervals: Array<{ start: number; end: number }> = [];

    for (const exp of experiences) {
      if (!exp.startDate) {
        continue;
      }

      let start = new Date(exp.startDate.getTime());
      let end = exp.endDate ? new Date(exp.endDate.getTime()) : null;
      if (exp.isCurrent) {
        end = now;
      } else if (!end) {
        // If parser did not provide an end date and role is not marked current,
        // avoid inflating totals by treating it as a point-in-time entry.
        end = new Date(start.getTime());
      }

      if (end.getTime() < start.getTime()) {
        const tmp = start;
        start = end;
        end = tmp;
      }

      intervals.push({ start: start.getTime(), end: end.getTime() });
    }

    if (!intervals.length) {
      return null;
    }

    intervals.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.start > last.end) {
        merged.push({ ...interval });
        continue;
      }
      last.end = Math.max(last.end, interval.end);
    }

    const totalMs = merged.reduce(
      (sum, interval) => sum + (interval.end - interval.start),
      0,
    );
    const yearsFloat = totalMs / (1000 * 60 * 60 * 24 * 365.25);
    // Floor-to-int makes sub-1y experience appear as 0 years, which is misleading for multiple internships.
    // Round instead so ~0.5y+ becomes 1 year.
    const years = yearsFloat < 0.5 ? 0 : Math.round(yearsFloat);
    return Math.max(0, years);
  }
}
