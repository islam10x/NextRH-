import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, Award, AlertTriangle, Calendar, ChevronRight, GraduationCap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { teamService } from '@/services/team.service';
import { trainingService } from '@/services/training.service';
import { certificationService, CertificationStats, TeamCertification } from '@/services/certification.service';
import { toast } from 'sonner';
import { Training } from '@/types';

const ManagerDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [assignedTrainings, setAssignedTrainings] = useState<Training[]>([]);
  const [loadingTrainings, setLoadingTrainings] = useState(false);
  const [certificationStats, setCertificationStats] = useState<CertificationStats>({
    total: 0,
    active: 0,
    expiring_soon: 0,
    expired: 0,
  });
  const [teamCertifications, setTeamCertifications] = useState<TeamCertification[]>([]);
  const [loadingCertifications, setLoadingCertifications] = useState(false);

  const teamName = useMemo(() => {
    const rawName = user?.name || '';
    const firstName = rawName.split(' ').filter(Boolean)[0];
    return firstName ? `${firstName}'s Team` : 'Your Team';
  }, [user]);

  const pieData = [
    { name: 'Active', value: certificationStats.active, color: 'hsl(var(--success))' },
    { name: 'Expiring', value: certificationStats.expiring_soon, color: 'hsl(var(--warning))' },
    { name: 'Expired', value: certificationStats.expired, color: 'hsl(var(--destructive))' },
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
      toast.error(error?.response?.data?.message || 'Failed to load team members');
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
      toast.error('Failed to load certification data');
    } finally {
      setLoadingCertifications(false);
    }
  };

  useEffect(() => {
    loadMembers();
    loadCertifications();
  }, []);

  const loadAssignedTrainings = async () => {
    setLoadingTrainings(true);
    try {
      const data = await trainingService.listAssignedByMe();
      setAssignedTrainings(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to load assigned trainings');
    } finally {
      setLoadingTrainings(false);
    }
  };

  useEffect(() => {
    loadAssignedTrainings();
  }, []);

  const recentTrainings = [...assignedTrainings]
    .sort((a, b) => {
      const aTime = a.assignedAt ? new Date(a.assignedAt).getTime() : 0;
      const bTime = b.assignedAt ? new Date(b.assignedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team Dashboard</h1>
          <p className="text-muted-foreground">{teamName} Overview</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/manager/team')}>
            <Users className="h-4 w-4 mr-2" />
            View All Members
          </Button>
        </div>
      </div>

      {/* Assigned trainings list */}
      <Card className="animate-fade-in">
        <CardHeader>
          <CardTitle className="text-lg">Assigned Trainings</CardTitle>
          <CardDescription>Trainings you assigned to your team</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingTrainings ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : assignedTrainings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trainings assigned yet.</p>
          ) : (
            <div className="space-y-3">
              {recentTrainings.map((t) => (
                <div key={t.id} className="border rounded-lg p-3 flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <GraduationCap className="h-4 w-4 text-primary" />
                      <span className="font-medium">{t.name}</span>
                    </div>
                    <Badge variant="secondary">{t.status || 'assigned'}</Badge>
                  </div>
                  {t.assigneeName && <p className="text-xs text-muted-foreground">Assignee: {t.assigneeName}</p>}
                  {t.provider && <p className="text-xs text-muted-foreground">{t.provider}</p>}
                  <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
                    <span>Assigned: {t.assignedAt ? new Date(t.assignedAt).toLocaleDateString() : 'n/a'}</span>
                    <span>Due: {t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : 'n/a'}</span>
                    {t.trainingUrl && (
                      <a href={t.trainingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        Link
                      </a>
                    )}
                    {t.description && <span>Comment: {t.description}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="animate-fade-in">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Team Members</CardTitle>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{members.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Active employees</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Certifications</CardTitle>
            <Award className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-success">
              {loadingCertifications ? '...' : certificationStats.active}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Valid and current</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expiring Soon</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-warning">
              {loadingCertifications ? '...' : certificationStats.expiring_soon}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Within 30 days</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expired</CardTitle>
            <Award className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">
              {loadingCertifications ? '...' : certificationStats.expired}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Need renewal</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Certification Status Pie Chart */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <CardTitle className="text-lg">Certification Status</CardTitle>
            <CardDescription>Distribution by status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {loadingCertifications ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Loading certification data...
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
                  No certification data
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
            <CardTitle className="text-lg">Certifications by Provider</CardTitle>
            <CardDescription>Top certification providers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              {loadingCertifications ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Loading certification data...
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
                  No certification data
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
            <CardTitle className="text-lg">Upcoming Expirations</CardTitle>
            <CardDescription>Certifications expiring soon</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/manager/certifications')}>
            View All
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
              <p className="text-sm">No certifications expiring soon</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagerDashboard;
