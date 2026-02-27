import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/common';
import { mockEmployees, mockTeams, getCertificationStats, getTeamMembers } from '@/data/mockData';
import { Users, Award, AlertTriangle, Calendar, ChevronRight, TrendingUp, Plus, Link as LinkIcon, GraduationCap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { teamService } from '@/services/team.service';
import { trainingService } from '@/services/training.service';
import { toast } from 'sonner';
import { Training } from '@/types';

const ManagerDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignedTrainings, setAssignedTrainings] = useState<Training[]>([]);
  const [loadingTrainings, setLoadingTrainings] = useState(false);

  // Get team data
  const team = mockTeams.find((t) => t.managerId === user?.id);
  const teamMembers = team ? getTeamMembers(team.id) : [];
  const certStats = getCertificationStats(teamMembers);

  const pieData = [
    { name: 'Active', value: certStats.active, color: 'hsl(var(--success))' },
    { name: 'Expiring', value: certStats.expiringSoon, color: 'hsl(var(--warning))' },
    { name: 'Expired', value: certStats.expired, color: 'hsl(var(--destructive))' },
  ].filter((d) => d.value > 0);

  // Certification by category data
  const certByCategory = teamMembers.reduce((acc, emp) => {
    emp.certifications.forEach((cert) => {
      const category = cert.issuer.split(' ')[0]; // Simplified category extraction
      acc[category] = (acc[category] || 0) + 1;
    });
    return acc;
  }, {} as Record<string, number>);

  const barData = Object.entries(certByCategory)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // Expiring certifications
  const expiringCerts = teamMembers.flatMap((emp) =>
    emp.certifications
      .filter((c) => c.status === 'expiring_soon')
      .map((c) => ({ ...c, employeeName: emp.name }))
  ).slice(0, 5);

  const loadMembers = async () => {
    if (!user) return;
    setLoadingMembers(true);
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
    } finally {
      setLoadingMembers(false);
    }
  };

  useEffect(() => {
    loadMembers();
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

  const toggleSelection = (profileId: string | null) => {
    if (!profileId) {
      toast.error('This member has no profile yet');
      return;
    }
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((id) => id !== profileId) : [...prev, profileId]
    );
  };

  const handleAssign = async () => {
    if (!title.trim()) return toast.error('Training title is required');
    if (selectedProfiles.length === 0) return toast.error('Select at least one employee');
    setSubmitting(true);
    setAssignError(null);
    try {
      await trainingService.assign({
        trainingTitle: title.trim(),
        trainingUrl: url || undefined,
        dueDate: dueDate || undefined,
        description: description || undefined,
        provider: provider || undefined,
        assigneeProfileIds: selectedProfiles,
      });
      toast.success('Training assigned');
      setIsAssignOpen(false);
      setSelectedProfiles([]);
      setTitle('');
      setUrl('');
      setDueDate('');
      setDescription('');
      setProvider('');
      loadAssignedTrainings();
    } catch (error: any) {
      const backendMessage =
        error?.response?.data?.message ||
        error?.response?.statusText ||
        (typeof error?.message === 'string' ? error.message : null);
      const friendly = backendMessage ? `Server error: ${backendMessage}` : 'Failed to assign training';
      setAssignError(friendly);
      toast.error(friendly);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team Dashboard</h1>
          <p className="text-muted-foreground">{team?.name || 'Your Team'} Overview</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={isAssignOpen} onOpenChange={setIsAssignOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Assign Training
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Assign Training</DialogTitle>
                <DialogDescription>
                  Choose a title, due date, and the team members concerned.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kubernetes Fundamentals" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider">Provider (optional)</Label>
                  <Input id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Linux Foundation" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="url">Training URL (optional)</Label>
                  <div className="flex items-center gap-2">
                    <LinkIcon className="h-4 w-4 text-muted-foreground" />
                    <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dueDate">Due date</Label>
                  <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Context, objectives..." />
                </div>
                <div className="space-y-2">
                  <Label>Team members</Label>
                  <div className="max-h-48 overflow-auto rounded-md border p-2 space-y-2">
                    {loadingMembers ? (
                      <p className="text-sm text-muted-foreground">Loading members...</p>
                    ) : members.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No members found</p>
                    ) : (
                      members.map((m) => {
                        const disabled = !m.profileId;
                        const checked = m.profileId ? selectedProfiles.includes(m.profileId) : false;
                        return (
                          <label key={m.userId} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={checked}
                              onChange={() => toggleSelection(m.profileId)}
                            />
                            <span className={disabled ? 'text-muted-foreground' : ''}>
                              {m.name} ({m.email}) {disabled && '(no profile yet)'}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
                {assignError && (
                  <p className="text-sm text-destructive">{assignError}</p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAssignOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAssign} disabled={submitting}>
                  Assign
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
              {assignedTrainings.map((t) => (
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
                  <span>Due: {t.dueDate ? t.dueDate : 'n/a'}</span>
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
            <div className="text-3xl font-bold">{teamMembers.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Active employees</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Certifications</CardTitle>
            <Award className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-success">{certStats.active}</div>
            <p className="text-xs text-muted-foreground mt-1">Valid and current</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expiring Soon</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-warning">{certStats.expiringSoon}</div>
            <p className="text-xs text-muted-foreground mt-1">Within 30 days</p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expired</CardTitle>
            <Award className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">{certStats.expired}</div>
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
              {pieData.length > 0 ? (
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
              {barData.length > 0 ? (
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
          {expiringCerts.length > 0 ? (
            <div className="space-y-3">
              {expiringCerts.map((cert) => (
                <div
                  key={cert.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-warning/5 border border-warning/20"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{cert.name}</p>
                      <p className="text-xs text-muted-foreground">{cert.employeeName}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-warning">
                      {new Date(cert.expirationDate).toLocaleDateString()}
                    </p>
                    <p className="text-xs text-muted-foreground">{cert.issuer}</p>
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
