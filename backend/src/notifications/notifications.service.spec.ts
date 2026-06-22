import { Test, TestingModule } from "@nestjs/testing";
import { NotificationsService } from "./notifications.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Notification } from "./entities/notification.entity";
import { MailService } from "../mail/mail.service";
import { User } from "../users/entities/user.entity";

describe("NotificationsService", () => {
  let service: NotificationsService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };

  const mockMailService = {
    sendMail: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: MailService,
          useValue: mockMailService,
        },
      ],
    })
      .useMocker(() => {
        return {
          push: jest.fn(),
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

    service = module.get<NotificationsService>(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("create", () => {
    it("should create and save a notification", async () => {
      const dto = {
        userId: "user-1",
        title: "Test",
        message: "Test message",
        type: "project_assigned" as const,
      };
      mockUserRepository.findOne.mockResolvedValue({
        user_id: "user-1",
        email: "user@test.com",
      });
      mockRepository.create.mockReturnValue(dto);
      mockRepository.save.mockResolvedValue({ notification_id: "1", ...dto });

      const result = await service.create(dto);
      expect(result?.notification_id).toEqual("1");
      expect(mockRepository.save).toHaveBeenCalled();
    });
  });

  describe("markRead", () => {
    it("should update notification status to read", async () => {
      await service.markRead("notif-1", "user-1");
      expect(mockRepository.update).toHaveBeenCalledWith(
        { notification_id: "notif-1", user: { user_id: "user-1" } },
        { isRead: true },
      );
    });
  });
});
