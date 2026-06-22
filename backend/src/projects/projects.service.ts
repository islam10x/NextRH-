import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Not, Repository } from "typeorm";
import { Project } from "./entities/project.entity";
import { ProjectParticipant } from "./entities/participant.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { Skill } from "../skills/entities/skill.entity";
import { AssignProjectDto } from "./dto/assign-project.dto";
import { UpdateParticipationDto } from "./dto/update-participation.dto";
import { TeamsService } from "../teams/teams.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/entities/user.entity";
import { ScoringService } from "../scoring/scoring.service";
import { CrossTeamAssignmentRequest } from "./entities/cross-team-assignment-request.entity";
import { RequestCrossTeamMemberDto } from "./dto/request-cross-team-member.dto";
import { RespondCrossTeamRequestDto } from "./dto/respond-cross-team-request.dto";
import { Team } from "../teams/entities/team.entity";

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectParticipant)
    private readonly participantRepo: Repository<ProjectParticipant>,
    @InjectRepository(EmployeeProfile)
    private readonly profileRepo: Repository<EmployeeProfile>,
    @InjectRepository(Skill)
    private readonly skillRepo: Repository<Skill>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(CrossTeamAssignmentRequest)
    private readonly crossTeamRequestRepo: Repository<CrossTeamAssignmentRequest>,
    @InjectRepository(Team)
    private readonly teamRepo: Repository<Team>,
    private readonly teamsService: TeamsService,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => ScoringService))
    private readonly scoringService: ScoringService,
  ) {
    this.logger = new Logger(ProjectsService.name);
  }

  private logger: Logger;

  async assignProject(dto: AssignProjectDto, managerUserId: string) {
    if (!dto.assigneeProfileIds?.length) {
      throw new BadRequestException("At least one assignee is required.");
    }

    const projectType = dto.projectType || "internal";
    if (projectType === "internal" && !dto.complexity) {
      throw new BadRequestException(
        "Complexity is required for internal projects.",
      );
    }
    if (projectType === "external" && dto.complexity) {
      throw new BadRequestException(
        "External project complexity is defined only through PV upload.",
      );
    }

    const teamMembers =
      await this.teamsService.getMembersForManager(managerUserId);
    const allowedProfiles = new Set(
      teamMembers.map((m) => m.profileId).filter(Boolean),
    );
    const invalidProfile = dto.assigneeProfileIds.find(
      (id) => !allowedProfiles.has(id),
    );
    if (invalidProfile) {
      throw new BadRequestException(
        "One or more assignees are not in your team.",
      );
    }

    const profiles = await this.profileRepo.find({
      where: { profile_id: In(dto.assigneeProfileIds) },
      relations: ["user"],
    });
    if (profiles.length !== dto.assigneeProfileIds.length) {
      throw new NotFoundException("One or more assignee profiles not found.");
    }

    const startDate = dto.startDate ? this.toDate(dto.startDate) : null;
    const endDate = dto.endDate ? this.toDate(dto.endDate) : null;

    const managerUser = await this.usersRepo.findOne({
      where: { user_id: managerUserId },
    });
    const managerName = managerUser
      ? [managerUser.firstName, managerUser.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || managerUser.email
      : "Your manager";

    let project = await this.projectRepo.findOne({
      where: {
        projectName: dto.projectName,
        clientName: dto.clientName || null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        createdBy: managerUserId,
        projectType,
      },
      relations: ["skills"],
    });

    if (!project) {
      project = this.projectRepo.create({
        projectName: dto.projectName,
        clientName: dto.clientName || null,
        projectDescription: dto.projectDescription || null,
        startDate,
        endDate,
        projectType,
        complexity:
          projectType === "internal" ? dto.complexity || "medium" : null,
        createdBy: managerUserId,
      });
    } else {
      if (!project.projectDescription && dto.projectDescription) {
        project.projectDescription = dto.projectDescription;
      }
      if (project.projectType === "internal" && dto.complexity) {
        project.complexity = dto.complexity;
      }
    }

    if (dto.technologies?.length) {
      const techNames = dto.technologies
        .map((t) => String(t || "").trim())
        .filter(Boolean);
      if (techNames.length) {
        const existing = await this.skillRepo.find({
          where: { skillName: In(techNames) },
        });
        const existingNames = new Set(
          existing.map((s) => s.skillName.toLowerCase()),
        );
        const newSkills = techNames
          .filter((name) => !existingNames.has(name.toLowerCase()))
          .map((name) => this.skillRepo.create({ skillName: name }));
        const savedNew = newSkills.length
          ? await this.skillRepo.save(newSkills)
          : [];
        project.skills = [...existing, ...savedNew];
      }
    }

    project = await this.projectRepo.save(project);

    const created: ProjectParticipant[] = [];
    for (const profile of profiles) {
      let participant = await this.participantRepo.findOne({
        where: {
          project: { project_id: project.project_id },
          profile: { profile_id: profile.profile_id },
        },
        relations: ["project", "profile"],
      });
      if (!participant) {
        participant = this.participantRepo.create({
          project,
          profile,
          description: "",
          assignedBy: managerUserId,
          assignmentType: "internal",
          homeManagerId: managerUserId,
          crossTeamRequestId: null,
        });
      } else {
        participant.assignedBy = managerUserId;
        participant.assignmentType = "internal";
        participant.homeManagerId = managerUserId;
      }
      created.push(await this.participantRepo.save(participant));
    }

    const projectLabel = project.projectName;
    const clientLabel = project.clientName ? ` - ${project.clientName}` : "";
    await Promise.all(
      profiles.map((profile) => {
        const userId = profile.user?.user_id;
        if (!userId) return Promise.resolve();
        return this.notificationsService.create({
          userId,
          type: "project_assigned",
          title: "New project assigned",
          message: `${projectLabel}${clientLabel} - Assigned by ${managerName}`,
          relatedEntityType: "project",
          relatedEntityId: project.project_id,
        });
      }),
    );

    // Scores are NOT updated on assignment - only when PV is submitted.

    return created;
  }

  async listForUser(userId: string) {
    const profile = await this.profileRepo.findOne({
      where: { user: { user_id: userId } },
    });
    if (!profile) {
      throw new NotFoundException("Profile not found for user");
    }

    const participants = await this.participantRepo.find({
      where: {
        profile: { profile_id: profile.profile_id },
        assignedBy: Not(IsNull()),
      },
      relations: ["project", "project.skills"],
      order: { participant_id: "DESC" },
    });

    const managerIds = Array.from(
      new Set(
        participants.map((p) => p.assignedBy).filter(Boolean) as string[],
      ),
    );
    const managerNameById = new Map<string, string>();
    if (managerIds.length) {
      const managers = await this.usersRepo.find({
        where: { user_id: In(managerIds) },
      });
      for (const manager of managers) {
        managerNameById.set(
          manager.user_id,
          [manager.firstName, manager.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || manager.email,
        );
      }
    }

    return participants.map((p) => ({
      id: p.participant_id,
      projectId: p.project?.project_id,
      employeeId: userId,
      name: p.project?.projectName ?? "",
      client: p.project?.clientName ?? "",
      startDate: this.toDateString(p.project?.startDate),
      endDate: this.toDateString(p.project?.endDate),
      technologies: (p.project?.skills ?? []).map((s) => s.skillName),
      description: p.description || p.project?.projectDescription || "",
      projectType: p.project?.projectType || "internal",
      assignmentType: p.assignmentType || "internal",
      assignedByName: p.assignedBy
        ? managerNameById.get(p.assignedBy) || "Manager"
        : "",
    }));
  }

  async listForManager(managerUserId: string) {
    const participants = await this.participantRepo.find({
      where: { assignedBy: managerUserId },
      relations: ["project", "project.skills", "profile", "profile.user"],
      order: { participant_id: "DESC" },
    });

    return participants.map((p) => {
      const user = p.profile?.user;
      return {
        id: p.participant_id,
        projectId: p.project?.project_id,
        employeeId: user?.user_id || "",
        assigneeProfileId: p.profile?.profile_id || "",
        assigneeName:
          [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
          user?.email ||
          "",
        assigneeEmail: user?.email || "",
        name: p.project?.projectName ?? "",
        client: p.project?.clientName ?? "",
        startDate: this.toDateString(p.project?.startDate),
        endDate: this.toDateString(p.project?.endDate),
        technologies: (p.project?.skills ?? []).map((s) => s.skillName),
        description: p.description || p.project?.projectDescription || "",
        projectType: p.project?.projectType || "internal",
        assignmentType: p.assignmentType || "internal",
        homeManagerId: p.homeManagerId,
      };
    });
  }

  async listOwnedProjects(managerUserId: string) {
    const projects = await this.projectRepo.find({
      where: { createdBy: managerUserId },
      order: { projectName: "ASC" },
    });
    return projects.map((project) => ({
      projectId: project.project_id,
      projectName: project.projectName,
      clientName: project.clientName,
      projectType: project.projectType,
      complexity: project.complexity,
      startDate: this.toDateString(project.startDate),
      endDate: this.toDateString(project.endDate),
      assignedAt: this.toDateString(project.startDate),
    }));
  }

  async requestCrossTeamMember(
    dto: RequestCrossTeamMemberDto,
    managerUserId: string,
  ) {
    const project = await this.projectRepo.findOne({
      where: { project_id: dto.projectId },
    });
    if (!project) {
      throw new NotFoundException("Project not found.");
    }
    if (project.createdBy && project.createdBy !== managerUserId) {
      throw new ForbiddenException(
        "You can only request external members for your own projects.",
      );
    }
    const targetTeam = await this.teamRepo.findOne({
      where: { team_id: dto.targetTeamId },
      relations: ["manager"],
    });
    if (!targetTeam || !targetTeam.manager?.user_id) {
      throw new NotFoundException("Target team not found.");
    }
    if (targetTeam.manager.user_id === managerUserId) {
      throw new BadRequestException(
        "You cannot request an external member from your own team.",
      );
    }

    const existingPending = await this.crossTeamRequestRepo.findOne({
      where: {
        projectId: dto.projectId,
        targetTeamId: dto.targetTeamId,
        status: "pending",
      },
    });
    if (existingPending) {
      throw new BadRequestException(
        "A pending request already exists for this team on this project.",
      );
    }

    const request = this.crossTeamRequestRepo.create({
      projectId: dto.projectId,
      requestingManagerId: managerUserId,
      targetTeamId: dto.targetTeamId,
      targetManagerId: targetTeam.manager.user_id,
      selectedProfileId: null,
      status: "pending",
      requestNote: dto.requestNote?.trim() || null,
      responseNote: null,
      respondedAt: null,
    });
    const saved = await this.crossTeamRequestRepo.save(request);

    const requesterTeamName =
      await this.teamsService.getTeamNameForManager(managerUserId);
    await this.notificationsService.create({
      userId: targetTeam.manager.user_id,
      type: "cross_team_member_requested",
      title: "External member request",
      message: `${requesterTeamName} requested an external member for "${project.projectName}".`,
      relatedEntityType: "cross_team_assignment_request",
      relatedEntityId: saved.request_id,
    });

    return this.mapCrossTeamRequest(
      saved,
      project,
      targetTeam.teamName || "Team",
    );
  }

  async listIncomingCrossTeamRequests(managerUserId: string) {
    const requests = await this.crossTeamRequestRepo.find({
      where: { targetManagerId: managerUserId },
      relations: [
        "project",
        "targetTeam",
        "selectedProfile",
        "selectedProfile.user",
      ],
      order: { createdAt: "DESC" },
    });

    const requesterIds = Array.from(
      new Set(requests.map((r) => r.requestingManagerId)),
    );
    const requesterUsers = requesterIds.length
      ? await this.usersRepo.find({ where: { user_id: In(requesterIds) } })
      : [];
    const requesterById = new Map(
      requesterUsers.map((user) => [
        user.user_id,
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
          user.email,
      ]),
    );
    const requesterTeamNames =
      await this.teamsService.getTeamNamesForManagers(requesterIds);

    return requests.map((request) => ({
      requestId: request.request_id,
      projectId: request.projectId,
      projectName: request.project?.projectName || "",
      projectDescription: request.project?.projectDescription || null,
      clientName: request.project?.clientName || null,
      requestingManagerId: request.requestingManagerId,
      requestingManagerName:
        requesterById.get(request.requestingManagerId) || "Manager",
      requestingTeamName:
        requesterTeamNames.get(request.requestingManagerId) || "Team",
      targetTeamId: request.targetTeamId,
      targetTeamName: request.targetTeam?.teamName || "Team",
      status: request.status,
      requestNote: request.requestNote,
      responseNote: request.responseNote,
      selectedProfileId: request.selectedProfileId,
      selectedEmployeeName: request.selectedProfile?.user
        ? [
            request.selectedProfile.user.firstName,
            request.selectedProfile.user.lastName,
          ]
            .filter(Boolean)
            .join(" ")
            .trim() || request.selectedProfile.user.email
        : null,
      createdAt: request.createdAt,
      respondedAt: request.respondedAt,
    }));
  }

  async listOutgoingCrossTeamRequests(managerUserId: string) {
    const requests = await this.crossTeamRequestRepo.find({
      where: { requestingManagerId: managerUserId },
      relations: [
        "project",
        "targetTeam",
        "selectedProfile",
        "selectedProfile.user",
      ],
      order: { createdAt: "DESC" },
    });

    const targetManagerIds = Array.from(
      new Set(requests.map((r) => r.targetManagerId)),
    );
    const targetManagers = targetManagerIds.length
      ? await this.usersRepo.find({ where: { user_id: In(targetManagerIds) } })
      : [];
    const targetManagerById = new Map(
      targetManagers.map((user) => [
        user.user_id,
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
          user.email,
      ]),
    );

    return requests.map((request) => ({
      requestId: request.request_id,
      projectId: request.projectId,
      projectName: request.project?.projectName || "",
      targetTeamId: request.targetTeamId,
      targetTeamName: request.targetTeam?.teamName || "Team",
      targetManagerId: request.targetManagerId,
      targetManagerName:
        targetManagerById.get(request.targetManagerId) || "Manager",
      status: request.status,
      requestNote: request.requestNote,
      responseNote: request.responseNote,
      selectedProfileId: request.selectedProfileId,
      selectedEmployeeName: request.selectedProfile?.user
        ? [
            request.selectedProfile.user.firstName,
            request.selectedProfile.user.lastName,
          ]
            .filter(Boolean)
            .join(" ")
            .trim() || request.selectedProfile.user.email
        : null,
      createdAt: request.createdAt,
      respondedAt: request.respondedAt,
    }));
  }

  async respondCrossTeamRequest(
    requestId: string,
    managerUserId: string,
    dto: RespondCrossTeamRequestDto,
  ) {
    const request = await this.crossTeamRequestRepo.findOne({
      where: { request_id: requestId },
      relations: ["project", "targetTeam"],
    });
    if (!request) {
      throw new NotFoundException("Cross-team request not found.");
    }
    if (request.targetManagerId !== managerUserId) {
      throw new ForbiddenException(
        "You can only respond to requests sent to your team.",
      );
    }
    if (request.status !== "pending") {
      throw new BadRequestException("This request has already been processed.");
    }

    if (!dto.approved) {
      request.status = "rejected";
      request.responseNote = dto.responseNote?.trim() || null;
      request.respondedAt = new Date();
      const savedRejected = await this.crossTeamRequestRepo.save(request);

      await this.notificationsService.create({
        userId: request.requestingManagerId,
        type: "cross_team_member_rejected",
        title: "External member request rejected",
        message: `${request.targetTeam?.teamName || "Team"} rejected your request for "${request.project?.projectName || "project"}".`,
        relatedEntityType: "cross_team_assignment_request",
        relatedEntityId: savedRejected.request_id,
      });

      return savedRejected;
    }

    if (!dto.selectedProfileId) {
      throw new BadRequestException(
        "You must select an employee when approving a request.",
      );
    }
    const isInManagerTeam = await this.teamsService.isProfileInManagerTeam(
      managerUserId,
      dto.selectedProfileId,
    );
    if (!isInManagerTeam) {
      throw new ForbiddenException(
        "You can only assign members from your own team.",
      );
    }

    const selectedProfile = await this.profileRepo.findOne({
      where: { profile_id: dto.selectedProfileId },
      relations: ["user"],
    });
    if (!selectedProfile) {
      throw new NotFoundException("Selected employee profile not found.");
    }

    const existingParticipant = await this.participantRepo.findOne({
      where: {
        project: { project_id: request.projectId },
        profile: { profile_id: dto.selectedProfileId },
      },
    });
    if (existingParticipant) {
      throw new BadRequestException(
        "This employee is already assigned to the project.",
      );
    }

    await this.participantRepo.save(
      this.participantRepo.create({
        project: { project_id: request.projectId } as Project,
        profile: { profile_id: dto.selectedProfileId } as EmployeeProfile,
        description: "",
        assignedBy: request.requestingManagerId,
        assignmentType: "external",
        homeManagerId: managerUserId,
        crossTeamRequestId: request.request_id,
      }),
    );

    request.status = "approved";
    request.selectedProfileId = dto.selectedProfileId;
    request.responseNote = dto.responseNote?.trim() || null;
    request.respondedAt = new Date();
    const savedApproved = await this.crossTeamRequestRepo.save(request);

    const selectedEmployeeName =
      [selectedProfile.user?.firstName, selectedProfile.user?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      selectedProfile.user?.email ||
      "Selected employee";

    await this.notificationsService.create({
      userId: request.requestingManagerId,
      type: "cross_team_member_selected",
      title: "External member selected",
      message: `${request.targetTeam?.teamName || "Team"} selected ${selectedEmployeeName} for "${request.project?.projectName || "project"}".`,
      relatedEntityType: "cross_team_assignment_request",
      relatedEntityId: savedApproved.request_id,
    });

    if (selectedProfile.user?.user_id) {
      await this.notificationsService.create({
        userId: selectedProfile.user.user_id,
        type: "project_assigned",
        title: "Assigned as external project member",
        message: `You were assigned to "${request.project?.projectName || "a project"}" as an external member.`,
        relatedEntityType: "project",
        relatedEntityId: request.projectId,
      });
    }

    return savedApproved;
  }

  async updateParticipation(
    participantId: string,
    userId: string,
    dto: UpdateParticipationDto,
  ) {
    const participant = await this.participantRepo.findOne({
      where: { participant_id: participantId },
      relations: ["profile", "profile.user", "project"],
    });
    if (!participant) {
      throw new NotFoundException("Project participation not found");
    }
    if (participant.profile?.user?.user_id !== userId) {
      throw new NotFoundException(
        "Project participation not found for this user",
      );
    }

    if (dto.description !== undefined) {
      participant.description = String(dto.description || "").trim();
    }

    const saved = await this.participantRepo.save(participant);

    const employeeUserId = participant.profile?.user?.user_id;
    const employeeName =
      [
        participant.profile?.user?.firstName,
        participant.profile?.user?.lastName,
      ]
        .filter(Boolean)
        .join(" ") ||
      participant.profile?.user?.email ||
      "Employee";
    const projectName = participant.project?.projectName || "a project";
    const notifyManagerIds = participant.assignedBy
      ? [participant.assignedBy]
      : employeeUserId
        ? await this.teamsService.getManagersForEmployee(employeeUserId)
        : [];

    if (notifyManagerIds.length) {
      await Promise.all(
        notifyManagerIds.map((mgrId) =>
          this.notificationsService.create({
            userId: mgrId,
            type: "project_updated",
            title: "Project updated",
            message: `${employeeName} updated ${projectName}`,
            relatedEntityType: "project",
            relatedEntityId: participant.project?.project_id,
          }),
        ),
      );
    }

    return saved;
  }

  private mapCrossTeamRequest(
    request: CrossTeamAssignmentRequest,
    project?: Project,
    targetTeamName?: string,
  ) {
    return {
      requestId: request.request_id,
      projectId: request.projectId,
      projectName: project?.projectName || "",
      targetTeamId: request.targetTeamId,
      targetTeamName: targetTeamName || "Team",
      status: request.status,
      requestNote: request.requestNote,
      responseNote: request.responseNote,
      selectedProfileId: request.selectedProfileId,
      createdAt: request.createdAt,
      respondedAt: request.respondedAt,
    };
  }

  private toDate(value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException("Invalid date format");
    }
    return parsed;
  }

  private toDateString(value?: Date | string | null): string {
    if (!value) return "";
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return value;
      }
      return parsed.toISOString().slice(0, 10);
    }
    return "";
  }
}
