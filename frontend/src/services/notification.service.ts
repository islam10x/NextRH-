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
}

const mapNotification = (n: BackendNotification): Notification => ({
  id: n.notification_id,
  userId: '',
  title: n.title,
  message: n.message || '',
  type: 'info',
  read: n.isRead,
  createdAt: n.createdAt,
  notificationType: n.notificationType,
  relatedEntityType: n.relatedEntityType,
  relatedEntityId: n.relatedEntityId,
});

export const notificationService = {
  async listMine(): Promise<Notification[]> {
    const res = await api.get<BackendNotification[]>('/notifications/me');
    return res.data.map(mapNotification);
  },

  async markRead(id: string) {
    await api.patch(`/notifications/${id}/read`);
  },

  async remove(id: string) {
    await api.delete(`/notifications/${id}`);
  },
};
