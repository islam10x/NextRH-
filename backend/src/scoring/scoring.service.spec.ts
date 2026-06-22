import { Test, TestingModule } from "@nestjs/testing";
import { ScoringService } from "./scoring.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";
import { DocumentHash } from "./entities/document-hash.entity";
import { ProjectRecord } from "./entities/project-record.entity";
import { TrainingRecord } from "./entities/training-record.entity";
import { ScoringTarget } from "./entities/scoring-target.entity";
import { EmployeeScore } from "./entities/employee-score.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";
import { Certification } from "../certifications/entities/certification.entity";
import { User } from "../users/entities/user.entity";
import { TrainingSession } from "../training/training-session.entity";
import { ProjectParticipant } from "../projects/entities/participant.entity";
import { Project } from "../projects/entities/project.entity";

describe("ScoringService", () => {
  let service: ScoringService;

  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue("http://localhost:8000"),
  };

  const mockNotificationsService = {
    create: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScoringService,
        {
          provide: getRepositoryToken(DocumentHash),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(ProjectRecord),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(TrainingRecord),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(ScoringTarget),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(EmployeeScore),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(EmployeeProfile),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Certification),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(TrainingSession),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(ProjectParticipant),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Project),
          useValue: mockRepository,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
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

    service = module.get<ScoringService>(ScoringService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("previewPv", () => {
    it("should be defined as a method", () => {
      expect(service.previewPv).toBeDefined();
    });
  });

  describe("uploadPv", () => {
    it("should throw BadRequestException if no profiles provided", async () => {
      const file = {
        buffer: Buffer.from("test"),
        originalname: "test.pdf",
        mimetype: "application/pdf",
      } as Express.Multer.File;
      await expect(service.uploadPv(file, [], "manager-123")).rejects.toThrow(
        "pour cet import PV",
      );
    });

    it("should throw BadRequestException if projectId is missing", async () => {
      const file = {
        buffer: Buffer.from("test"),
        originalname: "test.pdf",
        mimetype: "application/pdf",
      } as Express.Multer.File;
      await expect(
        service.uploadPv(file, ["profile-1"], "manager-123"),
      ).rejects.toThrow("Le projet est obligatoire pour importer un PV.");
    });
  });
});
