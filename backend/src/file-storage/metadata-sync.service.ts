import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { FileStorageService } from "./file-storage.service";

/**
 * Rebuilds the per-employee metadata.json from the current DB state.
 *
 * The RAG ETL merges DB rows with the `structured_data` arrays stored in
 * metadata.json (which originally captured the raw CV parse). If a user edits
 * or deletes an experience / education / project / certification in the DB but
 * the stale entry survives in metadata.json, the ETL re-introduces it on the
 * next sync. Calling {@link syncFromDb} after every self-service CV correction
 * keeps the file aligned with the DB so RAG answers stay accurate.
 *
 * Skills are intentionally left untouched: they live only in metadata.json
 * (there is no skills table for the profile), so rebuilding them from the DB
 * would wipe them.
 */
@Injectable()
export class MetadataSyncService {
  private readonly logger = new Logger(MetadataSyncService.name);

  constructor(
    @InjectRepository(EmployeeProfile)
    private readonly profileRepository: Repository<EmployeeProfile>,
    private readonly fileStorageService: FileStorageService,
  ) {}

  async syncFromDb(userId: string): Promise<void> {
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
    if (!profile) {
      return;
    }

    const clean = (value: unknown): string =>
      value == null ? "" : String(value).replace(/\s+/g, " ").trim();

    const toIso = (value: Date | string | null | undefined): string => {
      if (!value) return "";
      const date = value instanceof Date ? value : new Date(value);
      return isNaN(date.getTime()) ? "" : date.toISOString().split("T")[0];
    };

    const experience = (profile.workExperiences ?? []).map((exp) => ({
      title: clean(exp.jobTitle),
      company: clean(exp.companyName),
      start_date: toIso(exp.startDate),
      end_date: exp.isCurrent ? "" : toIso(exp.endDate),
      is_current: Boolean(exp.isCurrent),
      description: clean(exp.description),
    }));

    const education = (profile.educations ?? []).map((edu) => {
      const entry: Record<string, string> = {
        degree: clean(edu.degree),
        institution: clean(edu.institution),
        end_date: toIso(edu.endDate),
      };
      if (edu.fieldOfStudy) {
        entry.field_of_study = clean(edu.fieldOfStudy);
      }
      return entry;
    });

    const projects = (profile.projectParticipations ?? []).map((p) => ({
      name: clean(p.project?.projectName) || "Unknown Project",
      client: clean(p.project?.clientName),
      description: clean(p.description || p.project?.projectDescription),
      role: clean(p.role),
      date: toIso(p.project?.startDate),
      skills: (p.project?.skills ?? [])
        .map((s) => clean(s.skillName))
        .filter(Boolean),
    }));

    const certifications = (profile.certifications ?? [])
      .map((cert) => {
        const name = clean(cert.certificationName);
        if (!name) return null;
        const entry: Record<string, unknown> = {
          name,
          is_uploaded: Boolean(cert.isUploaded),
        };
        const issuer = clean(cert.issuingOrganization);
        const issueDate = toIso(cert.issueDate);
        const expiration = toIso(cert.expirationDate);
        const credentialId = clean(cert.credentialId);
        if (issuer) entry.issuer = issuer;
        if (issueDate) {
          entry.issue_date = issueDate;
          entry.date_obtained = issueDate;
        }
        if (expiration) entry.expiration = expiration;
        if (credentialId) entry.credential_id = credentialId;
        return entry;
      })
      .filter(Boolean);

    await this.fileStorageService.mutateMetadata(userId, (metadata) => {
      const sd = metadata.structured_data;
      sd.experience = experience;
      sd.education = education;
      sd.projects = projects;
      sd.certifications = certifications;

      // Scalar contact fields are only updated when the DB actually holds a
      // value. They are not always persisted to the DB on upload (the parser
      // writes them straight into metadata.json), so blindly writing an empty
      // DB value here would wipe the parsed phone/address/summary the next time
      // the employee edits an unrelated section.
      const summary = clean(profile.professionalSummary);
      if (summary) sd.summary = summary;
      const phone = clean(profile.phone);
      if (phone) sd.phone = phone;
      const address = clean(profile.address);
      if (address) sd.address = address;
      const currentPosition = clean(profile.currentPosition);
      if (currentPosition) sd.current_position = currentPosition;

      // Top-level certifications feed getEmployeeMetadata() and the RAG file
      // source, so keep them aligned with the DB-derived list above.
      metadata.certifications = certifications;
      if (typeof profile.totalExperienceYears === "number") {
        metadata.experience_years = profile.totalExperienceYears;
      }
    });

    this.logger.log(`Synced metadata.json from DB for user ${userId}`);
  }
}
