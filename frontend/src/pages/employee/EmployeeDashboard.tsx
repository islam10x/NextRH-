import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Training, Notification } from '@/types';
import {
  GraduationCap, Bell, Upload, FileText, Play, CheckCircle2,
  Link as LinkIcon, Trophy, TrendingUp, Award, Crown, Users,
  ChevronRight, AlertCircle, Calendar, BarChart3,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trainingService } from '@/services/training.service';
import { notificationService } from '@/services/notification.service';
import { cn } from '@/lib/utils';
import { scoringService, EmployeeScore, LeaderboardEntry, ScoringTarget } from '@/services/scoring.service';
import { teamService, EmployeeTeamInfo } from '@/services/team.service';
import api from '@/services/api';

const statusConfig: Record<string, { label: string; className: string }> = {
  completed: { label: 'Terminée', className: 'bg-success/15 text-success border border-success/20' },
  in_progress: { label: 'En cours', className: 'bg-primary/15 text-primary border border-primary/20' },
  assigned: { label: 'Assignée', className: 'bg-secondary text-secondary-foreground' },
};

const CURRENT_YEAR = new Date().getFullYear();

const EmployeeDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [myScore, setMyScore] = useState<EmployeeScore | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [myProfileId, setMyProfileId] = useState('');
  const [teamInfo, setTeamInfo] = useState<EmployeeTeamInfo | null>(null);
  const [cvUploaded, setCvUploaded] = useState<boolean | null>(null);
  const [certCount, setCertCount] = useState(0);
  const [certTarget, setCertTarget] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const handleMarkRead = async (id: string) => {
    if (notifications.find((n) => n.id === id)?.read) return;
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    notificationService.markRead(id).catch(() => {});
  };

  useEffect(() => {
    if (!user) return;
    Promise.all([
      trainingService.listMine().catch(() => [] as Training[]),
      notificationService.listMine().catch(() => [] as Notification[]),
      teamService.getMyTeamInfo().catch(() => null),
      api.get('/cv/profile/me').catch(() => null),
    ]).then(([tData, nData, team, profileRes]) => {
      setTrainings(tData);
      setNotifications(nData);
      setTeamInfo(team);

      const pid = profileRes?.data?.profile_id || profileRes?.data?.profileId;
      setCvUploaded(!!pid);

      if (pid) {
        setMyProfileId(pid);
        Promise.all([
          scoringService.getScore(pid, CURRENT_YEAR).catch(() => null),
          scoringService.getLeaderboard(CURRENT_YEAR).catch(() => [] as LeaderboardEntry[]),
          scoringService.getTarget(pid, CURRENT_YEAR).catch(() => null),
        ]).then(([sc, lb, tg]) => {
          setMyScore(sc);
          setLeaderboard(lb);
          setCertTarget(tg?.certificationTarget ?? null);
        });
      }

      const certs = profileRes?.data?.certifications || [];
      const activeThisYear = certs.filter((c: any) => {
        if (c.status !== 'active') return false;
        const year = c.issueDate ? new Date(c.issueDate).getFullYear() : null;
        return year === CURRENT_YEAR;
      }).length;
      setCertCount(activeThisYear);
    }).finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    const handler = () => notificationService.listMine().then(setNotifications).catch(() => {});
    window.addEventListener('notifications:updated', handler);
    return () => window.removeEventListener('notifications:updated', handler);
  }, []);

  const trainingCounts = {
    total: trainings.length,
    inProgress: trainings.filter((t) => t.status === 'in_progress').length,
    completed: trainings.filter((t) => t.status === 'completed').length,
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  const recentNotifs = [...notifications.filter((n) => !n.read), ...notifications.filter((n) => n.read)].slice(0, 4);

  const certProgress = certTarget && certTarget > 0 ? Math.min(100, (certCount / certTarget) * 100) : 0;
  const certAchieved = certTarget !== null && certCount >= certTarget;

  const myLeaderboardEntry = leaderboard.find((e) => e.profileId === myProfileId);
  const top5 = leaderboard.slice(0, 5);
  const myInTop5 = top5.some((e) => e.profileId === myProfileId);

  return (
    <div className="space-y-6 pb-8">

      {/* ── Welcome ── */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          {loading ? (
            <Skeleton className="h-8 w-56 mb-2" />
          ) : (
            <h1 className="text-2xl font-bold text-foreground">
              Bonjour, {user?.name?.split(' ')[0] || ''} 👋
            </h1>
          )}
          {loading ? (
            <Skeleton className="h-4 w-40" />
          ) : teamInfo ? (
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              <span>{teamInfo.teamName}</span>
              {teamInfo.managerName && <span>· {teamInfo.managerName}</span>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Tableau de bord employé · {CURRENT_YEAR}</p>
          )}
        </div>

        {/* CV upload CTA — only when no CV */}
        {!loading && cvUploaded === false && (
          <Button onClick={() => navigate('/employee/cv-upload')} className="shrink-0 gap-2">
            <Upload className="h-4 w-4" />
            Importer votre CV
          </Button>
        )}
      </div>

      {/* ── No CV Alert Banner ── */}
      {!loading && cvUploaded === false && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-warning">Votre CV n'est pas encore importé</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sans CV, votre profil n'est pas visible par les managers BID et vous ne pouvez pas être scoré.
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 border-warning/40 hover:bg-warning/10 text-xs"
            onClick={() => navigate('/employee/cv-upload')}>
            Importer <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      )}

      {/* ── Score Hero Card ── */}
      <Card
        className="cursor-pointer hover:shadow-md transition-shadow border-primary/20 bg-gradient-to-br from-background to-primary/5 animate-fade-in"
        onClick={() => navigate('/employee/scoring')}
      >
        <CardContent className="p-5">
          {loading ? (
            <div className="flex items-center gap-5">
              <Skeleton className="h-16 w-16 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-8 w-20" />
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-5">
              {/* Score ring */}
              <div className="flex items-center gap-4">
                <div className="relative flex items-center justify-center">
                  <svg className="h-20 w-20 -rotate-90" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="15.9" fill="none" stroke="hsl(var(--muted))" strokeWidth="2.5" />
                    <circle
                      cx="18" cy="18" r="15.9" fill="none"
                      stroke="hsl(var(--primary))" strokeWidth="2.5"
                      strokeDasharray={`${Math.min(100, Number(myScore?.finalScore ?? 0))} 100`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <Trophy className="h-4 w-4 text-yellow-500" />
                    <span className="text-lg font-bold leading-none mt-0.5">{Number(myScore?.finalScore ?? 0).toFixed(0)}</span>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Score Final {CURRENT_YEAR}</p>
                  <p className="text-3xl font-bold">{Number(myScore?.finalScore ?? 0).toFixed(1)}</p>
                  {myLeaderboardEntry && (
                    <Badge variant="secondary" className="mt-1 text-xs gap-1">
                      <TrendingUp className="h-3 w-3" />
                      Rang #{myLeaderboardEntry.rank}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Pillar breakdown */}
              <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Projets', value: myScore?.projectScore, icon: <BarChart3 className="h-3.5 w-3.5" /> },
                  { label: 'Certif.', value: myScore?.certificationScore, icon: <Award className="h-3.5 w-3.5" /> },
                  { label: 'Trainings', value: myScore?.trainingScore, icon: <GraduationCap className="h-3.5 w-3.5" /> },
                  { label: 'Formations', value: myScore?.formationScore, icon: <FileText className="h-3.5 w-3.5" /> },
                ].map(({ label, value, icon }) => (
                  <div key={label} className="rounded-lg bg-muted/40 p-2.5 text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">{icon}<span className="text-xs">{label}</span></div>
                    <p className="font-semibold text-sm">{Number(value ?? 0).toFixed(1)}</p>
                  </div>
                ))}
              </div>

              <ChevronRight className="h-5 w-5 text-muted-foreground hidden sm:block shrink-0" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Stats Grid ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Trainings total */}
        <Card className="animate-fade-in" style={{ animationDelay: '80ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Formations assignées</CardTitle>
            <GraduationCap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-12" /> : <div className="text-3xl font-bold">{trainingCounts.total}</div>}
            <p className="text-xs text-muted-foreground mt-1">
              {loading ? '' : `${trainingCounts.inProgress} en cours · ${trainingCounts.completed} terminées`}
            </p>
            {!loading && trainingCounts.total > 0 && (
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-success transition-all"
                  style={{ width: `${trainingCounts.total > 0 ? (trainingCounts.completed / trainingCounts.total) * 100 : 0}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* In progress */}
        <Card className="animate-fade-in" style={{ animationDelay: '160ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">En cours</CardTitle>
            <Play className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-12" /> : <div className="text-3xl font-bold">{trainingCounts.inProgress}</div>}
            <p className="text-xs text-muted-foreground mt-1">Formation(s) en cours</p>
          </CardContent>
        </Card>

        {/* Completed */}
        <Card className="animate-fade-in" style={{ animationDelay: '240ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Terminées</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-12" /> : <div className="text-3xl font-bold">{trainingCounts.completed}</div>}
            <p className="text-xs text-muted-foreground mt-1">Formation(s) complétée(s)</p>
          </CardContent>
        </Card>

        {/* Certifications */}
        <Card
          className="animate-fade-in cursor-pointer hover:shadow-sm transition-shadow"
          style={{ animationDelay: '320ms' }}
          onClick={() => navigate('/employee/certifications')}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Certifications</CardTitle>
            <Award className={cn('h-4 w-4', certAchieved ? 'text-success' : 'text-primary')} />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <div className={cn('text-3xl font-bold', certAchieved && 'text-success')}>{certCount}</div>
            )}
            {!loading && certTarget !== null ? (
              <div className="mt-2 space-y-1">
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all', certAchieved ? 'bg-success' : 'bg-amber-500')}
                    style={{ width: `${certProgress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {certCount} / {certTarget} objectif {certAchieved && '✓'}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">Cette année</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Main 2-col grid ── */}
      <div className="grid gap-6 lg:grid-cols-3">

        {/* Trainings List */}
        <Card className="lg:col-span-2 animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-base">Mes formations</CardTitle>
              <CardDescription>Formations assignées et leur statut</CardDescription>
            </div>
            <Button variant="ghost" size="sm" className="text-xs shrink-0" onClick={() => navigate('/employee/training-projects')}>
              Voir tout <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))
            ) : trainings.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">Aucune formation assignée</p>
                <p className="text-xs mt-1 max-w-xs mx-auto">Votre manager vous assignera des formations ici dès qu'elles seront disponibles.</p>
              </div>
            ) : (
              trainings.slice(0, 5).map((t) => {
                const cfg = statusConfig[t.status ?? 'assigned'] ?? statusConfig.assigned;
                return (
                  <div key={t.id} className="flex items-start justify-between p-3 rounded-lg bg-muted/30 border border-transparent hover:border-border transition-colors gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <GraduationCap className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{t.name}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                          {t.provider && <span>{t.provider}</span>}
                          {t.dueDate && (
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {new Date(t.dueDate).toLocaleDateString('fr-FR')}
                            </span>
                          )}
                          {t.trainingUrl && (
                            <a href={t.trainingUrl} target="_blank" rel="noreferrer"
                              className="text-primary inline-flex items-center gap-1 hover:underline"
                              onClick={(e) => e.stopPropagation()}>
                              <LinkIcon className="h-3 w-3" /> Accéder
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${cfg.className}`}>
                      {cfg.label}
                    </span>
                  </div>
                );
              })
            )}
            {!loading && trainings.length > 5 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{trainings.length - 5} formation(s) supplémentaire(s)
              </p>
            )}
          </CardContent>
        </Card>

        {/* Notifications Panel */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                Notifications
                {unreadCount > 0 && (
                  <Badge variant="destructive" className="h-5 w-5 p-0 flex items-center justify-center text-xs rounded-full">
                    {unreadCount}
                  </Badge>
                )}
              </CardTitle>
              {unreadCount > 0 && (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                    notificationService.markAllRead().catch(() => {});
                  }}
                >
                  Tout lire
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="p-3 rounded-lg bg-muted/30 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))
            ) : recentNotifs.length > 0 ? (
              recentNotifs.map((notif) => (
                <div
                  key={notif.id}
                  onClick={() => handleMarkRead(notif.id)}
                  className={cn(
                    'p-3 rounded-lg border-l-4 cursor-pointer transition-all hover:bg-muted/60',
                    notif.read ? 'opacity-60 border-l-muted' : '',
                    !notif.read && notif.type === 'error' ? 'border-l-destructive bg-destructive/5' :
                    !notif.read && notif.type === 'warning' ? 'border-l-warning bg-warning/5' :
                    !notif.read ? 'border-l-primary bg-primary/5' : 'border-l-muted bg-muted/20',
                  )}
                >
                  <p className={cn('text-sm leading-snug', notif.read ? 'font-normal' : 'font-semibold')}>{notif.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notif.message}</p>
                </div>
              ))
            ) : (
              <div className="text-center py-10 text-muted-foreground">
                <Bell className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">Tout est à jour</p>
                <p className="text-xs mt-1">Aucune nouvelle notification.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Leaderboard (only if there's data) ── */}
      {!loading && leaderboard.length > 0 && (
        <Card className="animate-fade-in" style={{ animationDelay: '450ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Crown className="h-4 w-4 text-yellow-500" />
                  Classement {CURRENT_YEAR}
                </CardTitle>
                <CardDescription>Votre position parmi les employés scorés</CardDescription>
              </div>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate('/employee/scoring')}>
                Voir mon score <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {top5.map((entry, i) => {
                const isMe = entry.profileId === myProfileId;
                const medalClass = i === 0 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : i === 1 ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                  : i === 2 ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400'
                  : 'bg-muted text-muted-foreground';
                return (
                  <div
                    key={entry.profileId}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors',
                      isMe ? 'bg-primary/10 border border-primary/20' : 'bg-muted/30 hover:bg-muted/60',
                    )}
                  >
                    <div className={cn('flex items-center justify-center h-6 w-6 rounded-full text-xs font-bold shrink-0', medalClass)}>
                      {i + 1}
                    </div>
                    <span className={cn('flex-1 text-sm truncate', isMe ? 'font-bold' : 'font-medium')}>
                      {entry.employeeName}{isMe ? ' (vous)' : ''}
                    </span>
                    <span className="text-sm font-semibold shrink-0">{Number(entry.finalScore).toFixed(1)} pts</span>
                  </div>
                );
              })}
              {/* Show user row if outside top 5 */}
              {myLeaderboardEntry && !myInTop5 && (
                <>
                  <div className="text-center text-xs text-muted-foreground py-1">···</div>
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-primary/10 border border-primary/20">
                    <div className="flex items-center justify-center h-6 w-6 rounded-full text-xs font-bold bg-muted text-muted-foreground shrink-0">
                      {myLeaderboardEntry.rank}
                    </div>
                    <span className="flex-1 text-sm font-bold truncate">{myLeaderboardEntry.employeeName} (vous)</span>
                    <span className="text-sm font-semibold shrink-0">{Number(myLeaderboardEntry.finalScore).toFixed(1)} pts</span>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── CV Status ── */}
      {!loading && (
        <Card
          className={cn('animate-fade-in', cvUploaded === false && 'border-warning/40')}
          style={{ animationDelay: '500ms' }}
        >
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className={cn('p-3 rounded-xl shrink-0', cvUploaded ? 'bg-success/10' : 'bg-warning/10')}>
                {cvUploaded ? <FileText className="h-6 w-6 text-success" /> : <Upload className="h-6 w-6 text-warning" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm flex items-center gap-2">
                  Statut du CV
                  {cvUploaded && <CheckCircle2 className="h-4 w-4 text-success" />}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {cvUploaded
                    ? 'Votre CV est importé et visible par les managers BID.'
                    : 'Aucun CV importé — votre profil est incomplet.'}
                </p>
              </div>
              {cvUploaded ? (
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => navigate('/employee/cv-preview')}>
                    Aperçu
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => navigate('/employee/cv-upload')}>
                    Mettre à jour
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => navigate('/employee/cv-upload')} className="shrink-0">
                  <Upload className="h-4 w-4 mr-2" />
                  Importer
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default EmployeeDashboard;
