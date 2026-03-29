import api from './api';
import { User, UserRole } from '@/types';

export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    session_id: string;
    user: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: UserRole;
        avatarUrl?: string | null;
    };
}

export const authService = {
    async login(email: string, password: string): Promise<AuthResponse> {
        const response = await api.post<AuthResponse>('/auth/login', { email, password });
        return response.data;
    },

    async logout(): Promise<void> {
        try {
            const sessionId = sessionStorage.getItem('session_id');
            if (sessionId) {
                await api.post('/auth/logout', { session_id: sessionId });
            }
        } catch (error: any) {
            if (error?.response?.status && error.response.status !== 401) {
                throw error;
            }
        } finally {
            sessionStorage.removeItem('access_token');
            sessionStorage.removeItem('user');
            sessionStorage.removeItem('refresh_token');
            sessionStorage.removeItem('session_id');
        }
    },

    async getProfile(): Promise<User> {
        const response = await api.get<User>('/auth/profile');
        return response.data;
    },

    isAuthenticated(): boolean {
        return !!sessionStorage.getItem('access_token');
    },
};
