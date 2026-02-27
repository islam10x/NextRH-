import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class NotificationsService {
    constructor(
        @InjectRepository(Notification)
        private readonly notificationsRepo: Repository<Notification>,
        @InjectRepository(User)
        private readonly usersRepo: Repository<User>,
    ) { }

    async create(params: {
        userId: string;
        type: NotificationType;
        title: string;
        message?: string;
        relatedEntityType?: string;
        relatedEntityId?: string;
    }) {
        const user = await this.usersRepo.findOne({ where: { user_id: params.userId } });
        if (!user) return;
        const notif = this.notificationsRepo.create({
            user,
            notificationType: params.type,
            title: params.title,
            message: params.message,
            relatedEntityType: params.relatedEntityType,
            relatedEntityId: params.relatedEntityId,
        });
        return this.notificationsRepo.save(notif);
    }

    async listForUser(userId: string) {
        return this.notificationsRepo.find({
            where: { user: { user_id: userId } },
            order: { createdAt: 'DESC' },
            take: 50,
        });
    }

    async markRead(notificationId: string, userId: string) {
        await this.notificationsRepo.update(
            { notification_id: notificationId, user: { user_id: userId } },
            { isRead: true },
        );
    }

    async deleteForUser(notificationId: string, userId: string) {
        await this.notificationsRepo.delete({
            notification_id: notificationId,
            user: { user_id: userId },
        });
    }
}
