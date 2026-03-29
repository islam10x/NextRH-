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
  const date = new Date(dateStr);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
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
    case 'cv_update_needed':
      return <FileText className="h-4 w-4 text-orange-500 shrink-0" />;
    default:
      return <Bell className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

export const TopHeader: React.FC<TopHeaderProps> = ({ title, showSearch = false }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

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
    } catch {
      setNotifications([]);
      setUnreadCount(0);
    }
  }, [user]);

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000);
    const handleUpdate = () => loadNotifications();
    window.addEventListener('notifications:updated', handleUpdate);
    return () => {
      clearInterval(interval);
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
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
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
          : '/employee/training-projects',
      );
    } else if (isProject) {
      navigate(
        user?.role === 'team_manager'
          ? '/manager/projects'
          : '/employee/training-projects',
      );
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
              placeholder="Search..."
              className="pl-10 bg-muted/50 border-0 focus-visible:ring-1"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 ml-auto">
        <DropdownMenu>
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
                  <Badge variant="secondary" className="text-xs">
                    {unreadCount} new
                  </Badge>
                )}
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
                    Mark all read
                  </Button>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
                No notifications
              </div>
            ) : (
              notifications.slice(0, 8).map((notification) => (
                <DropdownMenuItem
                  key={notification.id}
                  className={`flex items-start gap-3 p-3 cursor-pointer rounded-md transition-colors ${
                    !notification.read
                      ? 'bg-muted/60 hover:bg-muted/80'
                      : 'hover:bg-muted/30'
                  }`}
                  onSelect={() => {
                    markAsRead(notification.id);
                    navigateForNotification(notification);
                  }}
                >
                  <div className="mt-0.5">
                    {getNotificationIcon(notification.notificationType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-sm truncate ${
                          !notification.read
                            ? 'font-semibold text-foreground'
                            : 'font-normal text-muted-foreground'
                        }`}
                      >
                        {notification.title}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive shrink-0"
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
                          } catch {}
                        }}
                      >
                        x
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {notification.message}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 mt-1 block">
                      {timeAgo(notification.createdAt)}
                    </span>
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
