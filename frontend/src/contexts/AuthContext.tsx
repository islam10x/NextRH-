import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { useAuth as useOidc } from 'react-oidc-context';
import { User, UserRole } from '@/types';
import { authService } from '@/services/auth.service';
import { setAccessToken } from '@/lib/oidc';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  /** Redirects to Keycloak (Authorization Code + PKCE). */
  login: () => void;
  /** Redirects to Keycloak end-session, then back to /login. */
  logout: () => void;
  updateUser: (backendUser: any) => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
    avatar: backendUser.avatarUrl || backendUser.avatar || '',
    firstName,
    lastName,
    title: 'Employee', // Default, backend doesn't send yet
    yearsOfExperience: 0 // Default
  };
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const oidc = useOidc();
  const [user, setUser] = useState<User | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  // When Keycloak authentication state changes, sync the access token and
  // load the local user profile (the backend JIT-provisions and returns the
  // role synced from the token).
  useEffect(() => {
    if (oidc.isAuthenticated && oidc.user) {
      setAccessToken(oidc.user.access_token);
      setProfileLoading(true);
      authService.getProfile()
        .then((profile) => setUser(mapBackendUserToFrontend(profile)))
        .catch((error: any) => {
          console.error('Failed to fetch profile', error);
          if (error.response?.status === 401 || error.response?.status === 403) {
            setUser(null);
          }
        })
        .finally(() => setProfileLoading(false));
    } else {
      setAccessToken(null);
      setUser(null);
    }
  }, [oidc.isAuthenticated, oidc.user]);

  const login = useCallback(() => {
    void oidc.signinRedirect();
  }, [oidc]);

  const logout = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    void oidc.signoutRedirect();
  }, [oidc]);

  // The api.ts interceptor dispatches this when a request gets a 401
  // (access token expired and silent renew failed) → re-authenticate.
  useEffect(() => {
    const handleExpired = () => {
      void oidc.signinRedirect();
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, [oidc]);

  const updateUser = useCallback((backendUser: any) => {
    setUser(mapBackendUserToFrontend(backendUser));
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated: oidc.isAuthenticated && !!user,
    login,
    logout,
    updateUser,
    // Loading while Keycloak initializes, or while we fetch the local profile.
    isLoading: oidc.isLoading || (oidc.isAuthenticated && profileLoading && !user),
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
