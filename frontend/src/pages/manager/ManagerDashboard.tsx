import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Users, Award, AlertTriangle, Calendar, ChevronRight, Pencil } from 'lucide-react';
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
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFocus, setEditFocus] = useState('');
  const [saving, setSaving] = useState(false);

  const teamName = teamInfo?.teamName || (user?.name?.split(' ')[0] ? `${user.name.split(' ')[0]}'s Team` : 'Your Team');

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

  const loadTeamInfo = async () => {
    try {
      const info = await teamService.getMyTeam();
      setTeamInfo(info);
    } catch {
      // silently ignore — team will be created on first PATCH
    }
  };

  const openEdit = () => {
    setEditName(teamInfo?.teamName || teamName);
    setEditFocus(teamInfo?.teamFocus || '');
    setEditOpen(true);
  };

  const handleSaveTeam = async () => {
    if (!editName.trim() || editName.trim().length < 2) {
      toast.error('Team name must be at least 2 characters.');
      return;
    }
    setSaving(true);
    try {
      const saved = await teamService.updateMyTeam(editName.trim(), editFocus.trim() || null);
      setTeamInfo(saved);
      setEditOpen(false);
      toast.success('Team info updated!');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to update team info.');
    } finally {
      setSaving(false);
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
    loadTeamInfo();
    loadCertifications();
  }, []);

  return (
    <div className="space-y-6">
      {/* Edit Team Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit team identity</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Team name</Label>
              <Input
                id="team-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Alpha Squad"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-focus">Focus / specialisation <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                id="team-focus"
                value={editFocus}
                onChange={(e) => setEditFocus(e.target.value)}
                maxLength={120}
                placeholder="e.g. Cloud Infrastructure, Data & AI…"
              />
              <p className="text-xs text-muted-foreground">Shown on your dashboard and your team members' dashboards.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveTeam} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">{teamName}</h1>
            <button
              onClick={openEdit}
              className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Edit team name & focus"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
          {teamInfo?.teamFocus ? (
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className="text-xs font-normal">{teamInfo.teamFocus}</Badge>
              <span className="text-xs text-muted-foreground">— {members.length} member{members.length !== 1 ? 's' : ''}</span>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {members.length} member{members.length !== 1 ? 's' : ''} ·{' '}
              <button onClick={openEdit} className="underline underline-offset-2 hover:text-foreground transition-colors">Add a team focus</button>
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/manager/team')}>
            <Users className="h-4 w-4 mr-2" />
            View All Members
          </Button>
        </div>
      </div>

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
