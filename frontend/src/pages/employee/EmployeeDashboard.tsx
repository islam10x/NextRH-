import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Training, Notification } from '@/types';
import { GraduationCap, Bell, Upload, FileText, Clock, Play, CheckCircle2, Link as LinkIcon, Trophy, TrendingUp, FolderKanban, Award, BookOpen, Crown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trainingService } from '@/services/training.service';
import { notificationService } from '@/services/notification.service';
import { scoringService, EmployeeScore, LeaderboardEntry } from '@/services/scoring.service';
import { Badge } from '@/components/ui/badge';
import api from '@/services/api';

const statusTone = (status?: string) => {
  if (status === 'completed') return 'bg-success/15 text-success border border-success/20';
  if (status === 'in_progress') return 'bg-primary/15 text-primary border border-primary/20';
  return 'bg-secondary text-secondary-foreground';
};

const EmployeeDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loadingTrainings, setLoadingTrainings] = useState(false);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [myScore, setMyScore] = useState<EmployeeScore | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [myProfileId, setMyProfileId] = useState('');

  const notificationsToShow = notifications.slice(0, 4);

  const loadTrainings = async () => {
    if (!user) {
      setTrainings([]);
      return;
    }
    setLoadingTrainings(true);
    try {
      const data = await trainingService.listMine();
      setTrainings(data);
    } catch {
      setTrainings([]);
    } finally {
      setLoadingTrainings(false);
    }
  };

  const loadNotifications = async () => {
    if (!user) {
      setNotifications([]);
      return;
    }
    setLoadingNotifications(true);
    try {
      const data = await notificationService.listMine();
      setNotifications(data);
    } catch {
      setNotifications([]);
    } finally {
      setLoadingNotifications(false);
    }
  };

  useEffect(() => {
    loadTrainings();
    loadNotifications();
    // Load score + leaderboard
    const currentYear = new Date().getFullYear();
    api.get('/cv/profile/me').then((res) => {
      const pid = res.data?.profile_id || res.data?.profileId;
      if (pid) {
        setMyProfileId(pid);
        scoringService.getScore(pid, currentYear).then((s) => setMyScore(s)).catch(() => {});
        scoringService.getLeaderboard(currentYear).then((lb) => setLeaderboard(lb)).catch(() => {});
      }
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    const handler = () => loadNotifications();
    window.addEventListener('notifications:updated', handler);
    return () => window.removeEventListener('notifications:updated', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trainingCounts = {
    total: trainings.length,
    inProgress: trainings.filter((t) => t.status === 'in_progress').length,
    completed: trainings.filter((t) => t.status === 'completed').length,
  };

  const quickActions = [
    { label: 'Upload CV', onClick: () => navigate('/employee/cv-upload') },
    { label: 'Add Certification', onClick: () => navigate('/employee/certifications') },
    { label: 'View CV', onClick: () => navigate('/employee/cv-preview') },
  ];

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Welcome back, {user?.name?.split(' ')[0] || 'there'}!</h1>
          <p className="text-muted-foreground">Track your trainings and notifications</p>
        </div>
        <div className="flex gap-2">
          {quickActions.map((action) => (
            <Button key={action.label} variant="outline" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Score Widget — always visible, defaults to 0 */}
      <Card className="border-2 border-primary/20 animate-fade-in cursor-pointer" onClick={() => navigate('/employee/scoring')}>
        <CardContent className="flex items-center gap-6 pt-6 pb-4">
          <div className="flex items-center gap-3">
            <Trophy className="h-8 w-8 text-yellow-500" />
            <div>
              <p className="text-sm text-muted-foreground">Final Score {new Date().getFullYear()}</p>
              <p className="text-3xl font-bold">{Number(myScore?.finalScore ?? 0).toFixed(1)}</p>
            </div>
          </div>
          <div className="hidden md:flex gap-6 ml-auto text-center">
            <div><p className="text-xs text-muted-foreground">Projects</p><p className="font-semibold">{Number(myScore?.projectScore ?? 0).toFixed(1)}</p></div>
            <div><p className="text-xs text-muted-foreground">Certif.</p><p className="font-semibold">{Number(myScore?.certificationScore ?? 0).toFixed(1)}</p></div>
            <div><p className="text-xs text-muted-foreground">Trainings</p><p className="font-semibold">{Number(myScore?.trainingScore ?? 0).toFixed(1)}</p></div>
            <div><p className="text-xs text-muted-foreground">Workshops</p><p className="font-semibold">{Number(myScore?.formationScore ?? 0).toFixed(1)}</p></div>
          </div>
          {myScore?.rankGlobal ? (
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Rank</p>
              <p className="text-xl font-bold">#{myScore.rankGlobal}</p>
              {myScore.percentile != null && <p className="text-xs text-muted-foreground">Ahead of {Number(myScore.percentile).toFixed(0)}% of scored employees</p>}
            </div>
          ) : (
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Rank</p>
              <p className="text-xs text-muted-foreground">—</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="animate-fade-in" style={{ animationDelay: '0ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Assigned Trainings</CardTitle>
            <GraduationCap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{trainingCounts.total}</div>
            <p className="text-xs text-muted-foreground mt-1">Total trainings assigned to you</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">In Progress</CardTitle>
            <Play className="h-4 w-4 text-accent" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{trainingCounts.inProgress}</div>
            <p className="text-xs text-muted-foreground mt-1">Currently underway</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{trainingCounts.completed}</div>
            <p className="text-xs text-muted-foreground mt-1">Finished trainings</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Trainings List */}
        <Card className="lg:col-span-2 animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader>
            <CardTitle className="text-lg">Your Trainings</CardTitle>
            <CardDescription>Assigned trainings and their status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingTrainings ? (
              <p className="text-sm text-muted-foreground">Loading trainings...</p>
            ) : trainings.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <GraduationCap className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No trainings assigned yet</p>
              </div>
            ) : (
              trainings.map((t) => (
                <div key={t.id} className="p-3 rounded-lg bg-muted/40 border border-border">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <GraduationCap className="h-4 w-4 text-primary" />
                      <span className="font-medium">{t.name}</span>
                    </div>
                    <span className={`px-2 py-1 rounded-md text-xs font-semibold ${statusTone(t.status)}`}>
                      {t.status || 'assigned'}
                    </span>
                  </div>
                  {t.provider && <p className="text-xs text-muted-foreground">{t.provider}</p>}
                  <div className="flex gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                    <span>Due: {t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : 'n/a'}</span>
                    {t.trainingUrl && (
                      <a href={t.trainingUrl} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                        <LinkIcon className="h-3 w-3" /> Link
                      </a>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Notifications Panel */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Notifications</CardTitle>
              <Bell className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingNotifications ? (
              <p className="text-sm text-muted-foreground">Loading notifications...</p>
            ) : notificationsToShow.length > 0 ? (
              notificationsToShow.map((notif) => (
                <div
                  key={notif.id}
                  className={`p-3 rounded-lg border-l-4 ${
                    notif.type === 'error'
                      ? 'border-l-destructive bg-destructive/5'
                      : notif.type === 'warning'
                      ? 'border-l-warning bg-warning/5'
                      : 'border-l-primary bg-primary/5'
                  }`}
                >
                  <p className="font-medium text-sm">{notif.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">{notif.message}</p>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No new notifications</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Leaderboard / Ranking */}
      {leaderboard.length > 0 && (
        <Card className="animate-fade-in" style={{ animationDelay: '450ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Crown className="h-5 w-5 text-yellow-500" />
                  Leaderboard {new Date().getFullYear()}
                </CardTitle>
                <CardDescription>Your position among scored employees</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => navigate('/employee/scoring')}>
                View details
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {leaderboard.slice(0, 5).map((entry) => {
                const isMe = entry.profileId === myProfileId;
                return (
                  <div
                    key={entry.profileId}
                    className={`flex items-center justify-between p-2.5 rounded-lg ${
                      isMe ? 'bg-primary/10 border border-primary/20' : 'bg-muted/40'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={entry.rank <= 3 ? 'default' : 'secondary'}
                        className={entry.rank === 1 ? 'bg-yellow-500' : entry.rank === 2 ? 'bg-gray-400' : entry.rank === 3 ? 'bg-amber-600' : ''}
                      >
                        #{entry.rank}
                      </Badge>
                      <span className={`text-sm ${isMe ? 'font-bold' : 'font-medium'}`}>
                        {entry.employeeName}{isMe ? ' (you)' : ''}
                      </span>
                    </div>
                    <span className="text-sm font-semibold">{entry.finalScore.toFixed(1)} pts</span>
                  </div>
                );
              })}
              {/* Show user's position if not in top 5 */}
              {myProfileId && !leaderboard.slice(0, 5).some((e) => e.profileId === myProfileId) && (() => {
                const myEntry = leaderboard.find((e) => e.profileId === myProfileId);
                if (!myEntry) return null;
                return (
                  <>
                    <div className="text-center text-xs text-muted-foreground py-1">···</div>
                    <div className="flex items-center justify-between p-2.5 rounded-lg bg-primary/10 border border-primary/20">
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary">#{myEntry.rank}</Badge>
                        <span className="text-sm font-bold">{myEntry.employeeName} (you)</span>
                      </div>
                      <span className="text-sm font-semibold">{myEntry.finalScore.toFixed(1)} pts</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </CardContent>
        </Card>
      )}

      {/* CV Status */}
      <Card className="animate-fade-in" style={{ animationDelay: '500ms' }}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">CV Status</CardTitle>
              <CardDescription>Your current CV information</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/employee/cv-preview')}>
              <FileText className="h-4 w-4 mr-2" />
              View CV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-muted">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1">
              <p className="font-medium">{user?.name || 'Your Name'}_CV.pdf</p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last updated: Not available
              </div>
            </div>
            <Button onClick={() => navigate('/employee/cv-upload')}>
              <Upload className="h-4 w-4 mr-2" />
              Update CV
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default EmployeeDashboard;
