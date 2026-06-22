import { Test, TestingModule } from "@nestjs/testing";
import { ProjectsService } from "./projects.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Project } from "./entities/project.entity";
import { ProjectParticipant } from "./entities/participant.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/entities/user.entity";

describe("ProjectsService", () => {
  let service: ProjectsService;

  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockNotificationsService = {
    create: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: getRepositoryToken(Project),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(ProjectParticipant),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(EmployeeProfile),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
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

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("assignProject", () => {
    it("should be defined as a method", () => {
      expect(service.assignProject).toBeDefined();
    });
  });
});
