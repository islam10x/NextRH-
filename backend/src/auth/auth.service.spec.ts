import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { UsersService } from "../users/users.service";
import { JwtService } from "@nestjs/jwt";
import { UserStatus } from "../users/entities/user.entity";

describe("AuthService", () => {
  let service: AuthService;

  const mockUsersService = {
    findByEmail: jest.fn(),
    validatePassword: jest.fn(),
    getAvatarUrl: jest.fn().mockReturnValue(null),
    create: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn().mockReturnValue("mock-jwt-token"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
      ],
    })
      .useMocker(() => {
        return {
          findOne: jest.fn(),
          find: jest.fn(),
          findAndCount: jest.fn(),
          create: jest.fn((entity) => entity),
          save: jest.fn((entity) => ({ session_id: "session-1", ...entity })),
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

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("login", () => {
    it("should return access and refresh tokens for valid credentials", async () => {
      mockUsersService.findByEmail.mockResolvedValue({
        user_id: "1",
        email: "test@test.com",
        role: "admin",
        password: "hashed",
        status: UserStatus.ACTIVE,
      });
      mockUsersService.validatePassword.mockResolvedValue(true);

      const result = await service.login({
        email: "test@test.com",
        password: "secret",
      });

      expect(result.accessToken).toEqual("mock-jwt-token");
      expect(mockJwtService.sign).toHaveBeenCalled();
    });
  });
});
