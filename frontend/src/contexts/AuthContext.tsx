import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { User, UserRole } from '@/types';
import { mockEmployees, mockManagers, mockBidManager } from '@/data/mockData';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string, role?: UserRole) => Promise<boolean>;
  logout: () => void;
  switchRole: (role: UserRole) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Demo users for each role
const demoUsers: Record<UserRole, User> = {
  employee: {
    id: 'emp-001',
    email: 'john.smith@company.com',
    name: 'John Smith',
    role: 'employee',
    teamId: 'team-001',
    title: 'Senior Cloud Architect',
    yearsOfExperience: 8,
  },
  manager: {
    id: 'mgr-001',
    email: 'mark.anderson@company.com',
    name: 'Mark Anderson',
    role: 'manager',
    teamId: 'team-001',
    title: 'Cloud Engineering Manager',
    yearsOfExperience: 12,
  },
  bid_manager: {
    id: 'bid-001',
    email: 'alex.thompson@company.com',
    name: 'Alex Thompson',
    role: 'bid_manager',
    title: 'BID Manager',
    yearsOfExperience: 15,
  },
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);

  const login = useCallback(async (email: string, password: string, role?: UserRole): Promise<boolean> => {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // For demo purposes, accept any credentials
    // Use the role parameter to determine which user to log in as
    const selectedRole = role || 'employee';
    setUser(demoUsers[selectedRole]);
    return true;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  const switchRole = useCallback((role: UserRole) => {
    setUser(demoUsers[role]);
  }, []);

  const value = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    switchRole,
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
