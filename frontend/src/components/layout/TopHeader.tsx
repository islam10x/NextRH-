import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Bell, Search } from 'lucide-react';
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

export const TopHeader: React.FC<TopHeaderProps> = ({ title, showSearch = false }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const unreadCount = notifications.filter((n) => !n.read).length;

  const loadNotifications = async () => {
    if (!user) {
      setNotifications([]);
      return;
    }
    try {
      const data = await notificationService.listMine();
      setNotifications(data);
    } catch {
      setNotifications([]);
    }
  };

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, 30000);
    const handleUpdate = () => loadNotifications();
    window.addEventListener('notifications:updated', handleUpdate);
    return () => {
      clearInterval(interval);
      window.removeEventListener('notifications:updated', handleUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const markAsRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    notificationService.markRead(id).catch(() => {});
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
                  {unreadCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 bg-popover">
            <DropdownMenuLabel className="flex items-center justify-between">
              Notifications
              {unreadCount > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {unreadCount} new
                </Badge>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.slice(0, 5).map((notification) => (
              <DropdownMenuItem
                key={notification.id}
                className={`flex flex-col items-start gap-2 p-3 cursor-pointer rounded-md ${
                  !notification.read ? 'bg-muted/60' : ''
                }`}
                onSelect={() => {
                  markAsRead(notification.id);
                  const isManagerTraining =
                    notification.notificationType === 'training_assigned' ||
                    notification.notificationType === 'training_started' ||
                    notification.notificationType === 'training_completed';
                  navigate(isManagerTraining ? '/manager/trainings' : '/employee/training-projects');
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span
                    className={`text-sm ${
                      !notification.read ? 'font-bold text-foreground' : 'font-normal text-muted-foreground'
                    }`}
                  >
                    {notification.title}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-destructive hover:text-destructive shrink-0"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await notificationService.remove(notification.id);
                        setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
                        window.dispatchEvent(new Event('notifications:updated'));
                      } catch {}
                    }}
                  >
                    ×
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground line-clamp-2">{notification.message}</span>
              </DropdownMenuItem>
            ))}
            {notifications.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No notifications
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};

export default TopHeader;


