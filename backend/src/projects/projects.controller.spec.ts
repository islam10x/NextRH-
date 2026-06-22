import { Test, TestingModule } from "@nestjs/testing";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { AssignProjectDto } from "./dto/assign-project.dto";

describe("ProjectsController", () => {
  let controller: ProjectsController;
  let service: ProjectsService;

  const mockProjectsService = {
    assignProject: jest.fn(),
    listForUser: jest.fn(),
    listForTeam: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        {
          provide: ProjectsService,
          useValue: mockProjectsService,
        },
      ],
    })
      .useMocker(() => {
        return {
          findOne: jest.fn(),
          find: jest.fn(),
          findAndCount: jest.fn(),
          create: jest.fn(),
          save: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
          remove: jest.fn(),
          count: jest.fn(),
          get: jest.fn(),
          createQueryBuilder: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            leftJoinAndSelect: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getMany: jest.fn(),
            getOne: jest.fn(),
            getManyAndCount: jest.fn(),
          })),
        };
      })
      .compile();

    controller = module.get<ProjectsController>(ProjectsController);
    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("assign", () => {
    it("should call projectsService.assignProject", async () => {
      const dto: AssignProjectDto = {
        projectName: "Test Project",
        clientName: "Test Client",
        startDate: "2026-01-01",
        assigneeProfileIds: ["profile-1"],
        projectType: "internal",
      };

      const req = { user: { userId: "user-123" } };
      mockProjectsService.assignProject.mockResolvedValue({
        project_id: "proj-123",
        ...dto,
      });

      const result = await controller.assign(dto, req);
      expect(service.assignProject).toHaveBeenCalledWith(dto, "user-123");
      expect(result).toEqual({ project_id: "proj-123", ...dto });
    });
  });
});
