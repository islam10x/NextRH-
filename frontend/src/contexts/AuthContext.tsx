import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { User, UserRole } from '@/types';
import { authService } from '@/services/auth.service';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<User | null>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    const savedUser = sessionStorage.getItem('user');
    return savedUser ? JSON.parse(savedUser) : null;
  });
  const [isLoading, setIsLoading] = useState(!sessionStorage.getItem('access_token'));

  const mapBackendUserToFrontend = (backendUser: any): User => {
    const firstName = backendUser.firstName || '';
    const lastName = backendUser.lastName || '';
    const name = (firstName || lastName)
      ? `${firstName} ${lastName}`.trim()
      : backendUser.email;

    return {
      id: backendUser.id || backendUser.user_id,
      email: backendUser.email,
      name,
      role: backendUser.role === 'team_manager' ? 'manager' : backendUser.role as UserRole,
      title: 'Employee', // Default, backend doesn't send yet
      yearsOfExperience: 0 // Default
    };
  };

  const initAuth = async () => {
    if (authService.isAuthenticated()) {
      try {
        const profile = await authService.getProfile();
        setUser(mapBackendUserToFrontend(profile));
      } catch (error) {
        console.error('Failed to fetch profile', error);
        authService.logout();
      }
    }
    setIsLoading(false);
  };

  useEffect(() => {
    initAuth();
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User | null> => {
    try {
      const response = await authService.login(email, password);

      sessionStorage.setItem('access_token', response.access_token);
      sessionStorage.setItem('refresh_token', response.refresh_token);

      const mappedUser = mapBackendUserToFrontend(response.user);
      sessionStorage.setItem('user', JSON.stringify(mappedUser));
      setUser(mappedUser);
      return mappedUser;
    } catch (error) {
      console.error('Login failed', error);
      return null;
    }
  }, []);

  const logout = useCallback(() => {
    authService.logout(); // Clears storage and calls API
    setUser(null);
  }, []);

  const value = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    isLoading
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
