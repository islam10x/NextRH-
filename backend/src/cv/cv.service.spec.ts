import { Test, TestingModule } from "@nestjs/testing";
import { CvService } from "./cv.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MetadataSnapshot } from "./entities/metadata-snapshot.entity";
import { EmployeeProfile } from "../employees/entities/employee-profile.entity";

describe("CvService", () => {
  let service: CvService;

  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CvService,
        {
          provide: getRepositoryToken(MetadataSnapshot),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(EmployeeProfile),
          useValue: mockRepository,
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

    service = module.get<CvService>(CvService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("generateCv", () => {
    it("should be defined as a method", () => {
      expect(service.generateCv).toBeDefined();
    });
  });

  describe("processCvData", () => {
    it("should be defined as a method", () => {
      expect(service.processCvData).toBeDefined();
    });
  });
});
