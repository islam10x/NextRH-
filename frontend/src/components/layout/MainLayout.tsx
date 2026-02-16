import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { TopHeader } from './TopHeader';
import { useAuth } from '@/contexts/AuthContext';
import { UserRole } from '@/types';

interface MainLayoutProps {
  title?: string;
  showSearch?: boolean;
  requiredRole?: UserRole | UserRole[];
}

export const MainLayout: React.FC<MainLayoutProps> = ({ title, showSearch, requiredRole }) => {
  const { isAuthenticated, user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Check role if required
  if (requiredRole) {
    const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!roles.includes(user?.role as UserRole)) {
      // Redirect to appropriate dashboard based on user role
      const redirectPath = user?.role === 'employee'
        ? '/employee/dashboard'
        : user?.role === 'team_manager'
          ? '/manager/dashboard'
          : '/bid/dashboard';
      return <Navigate to={redirectPath} replace />;
    }
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <SidebarInset className="flex flex-col flex-1">
          <TopHeader title={title} showSearch={showSearch} />
          <main className="flex-1 p-6 overflow-auto">
            <div className="mx-auto max-w-7xl animate-fade-in">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
};

export default MainLayout;
