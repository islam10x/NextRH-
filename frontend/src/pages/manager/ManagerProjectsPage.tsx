import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { projectService, CrossTeamRequest, OwnedProjectLite } from '@/services/project.service';
import { teamService, ExternalTeamLite } from '@/services/team.service';
import { scoringService, AvailableProject } from '@/services/scoring.service';
import { Project } from '@/types';
import { Briefcase, BriefcaseBusiness, Building2, Calendar, CalendarClock, Inbox, Search, Send, Upload, UserRound, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';

const formatDate = (dateString?: string | null) => {
  if (!dateString) return 'n/a';
  try {
    return new Date(dateString).toISOString().slice(0, 10);
  } catch {
    return dateString;
  }
};

const statusLabel: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

const statusVariant = (status: string): 'secondary' | 'default' | 'destructive' => {
  if (status === 'approved') return 'default';
  if (status === 'rejected') return 'destructive';
  return 'secondary';
};

const statusBadgeClass: Record<string, string> = {
  pending: 'border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-50',
  approved: 'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50',
  rejected: 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-50',
};

const getApiErrorMessage = (error: unknown, fallback: string) => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response?: { data?: { message?: string } } }).response?.data?.message
  ) {
    return (error as { response?: { data?: { message?: string } } }).response?.data?.message || fallback;
  }

  return fallback;
};

const ManagerProjectsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [ownedProjects, setOwnedProjects] = useState<OwnedProjectLite[]>([]);
  const [otherTeams, setOtherTeams] = useState<ExternalTeamLite[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<CrossTeamRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<CrossTeamRequest[]>([]);
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [assignSearch, setAssignSearch] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [clientName, setClientName] = useState('');
  const [projectComplexity, setProjectComplexity] = useState('medium');
  const [projectType, setProjectType] = useState<'internal' | 'external'>('internal');
  const [projectStartDate, setProjectStartDate] = useState('');
  const [projectEndDate, setProjectEndDate] = useState('');
  const [projectTechnologies, setProjectTechnologies] = useState('');
  const [projectDescription, setProjectDescription] = useState('');

  const [requestProjectId, setRequestProjectId] = useState('');
  const [requestTargetTeamId, setRequestTargetTeamId] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [selectedIncomingProfiles, setSelectedIncomingProfiles] = useState<Record<string, string>>({});
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState('');
  const [uploadComplexity, setUploadComplexity] = useState<'low' | 'medium' | 'high'>('medium');
  const [uploadProfileIds, setUploadProfileIds] = useState<string[]>([]);
  const [uploadScores, setUploadScores] = useState<Record<string, string>>({});
  const [uploadContributions, setUploadContributions] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<AvailableProject[]>([]);
  const [activeTab, setActiveTab] = useState<'projects' | 'cross-team'>(
    searchParams.get('tab') === 'cross-team' ? 'cross-team' : 'projects',
  );
  const tabQuery = searchParams.get('tab');
  const requestIdQuery = searchParams.get('requestId');
  const selectedUploadProject = useMemo(
    () => availableProjects.find((project) => project.project_id === uploadProjectId),
    [availableProjects, uploadProjectId],
  );
  const selectedUploadParticipants = useMemo(() => selectedUploadProject?.participants || [], [selectedUploadProject]);

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
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to load team members'));
    } finally {
      setLoadingMembers(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [teamProjects, managerOwned, externalTeams, incoming, outgoing] = await Promise.all([
        projectService.listTeam(),
        projectService.listOwned(),
        teamService.listOtherTeams(),
        projectService.listIncomingCrossTeamRequests(),
        projectService.listOutgoingCrossTeamRequests(),
      ]);
      setProjects(teamProjects);
      setOwnedProjects(managerOwned);
      setOtherTeams(externalTeams);
      setIncomingRequests(incoming);
      setOutgoingRequests(outgoing);
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to load projects'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMembers();
    loadAll();
  }, []);

  useEffect(() => {
    const tab = tabQuery;
    if (tab === 'cross-team' || tab === 'projects') {
      setActiveTab(tab);
      return;
    }
    setActiveTab('projects');
  }, [tabQuery]);

  // When a requestId is provided (from notification click), highlight and scroll to the matching request card.
  useEffect(() => {
    if (!requestIdQuery) return;
    const el = document.getElementById(`request-${requestIdQuery}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [requestIdQuery, incomingRequests, outgoingRequests]);

  const groupedProjects = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        projectName: string;
        clientName: string;
        projectType: 'internal' | 'external';
        startDate: string;
        endDate?: string;
        description: string;
        assignees: Array<{ profileId?: string; name: string; email: string; assignmentType: 'internal' | 'external' }>;
      }
    >();

    for (const project of projects) {
      const key = project.projectId || `${project.name || ''}::${project.client || ''}`;
      const existing = grouped.get(key);
      const assigneeName = project.assigneeName || '';
      const assigneeEmail = project.assigneeEmail || '';
      const assigneeKey = `${project.assigneeProfileId || assigneeEmail || assigneeName}`;

      if (!existing) {
        grouped.set(key, {
          key,
          projectName: project.name || 'Project',
          clientName: project.client || '',
          projectType: project.projectType || 'internal',
          startDate: project.startDate || '',
          endDate: project.endDate || undefined,
          description: project.description || '',
          assignees: assigneeName || assigneeEmail
            ? [
                {
                  profileId: project.assigneeProfileId || undefined,
                  name: assigneeName || assigneeEmail,
                  email: assigneeEmail,
                  assignmentType: project.assignmentType || 'internal',
                },
              ]
            : [],
        });
        continue;
      }

      const alreadyInProject = existing.assignees.some((assignee) => {
        const existingKey = `${assignee.profileId || assignee.email || assignee.name}`;
        return existingKey === assigneeKey;
      });
      if (!alreadyInProject && (assigneeName || assigneeEmail)) {
        existing.assignees.push({
          profileId: project.assigneeProfileId || undefined,
          name: assigneeName || assigneeEmail,
          email: assigneeEmail,
          assignmentType: project.assignmentType || 'internal',
        });
      }
    }

    return Array.from(grouped.values());
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groupedProjects;
    return groupedProjects.filter((project) => {
      const haystack = [
        project.projectName,
        project.clientName,
        project.projectType,
        ...project.assignees.map((assignee) => `${assignee.name} ${assignee.email} ${assignee.assignmentType}`),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [groupedProjects, search]);

  const filteredMembers = useMemo(() => {
    const query = assignSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter((m) => {
      const name = (m.name || '').toLowerCase();
      const email = (m.email || '').toLowerCase();
      return name.includes(query) || email.includes(query);
    });
  }, [assignSearch, members]);

  const requestableProjects = useMemo(() => ownedProjects, [ownedProjects]);
  const pendingIncomingCount = incomingRequests.filter((request) => request.status === 'pending').length;
  const pendingOutgoingCount = outgoingRequests.filter((request) => request.status === 'pending').length;
  const approvedOutgoingCount = outgoingRequests.filter((request) => request.status === 'approved').length;

  // Score progress for PV upload: count how many internal participants still need a score
  const internalParticipants = selectedUploadParticipants.filter((p) => p.assignmentType === 'internal');
  const scoredCount = internalParticipants.filter((p) => {
    const v = uploadScores[p.profileId];
    return v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 20;
  }).length;
  const allScoresEntered = internalParticipants.length === 0 || scoredCount === internalParticipants.length;
  const canUpload = !uploading && allScoresEntered;

  const openUploadDialog = async () => {
    setUploadOpen(true);
    setUploadFile(null);
    setUploadProjectId('');
    setUploadComplexity('medium');
    setUploadProfileIds([]);
    setUploadScores({});
    setUploadContributions({});
    try {
      const projects = await scoringService.listProjects();
      setAvailableProjects(projects);
    } catch (error: unknown) {
      setAvailableProjects([]);
      toast.error(getApiErrorMessage(error, 'Failed to load projects for PV upload'));
    }
  };

  const handleUploadProjectChange = (projectId: string) => {
    setUploadProjectId(projectId);
    setUploadScores({});
    setUploadContributions({});
    const selected = availableProjects.find((project) => project.project_id === projectId);
    const participantIds = (selected?.participants || []).map((participant) => participant.profileId);
    setUploadProfileIds(participantIds);
    const nextComplexity = (selected?.complexity || 'medium').toLowerCase();
    if (nextComplexity === 'low' || nextComplexity === 'high') {
      setUploadComplexity(nextComplexity);
      return;
    }
    setUploadComplexity('medium');
  };

  const handleUploadPv = async () => {
    if (!uploadFile) {
      toast.error('Select a PV file');
      return;
    }
    if (!uploadProjectId) {
      toast.error('Select a project');
      return;
    }
    if (!uploadComplexity) {
      toast.error('Select project complexity');
      return;
    }
    if (uploadProfileIds.length === 0) {
      toast.error('Select at least one participant.');
      return;
    }

    const participantsById = new Map(
      selectedUploadParticipants.map((participant) => [participant.profileId, participant]),
    );

    for (const profileId of uploadProfileIds) {
      const participant = participantsById.get(profileId);
      if (!participant) continue;
      const internalRawScore = uploadScores[profileId];
      if (participant.assignmentType === 'internal' && (internalRawScore === undefined || internalRawScore === '')) {
        toast.error('An internal score is required for each internal participant.');
        return;
      }
      if (participant.assignmentType === 'internal' && internalRawScore !== undefined && internalRawScore !== '') {
        const internalScore = Number(internalRawScore);
        if (!Number.isFinite(internalScore) || internalScore < 0 || internalScore > 20) {
          toast.error('Individual score must be between 0 and 20.');
          return;
        }
      }
      if (participant.assignmentType === 'external' && !uploadContributions[profileId]?.trim()) {
        toast.error('Contribution description is required for external members.');
        return;
      }
    }

    setUploading(true);
    try {
      const profileEvaluations = uploadProfileIds.map((profileId) => {
        const participant = participantsById.get(profileId);
        const rawScore = uploadScores[profileId];
        const parsedScore = rawScore === undefined || rawScore === '' ? undefined : Number(rawScore);

        return {
          profileId,
          score:
            participant?.assignmentType === 'internal' && Number.isFinite(parsedScore)
              ? parsedScore
              : undefined,
          contributionDescription:
            participant?.assignmentType === 'external'
              ? uploadContributions[profileId]?.trim() || undefined
              : undefined,
        };
      });

      const result = await scoringService.uploadPv(
        uploadFile,
        uploadProfileIds,
        uploadProjectId,
        uploadComplexity,
        profileEvaluations,
      );
      const hasDuplicate = result.status === 'duplicate' || result.results?.some((item) => item.status === 'duplicate');
      if (hasDuplicate) {
        toast.warning(result.message || 'This PV already exists. Upload skipped.');
      } else {
        toast.success(result.message || 'PV uploaded successfully');
      }

      if (result.status !== 'duplicate') {
        setUploadOpen(false);
      }
      await loadAll();
      window.dispatchEvent(new Event('scoring:updated'));
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'PV upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const toggleSelection = (profileId: string | null) => {
    if (!profileId) {
      toast.error('This member has no profile yet');
      return;
    }
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((id) => id !== profileId) : [...prev, profileId],
    );
  };

  const resetAssignForm = () => {
    setSelectedProfiles([]);
    setAssignSearch('');
    setProjectName('');
    setClientName('');
    setProjectComplexity('medium');
    setProjectType('internal');
    setProjectStartDate('');
    setProjectEndDate('');
    setProjectTechnologies('');
    setProjectDescription('');
  };

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) {
      toast.error('Project name is required.');
      return;
    }
    if (selectedProfiles.length === 0) {
      toast.error('Select at least one team member.');
      return;
    }
    if (projectType === 'internal' && !projectComplexity) {
      toast.error('Complexity is required for internal projects.');
      return;
    }

    setIsAssigning(true);
    try {
      const technologies = projectTechnologies
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await projectService.assign({
        projectName: projectName.trim(),
        clientName: clientName.trim() || undefined,
        projectDescription: projectDescription.trim() || undefined,
        startDate: projectStartDate || undefined,
        endDate: projectEndDate || undefined,
        technologies: technologies.length ? technologies : undefined,
        assigneeProfileIds: selectedProfiles,
        projectType,
        complexity: projectType === 'internal' ? projectComplexity : undefined,
      });

      const count = selectedProfiles.length;
      toast.success(`Project assigned to ${count} member${count === 1 ? '' : 's'}`);
      setIsAssignOpen(false);
      resetAssignForm();
      loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to assign project'));
    } finally {
      setIsAssigning(false);
    }
  };

  const handleCreateCrossTeamRequest = async () => {
    if (!requestProjectId) {
      toast.error('Select a project first.');
      return;
    }
    if (!requestTargetTeamId) {
      toast.error('Select a target team.');
      return;
    }
    if (!requestNote.trim()) {
      toast.error('Please describe the expected contribution before sending the request.');
      return;
    }
    setCreatingRequest(true);
    try {
      await projectService.requestCrossTeamMember({
        projectId: requestProjectId,
        targetTeamId: requestTargetTeamId,
        requestNote: requestNote.trim() || undefined,
      });
      toast.success('Cross-team request sent');
      setRequestProjectId('');
      setRequestTargetTeamId('');
      setRequestNote('');
      await loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to send request'));
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleRespondRequest = async (request: CrossTeamRequest, approved: boolean) => {
    setProcessingRequestId(request.requestId);
    try {
      const selectedProfileId = selectedIncomingProfiles[request.requestId];
      if (approved && !selectedProfileId) {
        toast.error('Select an employee from your team before approving.');
        return;
      }
      await projectService.respondCrossTeamRequest(request.requestId, {
        approved,
        selectedProfileId: approved ? selectedProfileId : undefined,
      });
      toast.success(approved ? 'Request approved' : 'Request rejected');
      await loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to process request'));
    } finally {
      setProcessingRequestId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground">Manage internal/external projects and cross-team assignments.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          <Button variant="outline" className="w-full sm:w-auto" onClick={openUploadDialog}>
            <Upload className="mr-2 h-4 w-4" /> Upload PV
          </Button>
          <Dialog
            open={isAssignOpen}
            onOpenChange={(open) => {
              if (!open) resetAssignForm();
              setIsAssignOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button className="w-full sm:w-auto">Create Project</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-xl">Create and Assign Project</DialogTitle>
                <DialogDescription>
                  Internal projects require manual complexity. External projects use PV complexity.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAssign} className="space-y-4">
                <div className="space-y-4 py-2 max-h-[65vh] overflow-y-auto pr-1">
                  <div className="space-y-2">
                    <Label>Project Type</Label>
                    <Select value={projectType} onValueChange={(v: 'internal' | 'external') => setProjectType(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="internal">Internal Project</SelectItem>
                        <SelectItem value="external">External Project</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectName">Project Name</Label>
                    <Input
                      id="projectName"
                      placeholder="e.g., Cloud Migration Initiative"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="clientName">Client</Label>
                    <Input
                      id="clientName"
                      placeholder="e.g., Company Name"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </div>
                  {projectType === 'internal' && (
                    <div className="space-y-2">
                      <Label htmlFor="projectComplexity">Complexity</Label>
                      <Select value={projectComplexity} onValueChange={setProjectComplexity}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startDate">Start Date</Label>
                      <Input
                        id="startDate"
                        type="date"
                        value={projectStartDate}
                        onChange={(e) => setProjectStartDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endDate">End Date</Label>
                      <Input
                        id="endDate"
                        type="date"
                        value={projectEndDate}
                        onChange={(e) => setProjectEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="technologies">Technologies</Label>
                    <Input
                      id="technologies"
                      placeholder="React, Node.js, AWS"
                      value={projectTechnologies}
                      onChange={(e) => setProjectTechnologies(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectDescription">Project Summary</Label>
                    <Textarea
                      id="projectDescription"
                      placeholder="Short project context for the team"
                      value={projectDescription}
                      onChange={(e) => setProjectDescription(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Team members</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Search team members..."
                        value={assignSearch}
                        onChange={(e) => setAssignSearch(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <div className="max-h-52 overflow-auto rounded-md border p-2 space-y-2">
                      {loadingMembers ? (
                        <p className="text-sm text-muted-foreground">Loading members...</p>
                      ) : filteredMembers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No matching team members</p>
                      ) : (
                        filteredMembers.map((m) => {
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
                </div>
                <DialogFooter className="pt-4 gap-2">
                  <Button type="button" variant="ghost" onClick={() => setIsAssignOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isAssigning}>
                    {isAssigning ? 'Saving...' : 'Create Project'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <div className="w-full md:w-64">
            <Input
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const nextTab = value === 'cross-team' ? 'cross-team' : 'projects';
          setActiveTab(nextTab);
          const nextParams = new URLSearchParams(searchParams);
          if (nextTab === 'cross-team') {
            nextParams.set('tab', 'cross-team');
          } else {
            nextParams.delete('tab');
          }
          setSearchParams(nextParams, { replace: true });
        }}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="projects">Team Projects</TabsTrigger>
          <TabsTrigger value="cross-team">Cross-Team Flow</TabsTrigger>
        </TabsList>

        <TabsContent value="projects">
          <Card>
            <CardHeader>
              <CardTitle>Assigned Projects</CardTitle>
              <CardDescription>Track work and assignment type across your team</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : filteredProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects assigned yet.</p>
              ) : (
                <div className="space-y-3">
                  {filteredProjects.map((project) => (
                    <div key={project.key} className="border rounded-lg p-4 flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                            <Briefcase className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium">{project.projectName}</p>
                            {project.clientName && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <Building2 className="h-3 w-3" />
                                {project.clientName}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Badge variant="secondary">{project.projectType || 'internal'}</Badge>
                          {project.assignees.some((assignee) => assignee.assignmentType === 'external') && (
                            <Badge variant="outline">contains external member</Badge>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {project.assignees.length} assigned member{project.assignees.length === 1 ? '' : 's'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'Present'}
                        </span>
                      </div>

                      {project.assignees.length > 0 && (
                        <div className="rounded-md bg-muted/50 p-2">
                          <p className="text-xs text-muted-foreground mb-2">Assigned members</p>
                          <div className="flex flex-wrap gap-2">
                            {project.assignees.map((assignee) => (
                              <Badge
                                key={`${project.key}-${assignee.profileId || assignee.email}`}
                                variant="secondary"
                                className="font-normal"
                              >
                                {assignee.name} ({assignee.assignmentType})
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {project.description && (
                        <p className="text-sm text-muted-foreground">{project.description}</p>
                      )}

                      {project.assignees.some((assignee) => assignee.assignmentType === 'external') && (
                        <p className="text-xs text-muted-foreground">
                          You requested this external member via cross-team flow. At PV upload you must describe contribution; final score is submitted by the member&apos;s home team manager.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cross-team" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Incoming pending</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{pendingIncomingCount}</p>
                <p className="mt-1 text-sm text-slate-600">Requests waiting for a decision from your team.</p>
              </CardContent>
            </Card>
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Outgoing pending</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{pendingOutgoingCount}</p>
                <p className="mt-1 text-sm text-slate-600">Requests you sent that are still awaiting confirmation.</p>
              </CardContent>
            </Card>
            <Card className="border-slate-200 bg-white shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Approved outgoing</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{approvedOutgoingCount}</p>
                <p className="mt-1 text-sm text-slate-600">Requests already matched with an external member.</p>
              </CardContent>
            </Card>
          </div>

          <Card className="border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle>Request External Member</CardTitle>
              <CardDescription>Select the project, choose the target team, and write a short operational brief that makes the request immediately understandable.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.2fr]">
                <div className="space-y-2">
                  <Label>Project</Label>
                  <Select value={requestProjectId} onValueChange={setRequestProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select project" />
                    </SelectTrigger>
                    <SelectContent>
                      {requestableProjects.map((project) => (
                        <SelectItem key={project.projectId} value={project.projectId}>
                          {project.projectName} ({project.projectType}){project.startDate ? ` - ${formatDate(project.startDate)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Target Team</Label>
                  <Select value={requestTargetTeamId} onValueChange={setRequestTargetTeamId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select team" />
                    </SelectTrigger>
                    <SelectContent>
                      {otherTeams.map((team) => (
                        <SelectItem key={team.teamId} value={team.teamId}>
                          {team.teamName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Expected Contribution</Label>
                  <Textarea
                    value={requestNote}
                    onChange={(e) => setRequestNote(e.target.value)}
                    placeholder="Summarize the deliverables, ownership, and context expected from the requested member"
                    rows={4}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                {requestProjectId && (
                  <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
                    {requestableProjects
                      .filter((project) => project.projectId === requestProjectId)
                      .map((project) => (
                        <div key={project.projectId} className="grid gap-3 md:grid-cols-3 md:items-center">
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Project</p>
                            <p className="font-medium">{project.projectName}</p>
                            <p className="text-muted-foreground text-sm">
                              {project.clientName || 'No client'} • {project.projectType}
                            </p>
                          </div>
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Assignment</p>
                            <p className="text-sm text-slate-700">{project.startDate ? `Assigned on ${formatDate(project.startDate)}` : 'No assignment date'}</p>
                          </div>
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Request goal</p>
                            <p className="text-sm text-slate-700">{requestNote.trim() || 'Add a short brief so the receiving manager can act quickly.'}</p>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {!requestProjectId && (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                    Select a project to preview the request summary before sending it.
                  </div>
                )}
              </div>

              <Button onClick={handleCreateCrossTeamRequest} disabled={creatingRequest}>
                  {creatingRequest ? 'Sending...' : 'Send Request'}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Inbox className="h-5 w-5 text-slate-700" />
                Incoming Requests
              </CardTitle>
              <CardDescription>Requests addressed to your team. Each card separates who asked, for which project, what they need, and what action you need to take.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {incomingRequests.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                  No incoming requests.
                </div>
              ) : (
                incomingRequests.map((request) => {
                  const pending = request.status === 'pending';
                  const highlighted = requestIdQuery === request.requestId;
                  return (
                    <div
                      key={request.requestId}
                      id={`request-${request.requestId}`}
                      className={`rounded-2xl border p-4 space-y-4 shadow-sm transition-all ${
                        highlighted
                          ? 'border-amber-400 bg-amber-50/60 ring-2 ring-amber-300 ring-offset-2'
                          : pending
                            ? 'border-sky-200 bg-sky-50/40'
                            : 'border-slate-200 bg-slate-50/70 opacity-70'
                      }`}
                    >
                      {pending && (
                        <div className="flex items-center gap-2 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white">
                          <span className="inline-flex h-2 w-2 rounded-full bg-white animate-pulse" />
                          Awaiting your response — choose an employee and approve or reject
                        </div>
                      )}
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-1">
                          <p className="text-lg font-semibold text-slate-950">{request.projectName}</p>
                          <p className="text-sm text-slate-600">Cross-team request from {request.requestingTeamName}</p>
                        </div>
                        <Badge className={statusBadgeClass[request.status] || ''} variant={statusVariant(request.status)}>
                          {statusLabel[request.status] || request.status}
                        </Badge>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-3">
                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            <UserRound className="h-3.5 w-3.5" /> Requesting manager
                          </p>
                          <p className="font-medium text-slate-900">{request.requestingManagerName || 'Manager'}</p>
                          <p className="text-sm text-slate-600">{request.requestingTeamName || 'Team'}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            <BriefcaseBusiness className="h-3.5 w-3.5" /> Project context
                          </p>
                          <p className="font-medium text-slate-900">{request.projectName}</p>
                          <p className="text-sm text-slate-600">{request.clientName || 'No client specified'}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            <CalendarClock className="h-3.5 w-3.5" /> Timeline
                          </p>
                          <p className="text-sm text-slate-700">Requested on {formatDate(request.createdAt)}</p>
                          <p className="text-sm text-slate-600">{request.respondedAt ? `Responded on ${formatDate(request.respondedAt)}` : 'Awaiting your decision'}</p>
                        </div>
                      </div>

                      {request.projectDescription && (
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Project Description</p>
                          <p className="text-sm text-slate-700">{request.projectDescription}</p>
                        </div>
                      )}
                      {request.requestNote && (
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Expected Contribution</p>
                          <p className="text-sm text-slate-700">{request.requestNote}</p>
                        </div>
                      )}
                      {pending && (
                        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
                          <p className="mb-3 text-sm font-medium text-sky-900">Choose one employee from your team and respond to the request.</p>
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <Select
                              value={selectedIncomingProfiles[request.requestId] || ''}
                              onValueChange={(value) =>
                                setSelectedIncomingProfiles((prev) => ({ ...prev, [request.requestId]: value }))
                              }
                            >
                              <SelectTrigger className="xl:w-[340px] bg-white">
                                <SelectValue placeholder="Select employee from your team" />
                              </SelectTrigger>
                              <SelectContent>
                                {members
                                  .filter((member) => member.profileId)
                                  .map((member) => (
                                    <SelectItem key={member.profileId!} value={member.profileId!}>
                                      {member.name}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            <div className="flex gap-2">
                            <Button
                              onClick={() => handleRespondRequest(request, true)}
                              disabled={processingRequestId === request.requestId}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => handleRespondRequest(request, false)}
                              disabled={processingRequestId === request.requestId}
                            >
                              Reject
                            </Button>
                          </div>
                        </div>
                        </div>
                      )}
                      {!pending && request.selectedEmployeeName && (
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected employee</p>
                          <p className="mt-1 text-sm text-slate-700">{request.selectedEmployeeName}</p>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5 text-slate-700" />
                Outgoing Requests
              </CardTitle>
              <CardDescription>Requests your team has already sent. The cards below make the current status, selected employee, and next step easier to scan.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {outgoingRequests.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                  No outgoing requests.
                </div>
              ) : (
                outgoingRequests.map((request) => {
                  const highlighted = requestIdQuery === request.requestId;
                  return (
                  <div
                    key={request.requestId}
                    id={`request-${request.requestId}`}
                    className={`rounded-2xl border p-4 space-y-4 shadow-sm transition-all ${
                      highlighted
                        ? 'border-amber-400 bg-amber-50/60 ring-2 ring-amber-300 ring-offset-2'
                        : request.status === 'pending'
                          ? 'border-sky-200 bg-sky-50/40'
                          : 'border-slate-200 bg-slate-50/70'
                    }`}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-slate-950">{request.projectName}</p>
                        <p className="text-sm text-slate-600">Request sent to {request.targetTeamName}</p>
                      </div>
                      <Badge className={statusBadgeClass[request.status] || ''} variant={statusVariant(request.status)}>
                        {statusLabel[request.status] || request.status}
                      </Badge>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <BriefcaseBusiness className="h-3.5 w-3.5" /> Project
                        </p>
                        <p className="font-medium text-slate-900">{request.projectName}</p>
                        <p className="text-sm text-slate-600">{request.clientName || 'No client specified'}</p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <Users className="h-3.5 w-3.5" /> Target team
                        </p>
                        <p className="font-medium text-slate-900">{request.targetTeamName}</p>
                        <p className="text-sm text-slate-600">{request.targetManagerName || 'Manager'}</p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <CalendarClock className="h-3.5 w-3.5" /> Timeline
                        </p>
                        <p className="text-sm text-slate-700">Sent on {formatDate(request.createdAt)}</p>
                        <p className="text-sm text-slate-600">{request.respondedAt ? `Processed on ${formatDate(request.respondedAt)}` : 'Awaiting response'}</p>
                      </div>
                    </div>

                    {request.selectedEmployeeName && (
                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Confirmed external member</p>
                        <p className="mt-1 text-sm text-slate-700">{request.selectedEmployeeName}</p>
                      </div>
                    )}
                    {request.requestNote && (
                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your request context</p>
                        <p className="mt-1 text-sm text-slate-700">{request.requestNote}</p>
                      </div>
                    )}
                    {request.status === 'approved' && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                        Next step: upload the PV for this project, then provide the external member contribution details.
                      </div>
                    )}
                    {request.status === 'pending' && (
                      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
                        This request is still being reviewed by the receiving team.
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload PV</DialogTitle>
            <DialogDescription>
              Submit the PV here and complete all manager inputs in one flow: give scores to internal members and describe external-member contributions for the home-manager review.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>PV File (PDF)</Label>
              <Input type="file" accept=".pdf" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Project</Label>
                <Select value={uploadProjectId} onValueChange={handleUploadProjectChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProjects.map((project) => (
                      <SelectItem key={project.project_id} value={project.project_id}>
                        {project.projectName} ({project.projectType}){project.startDate ? ` - ${project.startDate}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Project Complexity</Label>
                <Select
                  value={uploadComplexity}
                  onValueChange={(value: 'low' | 'medium' | 'high') => setUploadComplexity(value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedUploadProject && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium">{selectedUploadProject.projectName}</p>
                    <p className="text-sm text-muted-foreground">{selectedUploadProject.clientName || 'No client'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{selectedUploadProject.projectType}</Badge>
                    <Badge variant="outline">
                      {selectedUploadProject.participants.length} participant{selectedUploadProject.participants.length === 1 ? '' : 's'}
                    </Badge>
                    {selectedUploadProject.startDate && (
                      <Badge variant="outline">Assigned {formatDate(selectedUploadProject.startDate)}</Badge>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Participants</Label>
              {selectedUploadParticipants.length === 0 ? (
                <p className="text-sm text-muted-foreground">Select a project to load participants.</p>
              ) : (
                <div className="space-y-2">
                  {selectedUploadParticipants.map((participant) => {
                    const member = members.find((m) => m.profileId === participant.profileId);
                    const displayName = member?.name || participant.name;
                    return (
                      <div key={participant.profileId} className="rounded-md border p-3 space-y-2">
                        <label className="flex items-center gap-2 text-sm">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">included</span>
                          <span className="font-medium">{displayName}</span>
                          <Badge variant="outline">{participant.assignmentType}</Badge>
                          {participant.assignmentType === 'internal' ? (
                            <span className="text-xs text-sky-700 font-normal">score required</span>
                          ) : (
                            <span className="text-xs text-amber-600 font-normal">describe contribution for home-manager review</span>
                          )}
                        </label>

                        {participant.assignmentType === 'internal' && (
                          <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/70 p-3">
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-sky-950">Execution score (0–20)</Label>
                              <p className="text-xs text-sky-900">
                                Score × project complexity ceiling = final contribution. e.g. 16/20 on a High project → (16/20) × 85 = 68/100.
                              </p>
                            </div>
                            <Input
                              type="number"
                              min={0}
                              max={20}
                              value={uploadScores[participant.profileId] || ''}
                              onChange={(e) =>
                                setUploadScores((prev) => ({ ...prev, [participant.profileId]: e.target.value }))
                              }
                            />
                          </div>
                        )}

                        {participant.assignmentType === 'external' && (
                          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/70 p-3">
                            <Label className="text-xs font-semibold text-amber-950">What did this external member actually do?</Label>
                            <Textarea
                              value={uploadContributions[participant.profileId] || ''}
                              onChange={(e) =>
                                setUploadContributions((prev) => ({
                                  ...prev,
                                  [participant.profileId]: e.target.value,
                                }))
                              }
                              placeholder="Example: owned the API integration, coordinated testing with the client, resolved deployment blockers, and delivered the production-ready script used for release."
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            {internalParticipants.length > 0 && (
              <div className={`flex-1 flex items-center gap-2 text-sm ${allScoresEntered ? 'text-emerald-700' : 'text-sky-700'}`}>
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-white ${allScoresEntered ? 'bg-emerald-500' : 'bg-sky-500'}`}>
                  {scoredCount}
                </span>
                <span>/ {internalParticipants.length} execution score{internalParticipants.length > 1 ? 's' : ''} entered</span>
                {!allScoresEntered && <span className="text-xs text-sky-600">— fill in the remaining score{internalParticipants.length - scoredCount > 1 ? 's' : ''} to unlock upload</span>}
              </div>
            )}
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUploadPv} disabled={!canUpload}>
              {uploading ? 'Uploading...' : 'Upload PV'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerProjectsPage;
