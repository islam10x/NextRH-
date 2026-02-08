import api from './api';
import { User, UserRole } from '@/types';

export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    user: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: UserRole;
    };
}

export const authService = {
    async login(email: string, password: string): Promise<AuthResponse> {
        const response = await api.post<AuthResponse>('/auth/login', { email, password });
        return response.data;
    },

    async logout(): Promise<void> {
        try {
            await api.post('/auth/logout');
        } finally {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
            localStorage.removeItem('user');
        }
    },

    async getProfile(): Promise<User> {
        const response = await api.get<User>('/auth/profile');
        return response.data;
    },

    isAuthenticated(): boolean {
        return !!localStorage.getItem('access_token');
    },
};
