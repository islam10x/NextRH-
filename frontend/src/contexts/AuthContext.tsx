import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { User, UserRole } from '@/types';
import { authService } from '@/services/auth.service';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<User | null>;
  logout: () => void;
  updateUser: (backendUser: any) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    const savedUser = sessionStorage.getItem('user');
    return savedUser ? JSON.parse(savedUser) : null;
  });
  const [isLoading, setIsLoading] = useState(true);

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
      role: backendUser.role as UserRole,
      title: 'Employee', // Default, backend doesn't send yet
      yearsOfExperience: 0 // Default
    };
  };

  const initAuth = async () => {
    if (authService.isAuthenticated()) {
      try {
        const profile = await authService.getProfile();
        setUser(mapBackendUserToFrontend(profile));
      } catch (error: any) {
        console.error('Failed to fetch profile', error);
        // Only logout on explicit authentication failures (401, 403)
        // If it's a network error or other, keep the user logged in with current data
        if (error.response?.status === 401 || error.response?.status === 403) {
          authService.logout();
          setUser(null);
        }
      }
    }
    setIsLoading(false);
  };



  const login = useCallback(async (email: string, password: string): Promise<User | null> => {
    try {
      const response = await authService.login(email, password);

      sessionStorage.setItem('access_token', response.access_token);
      // refresh_token is stored as an HTTPOnly cookie by the server — no JS access needed

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

  useEffect(() => {
    // Listen for logout events from the API interceptor
    const handleLogoutEvent = () => {
      console.log('Logout event received from API interceptor');
      logout();
    };

    window.addEventListener('auth:logout', handleLogoutEvent);
    initAuth();

    return () => {
      window.removeEventListener('auth:logout', handleLogoutEvent);
    };
  }, [logout]);

  const updateUser = useCallback((backendUser: any) => {
    const mappedUser = mapBackendUserToFrontend(backendUser);
    sessionStorage.setItem('user', JSON.stringify(mappedUser));
    setUser(mappedUser);
  }, []);

  const value = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    updateUser,
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
