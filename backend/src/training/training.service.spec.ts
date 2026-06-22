import { Test, TestingModule } from "@nestjs/testing";
import { TrainingService } from "./training.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { TrainingSession } from "./training-session.entity";

describe("TrainingService", () => {
  let service: TrainingService;

  const mockRepository = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrainingService,
        {
          provide: getRepositoryToken(TrainingSession),
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

    service = module.get<TrainingService>(TrainingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });
});
