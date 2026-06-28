import api from './api';
import { User } from '@/types';

/**
 * Authentication (login/logout/refresh) is handled by Keycloak via
 * react-oidc-context. The backend only exposes the local profile of the
 * currently authenticated user (resolved from the verified Keycloak token).
 */
export const authService = {
    async getProfile(): Promise<User> {
        const response = await api.get<User>('/auth/profile');
        return response.data;
    },
};
