import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  LayoutDashboard,
  FileText,
  Award,
  GraduationCap,
  Eye,
  Users,
  Search,
  MessageSquare,
  FileOutput,
  BarChart3,
  LogOut,
  Settings,
  ChevronRight,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  title: string;
  url: string;
  icon: React.ElementType;
}

const employeeNavItems: NavItem[] = [
  { title: 'Dashboard', url: '/employee/dashboard', icon: LayoutDashboard },
  { title: 'Upload CV', url: '/employee/cv-upload', icon: FileText },
  { title: 'Certifications', url: '/employee/certifications', icon: Award },
  { title: 'Training & Projects', url: '/employee/training-projects', icon: GraduationCap },
  { title: 'CV Preview', url: '/employee/cv-preview', icon: Eye },
];

const managerNavItems: NavItem[] = [
  { title: 'Team Dashboard', url: '/manager/dashboard', icon: LayoutDashboard },
  { title: 'Team Members', url: '/manager/team', icon: Users },
  { title: 'Certification Tracking', url: '/manager/certifications', icon: Award },
];

const bidManagerNavItems: NavItem[] = [
  { title: 'BID Dashboard', url: '/bid/dashboard', icon: LayoutDashboard },
  { title: 'Employee Directory', url: '/bid/directory', icon: Search },
  { title: 'AI Assistant', url: '/bid/ai-chat', icon: MessageSquare },
  { title: 'Generate CV', url: '/bid/cv-generation', icon: FileOutput },
];

export const AppSidebar: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const getNavItems = (): NavItem[] => {
    switch (user?.role) {
      case 'employee':
        return employeeNavItems;
      case 'manager':
        return managerNavItems;
      case 'bid_manager':
        return bidManagerNavItems;
      default:
        return [];
    }
  };

  const getRoleLabel = (): string => {
    switch (user?.role) {
      case 'employee':
        return 'Employee Portal';
      case 'manager':
        return 'Team Manager';
      case 'bid_manager':
        return 'BID Manager';
      default:
        return 'Portal';
    }
  };

  const navItems = getNavItems();
  const isActive = (url: string) => location.pathname === url;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <Sidebar className="border-r-0">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <FileText className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-sidebar-foreground">CV Manager</span>
            <span className="text-xs text-sidebar-foreground/60">{getRoleLabel()}</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/50 text-xs uppercase tracking-wider">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    tooltip={item.title}
                  >
                    <a
                      href={item.url}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(item.url);
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                        isActive(item.url)
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 px-2 py-6 text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {user?.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-1 flex-col items-start text-left">
                <span className="text-sm font-medium">{user?.name}</span>
                <span className="text-xs text-sidebar-foreground/60">{user?.title}</span>
              </div>
              <ChevronRight className="h-4 w-4 text-sidebar-foreground/50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 bg-popover">
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

export default AppSidebar;
