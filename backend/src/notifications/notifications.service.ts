import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Notification, NotificationType } from "./entities/notification.entity";
import { User } from "../users/entities/user.entity";
import { N8nWebhookPusher } from "./n8n-webhook-pusher.service";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepo: Repository<Notification>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly n8nPusher: N8nWebhookPusher,
  ) {}

  async create(params: {
    userId: string;
    type: NotificationType;
    title: string;
    message?: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
    scheduledAt?: Date;
    priority?: number;
  }) {
    const user = await this.usersRepo.findOne({
      where: { user_id: params.userId },
    });
    if (!user) return;
    const notif = this.notificationsRepo.create({
      user,
      notificationType: params.type,
      title: params.title,
      message: params.message,
      relatedEntityType: params.relatedEntityType,
      relatedEntityId: params.relatedEntityId,
      scheduledAt: params.scheduledAt ?? null,
      priority: params.priority ?? 1,
    });
    const saved = await this.notificationsRepo.save(notif);

    // Push to n8n immediately (fire-and-forget) — if scheduled_at is
    // in the future the daily fallback sweep will pick it up instead.
    if (!params.scheduledAt || params.scheduledAt <= new Date()) {
      this.n8nPusher.push({
        notificationId: saved.notification_id,
        userEmail: user.email,
        userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        type: saved.notificationType,
        title: saved.title,
        message: saved.message,
        priority: saved.priority,
        createdAt: saved.createdAt,
      });
    }

    return saved;
  }

  /**
   * List notifications for a user.
   * Only returns notifications that are either not scheduled or whose scheduled_at <= now.
   */
  async listForUser(userId: string) {
    const now = new Date();
    return this.notificationsRepo
      .createQueryBuilder("n")
      .where("n.user_id = :userId", { userId })
      .andWhere("(n.scheduled_at IS NULL OR n.scheduled_at <= :now)", { now })
      .orderBy("n.created_at", "DESC")
      .take(50)
      .getMany();
  }

  async getUnreadCount(userId: string): Promise<number> {
    const now = new Date();
    return this.notificationsRepo
      .createQueryBuilder("n")
      .where("n.user_id = :userId", { userId })
      .andWhere("n.is_read = false")
      .andWhere("(n.scheduled_at IS NULL OR n.scheduled_at <= :now)", { now })
      .getCount();
  }

  async markRead(notificationId: string, userId: string) {
    await this.notificationsRepo.update(
      { notification_id: notificationId, user: { user_id: userId } },
      { isRead: true },
    );
  }

  async markAllReadForUser(userId: string) {
    await this.notificationsRepo
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where("user_id = :userId", { userId })
      .andWhere("is_read = false")
      .execute();
  }

  async deleteForUser(notificationId: string, userId: string) {
    await this.notificationsRepo.delete({
      notification_id: notificationId,
      user: { user_id: userId },
    });
  }

  /**
   * Called by the n8n webhook to mark a notification as email-sent.
   */
  async markEmailSent(notificationId: string) {
    await this.notificationsRepo.update(
      { notification_id: notificationId },
      { emailSent: true },
    );
  }

  /**
   * Returns pending notifications that have not yet been emailed.
   * Used by n8n to know which notifications to send emails for.
   */
  async getPendingEmailNotifications(limit = 50) {
    return this.notificationsRepo
      .createQueryBuilder("n")
      .leftJoinAndSelect("n.user", "u")
      .where("n.email_sent = false")
      .andWhere("(n.scheduled_at IS NULL OR n.scheduled_at <= :now)", {
        now: new Date(),
      })
      .orderBy("n.created_at", "ASC")
      .take(limit)
      .getMany();
  }
}
