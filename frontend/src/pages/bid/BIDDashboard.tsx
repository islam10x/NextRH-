import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Users, Award, AlertTriangle, Building2,
  FileText, MessageSquare, Trophy, Crown,
  TrendingUp, ChevronRight,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { bidService, BidDashboardStats } from '@/services/bid.service';
import { scoringService, LeaderboardEntry } from '@/services/scoring.service';

const CURRENT_YEAR = new Date().getFullYear();

const BIDDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<BidDashboardStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      bidService.getDashboardStats(),
      scoringService.getLeaderboard(CURRENT_YEAR, undefined, 5),
    ])
      .then(([s, lb]) => { setStats(s); setLeaderboard(lb); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const quickActions = [
    { label: 'Vivier de talents', description: 'Parcourir et filtrer tous les employés', icon: <Users className="h-5 w-5" />, path: '/bid/directory' },
    { label: 'Générer un CV', description: 'Créer un CV formaté à partir d\'un modèle', icon: <FileText className="h-5 w-5" />, path: '/bid/cv-generation' },
    { label: 'Assistant IA', description: 'Rechercher des talents en langage naturel', icon: <MessageSquare className="h-5 w-5" />, path: '/bid/ai-chat' },
  ];

  const pieData = stats ? [
    { name: 'Actives', value: stats.certStats.active, color: 'hsl(var(--success))' },
    { name: 'Expirant', value: stats.certStats.expiringSoon, color: 'hsl(var(--warning))' },
    { name: 'Expirées', value: stats.certStats.expired, color: 'hsl(var(--destructive))' },
  ].filter((d) => d.value > 0) : [];

  const statCards = stats ? [
    { label: 'Employés actifs', value: stats.activeEmployees, sub: `${stats.totalEmployees} au total`, icon: <Users className="h-4 w-4 text-primary" /> },
    { label: 'Total certifications', value: stats.certStats.total, sub: `${stats.certStats.active} actuellement actives`, icon: <Award className="h-4 w-4 text-success" /> },
    { label: 'Expirant ce mois', value: stats.certStats.expiringThisMonth, sub: `${stats.certStats.expiringSoon} expirant bientôt`, icon: <AlertTriangle className="h-4 w-4 text-warning" />, alert: stats.certStats.expiringThisMonth > 0 },
    { label: 'Total équipes', value: stats.totalTeams, sub: 'Dans toute l\'entreprise', icon: <Building2 className="h-4 w-4 text-primary" /> },
  ] : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tableau de bord BID</h1>
          <p className="text-muted-foreground text-sm">Vue d'ensemble des talents, certifications et performances · {CURRENT_YEAR}</p>
        </div>
      </div>

      {/* Expiry alert banner */}
      {!loading && stats && stats.certStats.expiringThisMonth > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          <p className="text-sm text-warning font-medium">
            {stats.certStats.expiringThisMonth} certification{stats.certStats.expiringThisMonth > 1 ? 's' : ''} expirant ce mois dans vos équipes.
          </p>
          <Button variant="outline" size="sm" className="ml-auto shrink-0 text-xs border-warning/30 hover:bg-warning/10" onClick={() => navigate('/bid/directory')}>
            Voir les employés <ChevronRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-4 rounded" />
                  </div>
                  <Skeleton className="h-8 w-14" />
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))
          : statCards.map(({ label, value, sub, icon, alert }, i) => (
              <Card key={label} className="animate-fade-in" style={{ animationDelay: `${i * 80}ms` }}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{label}</CardTitle>
                  {icon}
                </CardHeader>
                <CardContent>
                  <div className={`text-3xl font-bold ${alert ? 'text-warning' : ''}`}>{value}</div>
                  <p className="text-xs text-muted-foreground mt-1">{sub}</p>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 md:grid-cols-3">
        {quickActions.map(({ label, description, icon, path }) => (
          <Card
            key={label}
            className="cursor-pointer hover:shadow-md hover:border-primary/30 transition-all group"
            onClick={() => navigate(path)}
          >
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors shrink-0">
                {icon}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm">{label}</p>
                <p className="text-xs text-muted-foreground truncate">{description}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto shrink-0 group-hover:text-primary transition-colors" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Charts — left 2/3 */}
        <div className="lg:col-span-2 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Certification Status Pie */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Statut des certifications</CardTitle>
                <CardDescription>Santé globale de tous les employés</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="h-56 flex items-center justify-center">
                    <Skeleton className="h-40 w-40 rounded-full" />
                  </div>
                ) : pieData.length === 0 ? (
                  <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">Aucune donnée disponible</div>
                ) : (
                  <>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={5} dataKey="value">
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex justify-center gap-4 mt-2">
                      {pieData.map((item) => (
                        <div key={item.name} className="flex items-center gap-1.5">
                          <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                          <span className="text-xs text-muted-foreground">{item.name}</span>
                          <span className="text-xs font-semibold">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Top Cert Categories Bar */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Catégories de cert. principales</CardTitle>
                <CardDescription>Émetteurs les plus populaires</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="h-56 space-y-3 pt-4">
                    {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full rounded" />)}
                  </div>
                ) : !stats?.certStats.byOrg.length ? (
                  <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">Aucune donnée disponible</div>
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stats.certStats.byOrg} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Top Performers — right 1/3 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Crown className="h-4 w-4 text-yellow-500" />
                  Meilleurs performeurs
                </CardTitle>
                <CardDescription>Classement {CURRENT_YEAR}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate('/bid/scoring')}>
                Voir tout
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-6 w-6 rounded-full shrink-0" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-5 w-10 rounded" />
                </div>
              ))
            ) : leaderboard.length === 0 ? (
              <div className="py-8 text-center">
                <Trophy className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground">Aucun score enregistré pour {CURRENT_YEAR}.</p>
              </div>
            ) : (
              leaderboard.map((entry, i) => (
                <div key={entry.profileId} className="flex items-center gap-3 py-1">
                  <div className={`flex items-center justify-center h-6 w-6 rounded-full text-xs font-bold shrink-0 ${
                    i === 0 ? 'bg-yellow-100 text-yellow-700' :
                    i === 1 ? 'bg-slate-100 text-slate-600' :
                    i === 2 ? 'bg-orange-100 text-orange-600' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{entry.employeeName}</p>
                  </div>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    <TrendingUp className="h-3 w-3 mr-1" />
                    {Number(entry.finalScore).toFixed(1)}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default BIDDashboard;
