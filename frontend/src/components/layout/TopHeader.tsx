import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Bell,
  Search,
  Award,
  AlertTriangle,
  BookOpen,
  CheckCircle,
  FileText,
  CheckCheck,
  Briefcase,
  Users,
  UserPlus,
  X,
  Sun,
  Moon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { notificationService } from '@/services/notification.service';
import { Notification } from '@/types';
import { useNavigate } from 'react-router-dom';

interface TopHeaderProps {
  title?: string;
  showSearch?: boolean;
}

/** Returns a human-readable relative time string */
function timeAgo(dateStr: string): string {
  const now = new Date();
  const normalized = dateStr.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}j`;
  return date.toLocaleDateString('fr-FR');
}

/** Returns an icon component based on notification type */
function getNotificationIcon(type?: string) {
  switch (type) {
    case 'certification_expiring':
      return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    case 'certification_expired':
      return <Award className="h-4 w-4 text-red-500 shrink-0" />;
    case 'training_assigned':
      return <BookOpen className="h-4 w-4 text-blue-500 shrink-0" />;
    case 'training_started':
      return <BookOpen className="h-4 w-4 text-indigo-500 shrink-0" />;
    case 'training_completed':
      return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />;
    case 'project_assigned':
      return <Briefcase className="h-4 w-4 text-blue-500 shrink-0" />;
    case 'project_updated':
      return <Briefcase className="h-4 w-4 text-indigo-500 shrink-0" />;
    case 'cross_team_member_requested':
      return <UserPlus className="h-4 w-4 text-purple-500 shrink-0" />;
    case 'cross_team_member_selected':
      return <Users className="h-4 w-4 text-green-500 shrink-0" />;
    case 'cross_team_member_rejected':
      return <Users className="h-4 w-4 text-red-500 shrink-0" />;
    case 'external_member_evaluation_requested':
      return <FileText className="h-4 w-4 text-amber-500 shrink-0" />;
    case 'cv_update_needed':
      return <FileText className="h-4 w-4 text-orange-500 shrink-0" />;
    default:
      return <Bell className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

function useDarkMode() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('theme');
    if (stored) return stored === 'dark';
    return document.documentElement.classList.contains('dark');
  });

  const toggle = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
      }
      return next;
    });
  }, []);

  return { isDark, toggle };
}

export const TopHeader: React.FC<TopHeaderProps> = ({ title, showSearch = false }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const { isDark, toggle: toggleDark } = useDarkMode();

  const loadNotifications = useCallback(async () => {
    if (!user) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    try {
      const [data, count] = await Promise.all([
        notificationService.listMine(),
        notificationService.getUnreadCount(),
      ]);
      setNotifications(data);
      setUnreadCount(count);
    } catch (error: any) {
      setNotifications([]);
      setUnreadCount(0);
      // If unauthorized, stop polling to avoid infinite loops during logout
      if (error.response?.status === 401) {
        console.warn('Unauthorized notification fetch. Stopping poll.');
        if (window._notificationInterval) {
          clearInterval(window._notificationInterval);
          delete window._notificationInterval;
        }
      }
    }
  }, [user]);

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000);
    window._notificationInterval = interval;
    
    const handleUpdate = () => loadNotifications();
    window.addEventListener('notifications:updated', handleUpdate);
    return () => {
      clearInterval(interval);
      delete window._notificationInterval;
      window.removeEventListener('notifications:updated', handleUpdate);
    };
  }, [loadNotifications]);

  const markAsRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    notificationService.markRead(id).catch(() => {});
  };

  const markAllAsRead = async () => {
    // Clear the badge count but keep individual notification read-state intact visually
    // so the user can still see which ones are new (bold) when the dropdown opens.
    // The backend is notified; on next poll they will no longer appear unread.
    setUnreadCount(0);
    notificationService.markAllRead().catch(() => {});
  };

  const navigateForNotification = (notification: Notification) => {
    const isCert =
      notification.notificationType === 'certification_expiring' ||
      notification.notificationType === 'certification_expired';
    const isTraining =
      notification.notificationType === 'training_assigned' ||
      notification.notificationType === 'training_started' ||
      notification.notificationType === 'training_completed';
    const isProject =
      notification.notificationType === 'project_assigned' ||
      notification.notificationType === 'project_updated';
    const isCrossTeam =
      notification.notificationType === 'cross_team_member_requested' ||
      notification.notificationType === 'cross_team_member_selected' ||
      notification.notificationType === 'cross_team_member_rejected';
    const isExternalEval =
      notification.notificationType === 'external_member_evaluation_requested';

    if (isCert) {
      navigate(
        user?.role === 'team_manager'
          ? '/manager/certifications'
          : '/employee/certifications',
      );
    } else if (isTraining) {
      navigate(
        user?.role === 'team_manager'
          ? '/manager/trainings'
          : '/employee/training-projects?tab=trainings',
      );
    } else if (isProject) {
      navigate(
        user?.role === 'team_manager'
          ? '/manager/projects'
          : '/employee/training-projects?tab=projects',
      );
    } else if (isCrossTeam) {
      const params = new URLSearchParams({ tab: 'cross-team' });
      if (notification.relatedEntityId) params.set('requestId', notification.relatedEntityId);
      navigate(`/manager/projects?${params.toString()}`);
    } else if (isExternalEval) {
      const params = new URLSearchParams();
      if (notification.relatedEntityId) {
        params.set('recordId', notification.relatedEntityId);
        params.set('panel', 'external-review');
      }
      navigate(`/manager/scoring${params.toString() ? `?${params.toString()}` : ''}`);
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />

      {title && (
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        </div>
      )}

      {showSearch && (
        <div className="flex-1 max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Rechercher..."
              className="pl-10 bg-muted/50 border-0 focus-visible:ring-1"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 ml-auto">
        <Button variant="ghost" size="icon" onClick={toggleDark} title={isDark ? 'Mode clair' : 'Mode sombre'}>
          {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
        <DropdownMenu onOpenChange={(open) => { if (open) markAllAsRead(); }}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative">
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <Badge
                  className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
                  variant="destructive"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-96 bg-popover max-h-[480px] overflow-y-auto">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Notifications</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      markAllAsRead();
                    }}
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Tout marquer lu
                  </Button>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
                Aucune notification
              </div>
            ) : (
              [...notifications.filter((notification) => !notification.read), ...notifications.filter((notification) => notification.read)]
                .slice(0, 8)
                .map((notification) => (
                <DropdownMenuItem
                  key={notification.id}
                  className={`cursor-pointer rounded-xl p-0 transition-colors focus:bg-transparent ${
                    notification.notificationType === 'cross_team_member_requested'
                      ? !notification.read
                        ? 'bg-transparent'
                        : 'bg-transparent'
                      : !notification.read
                        ? 'bg-transparent'
                        : 'bg-transparent'
                  }`}
                  onSelect={() => {
                    markAsRead(notification.id);
                    navigateForNotification(notification);
                  }}
                >
                  <div
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 shadow-sm transition-colors ${
                      notification.notificationType === 'cross_team_member_requested'
                        ? !notification.read
                          ? 'border-purple-200 bg-purple-50 hover:bg-purple-100/70 dark:border-purple-800 dark:bg-purple-950/30 dark:hover:bg-purple-900/40'
                          : 'border-transparent bg-purple-50/50 hover:bg-purple-100/50 dark:bg-purple-950/20 dark:hover:bg-purple-900/30'
                        : !notification.read
                          ? 'border-l-4 border-l-primary border-primary/15 bg-muted/70 hover:bg-muted'
                          : 'border-transparent bg-background hover:bg-muted/40'
                    }`}
                  >
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background/80 shadow-sm">
                      {getNotificationIcon(notification.notificationType)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            {!notification.read && (
                              <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
                            )}
                            <span
                              className={`line-clamp-1 text-sm ${
                                !notification.read
                                  ? 'font-semibold text-foreground'
                                  : 'font-medium text-foreground/90'
                              }`}
                            >
                              {notification.title}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                            {notification.message}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-start gap-2">
                          <span className="rounded-full bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm">
                            {timeAgo(notification.createdAt)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 rounded-full p-0 text-muted-foreground hover:text-destructive shrink-0"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await notificationService.remove(notification.id);
                                setNotifications((prev) =>
                                  prev.filter((n) => n.id !== notification.id),
                                );
                                if (!notification.read) {
                                  setUnreadCount((c) => Math.max(0, c - 1));
                                }
                                window.dispatchEvent(new Event('notifications:updated'));
                                } catch {
                                  loadNotifications();
                                }
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};

export default TopHeader;
