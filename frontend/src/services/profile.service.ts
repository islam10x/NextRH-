import api from './api';

export interface ProfileSettingsUser {
  user_id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  avatarUrl?: string | null;
}

export const profileService = {
  async getMe(): Promise<ProfileSettingsUser> {
    const response = await api.get<ProfileSettingsUser>('/users/me');
    return response.data;
  },

  async updateProfile(payload: { firstName: string; lastName: string }): Promise<ProfileSettingsUser> {
    const response = await api.patch<ProfileSettingsUser>('/users/me/profile', payload);
    return response.data;
  },

  async changePassword(payload: { currentPassword: string; newPassword: string }) {
    const response = await api.post<{ message: string }>('/users/me/password', payload);
    return response.data;
  },

  async uploadAvatar(file: File): Promise<ProfileSettingsUser> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post<ProfileSettingsUser>('/users/me/avatar', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },
};
