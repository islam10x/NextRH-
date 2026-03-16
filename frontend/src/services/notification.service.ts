import api from './api';
import { Notification } from '@/types';

interface BackendNotification {
  notification_id: string;
  notificationType: string;
  title: string;
  message?: string;
  isRead: boolean;
  createdAt: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  scheduledAt?: string | null;
  emailSent?: boolean;
  priority?: number;
}

const mapNotification = (n: BackendNotification): Notification => ({
  id: n.notification_id,
  userId: '',
  title: n.title,
  message: n.message || '',
  type:
    n.priority && n.priority >= 3
      ? 'error'
      : n.priority === 2
        ? 'warning'
        : 'info',
  read: n.isRead,
  createdAt: n.createdAt,
  notificationType: n.notificationType,
  relatedEntityType: n.relatedEntityType,
  relatedEntityId: n.relatedEntityId,
  priority: n.priority,
});

export const notificationService = {
  async listMine(): Promise<Notification[]> {
    const res = await api.get<BackendNotification[]>('/notifications/me');
    return res.data.map(mapNotification);
  },

  async getUnreadCount(): Promise<number> {
    const res = await api.get<{ count: number }>('/notifications/me/unread-count');
    return res.data.count;
  },

  async markRead(id: string) {
    await api.patch(`/notifications/${id}/read`);
  },

  async markAllRead() {
    await api.patch('/notifications/me/read-all');
  },

  async remove(id: string) {
    await api.delete(`/notifications/${id}`);
  },
};
