import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, Award, AlertTriangle, Calendar, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { teamService, TeamInfo } from '@/services/team.service';
import { certificationService, CertificationStats, TeamCertification } from '@/services/certification.service';
import { toast } from 'sonner';

const ManagerDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [certificationStats, setCertificationStats] = useState<CertificationStats>({
    total: 0,
    active: 0,
    expiring_soon: 0,
    expired: 0,
  });
  const [teamCertifications, setTeamCertifications] = useState<TeamCertification[]>([]);
  const [loadingCertifications, setLoadingCertifications] = useState(false);

  // Team identity
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);

  const teamName = teamInfo?.teamName || (user?.name?.split(' ')[0] ? `${user.name.split(' ')[0]}'s Team` : 'Your Team');

  const pieData = [
    { name: 'Actives', value: certificationStats.active, color: 'hsl(var(--success))' },
    { name: 'Expirant', value: certificationStats.expiring_soon, color: 'hsl(var(--warning))' },
    { name: 'Expirées', value: certificationStats.expired, color: 'hsl(var(--destructive))' },
  ].filter((d) => d.value > 0);

  // Certification by category data
  const certByCategory = teamCertifications.reduce((acc, cert) => {
    const category = cert.issuingOrganization?.split(' ')[0] || 'Other';
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const barData = Object.entries(certByCategory)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // Expiring certifications
  const expiringCerts = teamCertifications
    .filter((c) => c.status === 'expiring_soon')
    .slice(0, 5);

  const loadMembers = async () => {
    if (!user) return;
    try {
      const data = await teamService.listMyMembers();
      const mapped = data.map((m) => ({
        userId: m.userId,
        profileId: m.profileId,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
        email: m.email,
      }));
      setMembers(mapped);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de charger les membres de l\'équipe');
    }
  };

  const loadTeamInfo = async () => {
    try {
      const info = await teamService.getMyTeam();
      setTeamInfo(info);
    } catch {
      // silently ignore — team will be created on first PATCH
    }
  };

  const loadCertifications = async () => {
    if (!user) return;
    try {
      setLoadingCertifications(true);
      const [stats, certs] = await Promise.all([
        certificationService.getTeamCertificationStats(),
        certificationService.getTeamCertifications(),
      ]);
      setCertificationStats(stats);
      setTeamCertifications(certs);
    } catch (error: any) {
      console.error('Failed to load certifications:', error);
      toast.error("Impossible de charger les données de certification — veuillez actualiser la page.");
    } finally {
      setLoadingCertifications(false);
    }
  };

  useEffect(() => {
    loadMembers();
    loadTeamInfo();
    loadCertifications();
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{teamName}</h1>
          <p className="text-muted-foreground text-sm">
            {members.length} membre{members.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/manager/team')}>
            <Users className="h-4 w-4 mr-2" />
            Membres de l'équipe
          </Button>
          <Button onClick={() => navigate('/manager/certifications')}>
            <Award className="h-4 w-4 mr-2" />
            Suivi des certifications
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="animate-fade-in">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Membres de l'équipe</CardTitle>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{members.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Employés actifs</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Certifications actives</CardTitle>
            <Award className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-success">
              {loadingCertifications ? '...' : certificationStats.active}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Valides et en cours</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expire bientôt</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-warning">
              {loadingCertifications ? '...' : certificationStats.expiring_soon}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Dans les 30 jours</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expirées</CardTitle>
            <Award className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">
              {loadingCertifications ? '...' : certificationStats.expired}
            </div>
            <p className="text-xs text-muted-foreground mt-1">À renouveler</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Certification Status Pie Chart */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <CardTitle className="text-lg">Statut des certifications</CardTitle>
            <CardDescription>Répartition par statut</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {loadingCertifications ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Chargement des données de certification...
                </div>
              ) : pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={5}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${value}`}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Aucune donnée de certification
                </div>
              )}
            </div>
            <div className="flex justify-center gap-6 mt-4">
              {pieData.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-sm text-muted-foreground">{item.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Certification by Category Bar Chart */}
        <Card className="animate-fade-in" style={{ animationDelay: '500ms' }}>
          <CardHeader>
            <CardTitle className="text-lg">Certifications par prestataire</CardTitle>
            <CardDescription>Principaux prestataires de certification</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {loadingCertifications ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Chargement des données de certification...
                </div>
              ) : barData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                      }}
                    />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Aucune donnée de certification
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Upcoming Expirations */}
      <Card className="animate-fade-in" style={{ animationDelay: '600ms' }}>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg">Expirations à venir</CardTitle>
            <CardDescription>Certifications expirant bientôt</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/manager/certifications')}>
            Voir tout
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </CardHeader>
        <CardContent>
          {loadingCertifications ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading certification data...
            </div>
          ) : expiringCerts.length > 0 ? (
            <div className="space-y-3">
              {expiringCerts.map((cert) => (
                <div
                  key={cert.certification_id}
                  className="flex items-center justify-between p-3 rounded-lg bg-warning/5 border border-warning/20"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{cert.certificationName}</p>
                      <p className="text-xs text-muted-foreground">{cert.employeeName}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-warning">
                      {cert.expirationDate ? new Date(cert.expirationDate).toLocaleDateString() : 'N/A'}
                    </p>
                    <p className="text-xs text-muted-foreground">{cert.issuingOrganization || 'N/A'}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Aucune certification n'expire bientôt</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagerDashboard;
