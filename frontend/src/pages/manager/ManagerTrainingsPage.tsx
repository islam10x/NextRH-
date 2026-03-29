import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { trainingService } from '@/services/training.service';
import { teamService } from '@/services/team.service';
import { Training } from '@/types';
import { GraduationCap, Link as LinkIcon, Plus, Calendar } from 'lucide-react';
import { toast } from 'sonner';
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
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format } from 'date-fns';

const statusColor = (status?: string) => {
  if (status === 'completed') return 'bg-success/15 text-success';
  if (status === 'in_progress') return 'bg-primary/15 text-primary';
  return 'bg-secondary text-secondary-foreground';
};

const ManagerTrainingsPage: React.FC = () => {
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [loading, setLoading] = useState(false);
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

  const load = async () => {
    setLoading(true);
    try {
      const data = await trainingService.listAssignedByMe();
      setTrainings(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to load trainings');
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async () => {
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
    load();
    loadMembers();
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
      load();
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
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Trainings</h1>
          <p className="text-muted-foreground">History of trainings you assigned and their progress.</p>
        </div>
        <Dialog open={isAssignOpen} onOpenChange={setIsAssignOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Assign Training
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
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
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="dueDate"
                      type="button"
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      {dueDate ? format(new Date(dueDate), 'yyyy-MM-dd') : 'Pick a date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarPicker
                      mode="single"
                      selected={dueDate ? new Date(dueDate) : undefined}
                      onSelect={(date) => {
                        if (!date) {
                          setDueDate('');
                          return;
                        }
                        setDueDate(format(date, 'yyyy-MM-dd'));
                      }}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        return date < today;
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Assigned Trainings</CardTitle>
          <CardDescription>Track status across your team</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : trainings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trainings assigned yet.</p>
          ) : (
            trainings.map((t) => (
              <div key={t.id} className="border rounded-lg p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-primary" />
                  <span className="font-medium">{t.name}</span>
                </div>
                <Badge className={statusColor(t.status)}>{t.status || 'assigned'}</Badge>
              </div>
              {t.assigneeName && <p className="text-xs text-muted-foreground">Assignee: {t.assigneeName}</p>}
              {t.provider && <p className="text-xs text-muted-foreground">{t.provider}</p>}
              <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                <span>Assigned: {t.assignedAt ? new Date(t.assignedAt).toISOString().slice(0, 10) : 'n/a'}</span>
                <span>Due: {t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : 'n/a'}</span>
                {t.completionDate && <span>Completed: {new Date(t.completionDate).toISOString().slice(0, 10)}</span>}
                {t.trainingUrl && (
                  <a href={t.trainingUrl} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                    <LinkIcon className="h-3 w-3" /> Link
                  </a>
                )}
                {t.certificationName && (
                  <span>
                    Certification: {t.certificationName}
                    {t.certificationIssueDate ? ` · Issued ${new Date(t.certificationIssueDate).toISOString().slice(0, 10)}` : ''}
                  </span>
                )}
                {!t.certificationName && t.proofFilePath && <span>Certification uploaded</span>}
                {t.proofUrl && (
                  <button
                    className="text-primary hover:underline"
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        const blob = await trainingService.downloadProof(t.id);
                        const url = URL.createObjectURL(blob);
                        window.open(url, '_blank');
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                      } catch (err: any) {
                        toast.error(err?.response?.data?.message || 'Cannot load proof');
                      }
                    }}
                  >
                    View proof (PDF/Image)
                  </button>
                )}
                {t.description && <span>Comment: {t.description}</span>}
              </div>
            </div>
          ))
        )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagerTrainingsPage;
