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
import { Briefcase, BriefcaseBusiness, Building2, Calendar, CalendarClock, ClipboardCheck, Inbox, Search, Send, Upload, UserRound, Users } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/EmptyState';
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
  pending: 'En attente',
  approved: 'Approuvé',
  rejected: 'Rejeté',
};

const statusVariant = (status: string): 'secondary' | 'default' | 'destructive' => {
  if (status === 'approved') return 'default';
  if (status === 'rejected') return 'destructive';
  return 'secondary';
};

const statusBadgeClass: Record<string, string> = {
  pending: 'border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40',
  approved: 'border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40',
  rejected: 'border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40',
};

const complexityLabel: Record<string, string> = {
  low: 'Faible',
  medium: 'Moyenne',
  high: 'Élevée',
};

const complexityBadgeClass: Record<string, string> = {
  low: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
  medium: 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300',
  high: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
};

const complexityCeiling: Record<string, number> = { low: 45, medium: 65, high: 85 };

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

  // ── PV upload dialog (external projects only) ─────────────────────────
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState('');
  const [uploadComplexity, setUploadComplexity] = useState<'low' | 'medium' | 'high'>('medium');
  const [uploadProfileIds, setUploadProfileIds] = useState<string[]>([]);
  const [uploadScores, setUploadScores] = useState<Record<string, string>>({});
  const [uploadContributions, setUploadContributions] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<AvailableProject[]>([]);

  // ── Internal project evaluation dialog ───────────────────────────────
  const [internalEvalOpen, setInternalEvalOpen] = useState(false);
  const [internalEvalProjectId, setInternalEvalProjectId] = useState('');
  const [internalEvalScores, setInternalEvalScores] = useState<Record<string, string>>({});
  const [submittingInternalEval, setSubmittingInternalEval] = useState(false);

  const [activeTab, setActiveTab] = useState<'projects' | 'cross-team'>(
    searchParams.get('tab') === 'cross-team' ? 'cross-team' : 'projects',
  );
  const tabQuery = searchParams.get('tab');
  const requestIdQuery = searchParams.get('requestId');

  // External projects for PV upload
  const externalProjects = useMemo(
    () => availableProjects.filter((p) => p.projectType === 'external'),
    [availableProjects],
  );

  // Internal projects for evaluation dialog
  const internalProjects = useMemo(
    () => availableProjects.filter((p) => p.projectType === 'internal'),
    [availableProjects],
  );

  const selectedUploadProject = useMemo(
    () => externalProjects.find((p) => p.project_id === uploadProjectId),
    [externalProjects, uploadProjectId],
  );
  const selectedUploadParticipants = useMemo(() => selectedUploadProject?.participants || [], [selectedUploadProject]);

  const selectedInternalProject = useMemo(
    () => internalProjects.find((p) => p.project_id === internalEvalProjectId),
    [internalProjects, internalEvalProjectId],
  );
  const internalProjectParticipants = useMemo(
    () => selectedInternalProject?.participants || [],
    [selectedInternalProject],
  );

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
      toast.error(getApiErrorMessage(error, 'Impossible de charger les membres de l\'équipe'));
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
      toast.error(getApiErrorMessage(error, 'Impossible de charger les projets'));
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

  // PV upload: score progress for internal participants
  const pvInternalParticipants = selectedUploadParticipants.filter((p) => p.assignmentType === 'internal');
  const pvScoredCount = pvInternalParticipants.filter((p) => {
    const v = uploadScores[p.profileId];
    return v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 20;
  }).length;
  const pvAllScoresEntered = pvInternalParticipants.length === 0 || pvScoredCount === pvInternalParticipants.length;
  const canUpload = !uploading && pvAllScoresEntered;

  // Internal eval: score progress
  const internalScoredCount = internalProjectParticipants.filter((p) => {
    const v = internalEvalScores[p.profileId];
    return v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 20;
  }).length;
  const internalAllScoresEntered =
    internalProjectParticipants.length > 0 && internalScoredCount === internalProjectParticipants.length;

  const loadAvailableProjects = async () => {
    try {
      const projects = await scoringService.listProjects();
      setAvailableProjects(projects);
    } catch (error: unknown) {
      setAvailableProjects([]);
      toast.error(getApiErrorMessage(error, 'Impossible de charger les projets'));
    }
  };

  const openPvUploadDialog = async () => {
    setUploadOpen(true);
    setUploadFile(null);
    setUploadProjectId('');
    setUploadComplexity('medium');
    setUploadProfileIds([]);
    setUploadScores({});
    setUploadContributions({});
    await loadAvailableProjects();
  };

  const openInternalEvalDialog = async () => {
    setInternalEvalOpen(true);
    setInternalEvalProjectId('');
    setInternalEvalScores({});
    await loadAvailableProjects();
  };

  const handleUploadProjectChange = (projectId: string) => {
    setUploadProjectId(projectId);
    setUploadScores({});
    setUploadContributions({});
    const selected = externalProjects.find((p) => p.project_id === projectId);
    const participantIds = (selected?.participants || []).map((p) => p.profileId);
    setUploadProfileIds(participantIds);
    const nextComplexity = (selected?.complexity || 'medium').toLowerCase();
    if (nextComplexity === 'low' || nextComplexity === 'high') {
      setUploadComplexity(nextComplexity);
      return;
    }
    setUploadComplexity('medium');
  };

  const handleInternalEvalProjectChange = (projectId: string) => {
    setInternalEvalProjectId(projectId);
    setInternalEvalScores({});
  };

  const handleUploadPv = async () => {
    if (!uploadFile) {
      toast.error('Sélectionnez un fichier PV');
      return;
    }
    if (!uploadProjectId) {
      toast.error('Sélectionnez un projet');
      return;
    }
    if (uploadProfileIds.length === 0) {
      toast.error('Sélectionnez au moins un participant.');
      return;
    }

    const participantsById = new Map(
      selectedUploadParticipants.map((p) => [p.profileId, p]),
    );

    for (const profileId of uploadProfileIds) {
      const participant = participantsById.get(profileId);
      if (!participant) continue;
      const internalRawScore = uploadScores[profileId];
      if (participant.assignmentType === 'internal' && (internalRawScore === undefined || internalRawScore === '')) {
        toast.error('Un score d\'exécution est requis pour chaque participant interne.');
        return;
      }
      if (participant.assignmentType === 'internal' && internalRawScore !== undefined && internalRawScore !== '') {
        const internalScore = Number(internalRawScore);
        if (!Number.isFinite(internalScore) || internalScore < 0 || internalScore > 20) {
          toast.error('Le score individuel doit être compris entre 0 et 20.');
          return;
        }
      }
      if (participant.assignmentType === 'external' && !uploadContributions[profileId]?.trim()) {
        toast.error('La description de contribution est requise pour les membres externes.');
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
        toast.warning(result.message || 'Ce PV existe déjà. Import ignoré.');
      } else {
        toast.success(result.message || 'PV importé avec succès');
      }

      if (result.status !== 'duplicate') {
        setUploadOpen(false);
      }
      await loadAll();
      window.dispatchEvent(new Event('scoring:updated'));
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Échec de l\'import du PV'));
    } finally {
      setUploading(false);
    }
  };

  const handleSubmitInternalEval = async () => {
    if (!internalEvalProjectId) {
      toast.error('Sélectionnez un projet interne.');
      return;
    }
    if (internalProjectParticipants.length === 0) {
      toast.error('Ce projet n\'a aucun participant.');
      return;
    }
    if (!internalAllScoresEntered) {
      toast.error('Saisissez un score pour chaque participant avant de valider.');
      return;
    }

    const profileEvaluations = internalProjectParticipants.map((p) => ({
      profileId: p.profileId,
      score: Number(internalEvalScores[p.profileId]),
    }));

    setSubmittingInternalEval(true);
    try {
      const result = await scoringService.scoreInternalProject(internalEvalProjectId, profileEvaluations);
      toast.success(result.message || 'Évaluations enregistrées avec succès');
      setInternalEvalOpen(false);
      await loadAll();
      window.dispatchEvent(new Event('scoring:updated'));
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Échec de l\'évaluation'));
    } finally {
      setSubmittingInternalEval(false);
    }
  };

  const toggleSelection = (profileId: string | null) => {
    if (!profileId) {
      toast.error('Ce membre n\'a pas encore de profil');
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
      toast.error('Le nom du projet est requis.');
      return;
    }
    if (selectedProfiles.length === 0) {
      toast.error('Sélectionnez au moins un membre.');
      return;
    }
    if (projectType === 'internal' && !projectComplexity) {
      toast.error('La complexité est requise pour les projets internes.');
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
      toast.success(`Projet assigné à ${count} membre${count === 1 ? '' : 's'}`);
      setIsAssignOpen(false);
      resetAssignForm();
      loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Échec de l\'assignation du projet'));
    } finally {
      setIsAssigning(false);
    }
  };

  const handleCreateCrossTeamRequest = async () => {
    if (!requestProjectId) {
      toast.error('Sélectionnez d\'abord un projet.');
      return;
    }
    if (!requestTargetTeamId) {
      toast.error('Sélectionnez une équipe cible.');
      return;
    }
    if (!requestNote.trim()) {
      toast.error('Veuillez décrire la contribution attendue avant d\'envoyer la demande.');
      return;
    }
    setCreatingRequest(true);
    try {
      await projectService.requestCrossTeamMember({
        projectId: requestProjectId,
        targetTeamId: requestTargetTeamId,
        requestNote: requestNote.trim() || undefined,
      });
      toast.success('Demande inter-équipe envoyée');
      setRequestProjectId('');
      setRequestTargetTeamId('');
      setRequestNote('');
      await loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Échec de l\'envoi de la demande'));
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleRespondRequest = async (request: CrossTeamRequest, approved: boolean) => {
    setProcessingRequestId(request.requestId);
    try {
      const selectedProfileId = selectedIncomingProfiles[request.requestId];
      if (approved && !selectedProfileId) {
        toast.error('Sélectionnez un employé de votre équipe avant d\'approuver.');
        return;
      }
      await projectService.respondCrossTeamRequest(request.requestId, {
        approved,
        selectedProfileId: approved ? selectedProfileId : undefined,
      });
      toast.success(approved ? 'Demande approuvée' : 'Demande rejetée');
      await loadAll();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Impossible de traiter la demande'));
    } finally {
      setProcessingRequestId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projets</h1>
          <p className="text-muted-foreground">Gérez les projets internes/externes et les assignations inter-équipes.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          {/* Internal project evaluation — no PV required */}
          <Button variant="outline" className="w-full sm:w-auto" onClick={openInternalEvalDialog}>
            <ClipboardCheck className="mr-2 h-4 w-4" /> Évaluer projet interne
          </Button>
          {/* PV upload — external projects only */}
          <Button variant="outline" className="w-full sm:w-auto" onClick={openPvUploadDialog}>
            <Upload className="mr-2 h-4 w-4" /> Importer PV
          </Button>
          <Dialog
            open={isAssignOpen}
            onOpenChange={(open) => {
              if (!open) resetAssignForm();
              setIsAssignOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button className="w-full sm:w-auto">Créer un projet</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-xl">Créer et assigner un projet</DialogTitle>
                <DialogDescription>
                  Les projets internes nécessitent une complexité manuelle. Les projets externes utilisent la complexité du PV.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAssign} className="space-y-4">
                <div className="space-y-4 py-2 max-h-[65vh] overflow-y-auto pr-1">
                  <div className="space-y-2">
                    <Label>Type de projet</Label>
                    <Select value={projectType} onValueChange={(v: 'internal' | 'external') => setProjectType(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="internal">Projet interne</SelectItem>
                        <SelectItem value="external">Projet externe</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectName">Nom du projet</Label>
                    <Input
                      id="projectName"
                      placeholder="ex. : Migration Cloud"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      required
                    />
                  </div>
                  {projectType === 'external' && (
                    <div className="space-y-2">
                      <Label htmlFor="clientName">Client <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
                      <Input
                        id="clientName"
                        placeholder="ex. : Nom de l'entreprise"
                        value={clientName}
                        onChange={(e) => setClientName(e.target.value)}
                      />
                    </div>
                  )}
                  {projectType === 'internal' && (
                    <div className="space-y-2">
                      <Label htmlFor="projectComplexity">Complexité</Label>
                      <Select value={projectComplexity} onValueChange={setProjectComplexity}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Faible</SelectItem>
                          <SelectItem value="medium">Moyenne</SelectItem>
                          <SelectItem value="high">Élevée</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startDate">Date de début <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
                      <Input
                        id="startDate"
                        type="date"
                        className="dark:[color-scheme:dark]"
                        value={projectStartDate}
                        onChange={(e) => setProjectStartDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endDate">Date de fin <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
                      <Input
                        id="endDate"
                        type="date"
                        className="dark:[color-scheme:dark]"
                        value={projectEndDate}
                        onChange={(e) => setProjectEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="technologies">Technologies <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
                    <Input
                      id="technologies"
                      placeholder="React, Node.js, AWS"
                      value={projectTechnologies}
                      onChange={(e) => setProjectTechnologies(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectDescription">Résumé du projet <span className="text-muted-foreground font-normal">(optionnel)</span></Label>
                    <Textarea
                      id="projectDescription"
                      placeholder="Contexte court du projet pour l'équipe"
                      value={projectDescription}
                      onChange={(e) => setProjectDescription(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Membres de l'équipe</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Rechercher des membres..."
                        value={assignSearch}
                        onChange={(e) => setAssignSearch(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <div className="max-h-52 overflow-auto rounded-md border p-2 space-y-2">
                      {loadingMembers ? (
                        <p className="text-sm text-muted-foreground">Chargement des membres...</p>
                      ) : filteredMembers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Aucun membre correspondant</p>
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
                                {m.name} ({m.email}) {disabled && '(pas encore de profil)'}
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
                    Annuler
                  </Button>
                  <Button type="submit" disabled={isAssigning}>
                    {isAssigning ? 'Enregistrement...' : 'Créer le projet'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <div className="w-full md:w-64">
            <Input
              placeholder="Rechercher des projets..."
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
          <TabsTrigger value="projects">Projets d'équipe</TabsTrigger>
          <TabsTrigger value="cross-team">Flux inter-équipes</TabsTrigger>
        </TabsList>

        <TabsContent value="projects">
          <Card>
            <CardHeader>
              <CardTitle>Projets assignés</CardTitle>
              <CardDescription>Suivez le travail et le type d'assignation dans votre équipe</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <p className="text-sm text-muted-foreground">Chargement...</p>
              ) : filteredProjects.length === 0 ? (
                <EmptyState
                  icon={<Briefcase />}
                  title="Aucun projet pour l'instant"
                  description="Créez votre premier projet et assignez des membres pour commencer."
                  action={{ label: 'Créer un projet', onClick: () => setIsAssignOpen(true) }}
                />
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
                            <Badge variant="outline">contient un membre externe</Badge>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {project.assignees.length} membre{project.assignees.length === 1 ? '' : 's'} assigné{project.assignees.length === 1 ? '' : 's'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'En cours'}
                        </span>
                      </div>

                      {project.assignees.length > 0 && (
                        <div className="rounded-md bg-muted/50 p-2">
                          <p className="text-xs text-muted-foreground mb-2">Membres assignés</p>
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
                          Vous avez demandé ce membre externe via le flux inter-équipes. Lors de l'import du PV, vous devez décrire la contribution ; le score final est soumis par le manager de l'équipe d'origine.
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
            <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Demandes reçues en attente</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-100">{pendingIncomingCount}</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Demandes en attente d'une décision de votre équipe.</p>
              </CardContent>
            </Card>
            <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Demandes envoyées en attente</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-100">{pendingOutgoingCount}</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Demandes envoyées encore en attente de confirmation.</p>
              </CardContent>
            </Card>
            <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Demandes envoyées approuvées</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-100">{approvedOutgoingCount}</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Demandes déjà associées à un membre externe.</p>
              </CardContent>
            </Card>
          </div>

          <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
            <CardHeader>
              <CardTitle>Demander un membre externe</CardTitle>
              <CardDescription>Sélectionnez le projet, choisissez l'équipe cible, et rédigez un bref opérationnel qui rende la demande immédiatement compréhensible.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.2fr]">
                <div className="space-y-2">
                  <Label>Projet</Label>
                  <Select value={requestProjectId} onValueChange={setRequestProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner un projet" />
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
                  <Label>Équipe cible</Label>
                  <Select value={requestTargetTeamId} onValueChange={setRequestTargetTeamId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionner une équipe" />
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
                  <Label>Contribution attendue</Label>
                  <Textarea
                    value={requestNote}
                    onChange={(e) => setRequestNote(e.target.value)}
                    placeholder="Résumez les livrables, la responsabilité et le contexte attendus du membre demandé"
                    rows={4}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/20 p-4">
                {requestProjectId && (
                  <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4 text-sm">
                    {requestableProjects
                      .filter((project) => project.projectId === requestProjectId)
                      .map((project) => (
                        <div key={project.projectId} className="grid gap-3 md:grid-cols-3 md:items-center">
                          <div className="rounded-xl border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/20 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Projet</p>
                            <p className="font-medium">{project.projectName}</p>
                            <p className="text-muted-foreground text-sm">
                              {project.clientName || 'Aucun client'} • {project.projectType}
                            </p>
                          </div>
                          <div className="rounded-xl border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/20 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Assignation</p>
                            <p className="text-sm text-slate-700 dark:text-slate-300">{project.startDate ? `Assigné le ${formatDate(project.startDate)}` : 'Aucune date d\'assignation'}</p>
                          </div>
                          <div className="rounded-xl border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/20 p-3">
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Objectif de la demande</p>
                            <p className="text-sm text-slate-700 dark:text-slate-300">{requestNote.trim() || 'Ajoutez un bref résumé pour que le manager destinataire puisse agir rapidement.'}</p>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {!requestProjectId && (
                  <div className="rounded-xl border border-dashed border-slate-300 dark:border-border bg-white dark:bg-muted/20 p-4 text-sm text-slate-500 dark:text-slate-400">
                    Sélectionnez un projet pour prévisualiser le résumé avant de l'envoyer.
                  </div>
                )}
              </div>

              <Button onClick={handleCreateCrossTeamRequest} disabled={creatingRequest}>
                  {creatingRequest ? 'Envoi en cours...' : 'Envoyer la demande'}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Inbox className="h-5 w-5 text-slate-700 dark:text-slate-300" />
                Demandes reçues
              </CardTitle>
              <CardDescription>Demandes adressées à votre équipe. Chaque carte indique qui a demandé, pour quel projet, ce dont il a besoin, et l'action à effectuer.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {incomingRequests.length === 0 ? (
                <EmptyState
                  icon={<Inbox />}
                  title="Aucune demande reçue"
                  description="Les autres équipes apparaîtront ici quand elles demanderont un membre de votre équipe."
                />
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
                          ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 ring-2 ring-amber-300 ring-offset-2 dark:ring-offset-background'
                          : pending
                            ? 'border-sky-200 dark:border-sky-800 bg-sky-50/40 dark:bg-sky-950/20'
                            : 'border-slate-200 dark:border-border bg-slate-50/70 dark:bg-muted/10 opacity-70'
                      }`}
                    >
                      {pending && (
                        <div className="flex items-center gap-2 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white">
                          <span className="inline-flex h-2 w-2 rounded-full bg-white animate-pulse" />
                          En attente de votre réponse — choisissez un employé et approuvez ou rejetez
                        </div>
                      )}
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-1">
                          <p className="text-lg font-semibold text-slate-950 dark:text-foreground">{request.projectName}</p>
                          <p className="text-sm text-slate-600 dark:text-slate-400">Demande inter-équipes de {request.requestingTeamName}</p>
                        </div>
                        <Badge className={statusBadgeClass[request.status] || ''} variant={statusVariant(request.status)}>
                          {statusLabel[request.status] || request.status}
                        </Badge>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-3">
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            <UserRound className="h-3.5 w-3.5" /> Manager demandeur
                          </p>
                          <p className="font-medium text-slate-900 dark:text-slate-100">{request.requestingManagerName || 'Manager'}</p>
                          <p className="text-sm text-slate-600 dark:text-slate-400">{request.requestingTeamName || 'Équipe'}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            <BriefcaseBusiness className="h-3.5 w-3.5" /> Contexte du projet
                          </p>
                          <p className="font-medium text-slate-900 dark:text-slate-100">{request.projectName}</p>
                          <p className="text-sm text-slate-600 dark:text-slate-400">{request.clientName || 'Aucun client spécifié'}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            <CalendarClock className="h-3.5 w-3.5" /> Chronologie
                          </p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">Demandé le {formatDate(request.createdAt)}</p>
                          <p className="text-sm text-slate-600 dark:text-slate-400">{request.respondedAt ? `Répondu le ${formatDate(request.respondedAt)}` : 'En attente de votre décision'}</p>
                        </div>
                      </div>

                      {request.projectDescription && (
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Description du projet</p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">{request.projectDescription}</p>
                        </div>
                      )}
                      {request.requestNote && (
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Contribution attendue</p>
                          <p className="text-sm text-slate-700 dark:text-slate-300">{request.requestNote}</p>
                        </div>
                      )}
                      {pending && (
                        <div className="rounded-2xl border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/20 p-4">
                          <p className="mb-3 text-sm font-medium text-sky-900 dark:text-sky-200">Choisissez un employé de votre équipe et répondez à la demande.</p>
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <Select
                              value={selectedIncomingProfiles[request.requestId] || ''}
                              onValueChange={(value) =>
                                setSelectedIncomingProfiles((prev) => ({ ...prev, [request.requestId]: value }))
                              }
                            >
                              <SelectTrigger className="xl:w-[340px] bg-background">
                                <SelectValue placeholder="Sélectionner un employé de votre équipe" />
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
                              Approuver
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => handleRespondRequest(request, false)}
                              disabled={processingRequestId === request.requestId}
                            >
                              Rejeter
                            </Button>
                          </div>
                        </div>
                        </div>
                      )}
                      {!pending && request.selectedEmployeeName && (
                        <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Employé sélectionné</p>
                          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{request.selectedEmployeeName}</p>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5 text-slate-700 dark:text-slate-300" />
                Demandes envoyées
              </CardTitle>
              <CardDescription>Demandes déjà envoyées par votre équipe. Les cartes ci-dessous facilitent la lecture du statut, de l'employé sélectionné et de la prochaine étape.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {outgoingRequests.length === 0 ? (
                <EmptyState
                  icon={<Send />}
                  title="Aucune demande envoyée"
                  description="Dès que vous envoyez une demande inter-équipes, elle apparaîtra ici."
                />
              ) : (
                outgoingRequests.map((request) => {
                  const highlighted = requestIdQuery === request.requestId;
                  return (
                  <div
                    key={request.requestId}
                    id={`request-${request.requestId}`}
                    className={`rounded-2xl border p-4 space-y-4 shadow-sm transition-all ${
                      highlighted
                        ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 ring-2 ring-amber-300 ring-offset-2 dark:ring-offset-background'
                        : request.status === 'pending'
                          ? 'border-sky-200 dark:border-sky-800 bg-sky-50/40 dark:bg-sky-950/20'
                          : 'border-slate-200 dark:border-border bg-slate-50/70 dark:bg-muted/10'
                    }`}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-slate-950 dark:text-foreground">{request.projectName}</p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">Demande envoyée à {request.targetTeamName}</p>
                      </div>
                      <Badge className={statusBadgeClass[request.status] || ''} variant={statusVariant(request.status)}>
                        {statusLabel[request.status] || request.status}
                      </Badge>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          <BriefcaseBusiness className="h-3.5 w-3.5" /> Projet
                        </p>
                        <p className="font-medium text-slate-900 dark:text-slate-100">{request.projectName}</p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">{request.clientName || 'No client specified'}</p>
                      </div>
                      <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          <Users className="h-3.5 w-3.5" /> Équipe cible
                        </p>
                        <p className="font-medium text-slate-900 dark:text-slate-100">{request.targetTeamName}</p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">{request.targetManagerName || 'Manager'}</p>
                      </div>
                      <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-3">
                        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          <CalendarClock className="h-3.5 w-3.5" /> Timeline
                        </p>
                        <p className="text-sm text-slate-700 dark:text-slate-300">Envoyé le {formatDate(request.createdAt)}</p>
                        <p className="text-sm text-slate-600 dark:text-slate-400">{request.respondedAt ? `Traité le ${formatDate(request.respondedAt)}` : 'En attente de réponse'}</p>
                      </div>
                    </div>

                    {request.selectedEmployeeName && (
                      <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Membre externe confirmé</p>
                        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{request.selectedEmployeeName}</p>
                      </div>
                    )}
                    {request.requestNote && (
                      <div className="rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-muted/20 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Contexte de votre demande</p>
                        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{request.requestNote}</p>
                      </div>
                    )}
                    {request.status === 'approved' && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                        Prochaine étape : importez le PV de ce projet, puis renseignez les détails de contribution du membre externe.
                      </div>
                    )}
                    {request.status === 'pending' && (
                      <div className="rounded-xl border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/20 p-4 text-sm text-sky-800">
                        Cette demande est encore en cours d'examen par l'équipe destinataire.
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

      {/* ── PV Upload Dialog — external projects only ───────────────────────── */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Importer le PV</DialogTitle>
            <DialogDescription>
              Pour les projets <strong>externes</strong> uniquement. Soumettez le PV et complétez toutes les saisies en une seule fois : attribuez des scores aux membres internes et décrivez les contributions des membres externes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Fichier PV (PDF)</Label>
              <Input type="file" accept=".pdf" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
            </div>

            <div className="space-y-2">
              <Label>Projet externe</Label>
              <Select value={uploadProjectId} onValueChange={handleUploadProjectChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionner un projet externe" />
                </SelectTrigger>
                <SelectContent>
                  {externalProjects.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">Aucun projet externe disponible</div>
                  ) : (
                    externalProjects.map((project) => (
                      <SelectItem key={project.project_id} value={project.project_id}>
                        {project.projectName}{project.startDate ? ` — ${project.startDate}` : ''}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {selectedUploadProject && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium">{selectedUploadProject.projectName}</p>
                    <p className="text-sm text-muted-foreground">{selectedUploadProject.clientName || 'Aucun client'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedUploadProject.complexity && (
                      <Badge
                        variant="outline"
                        className={complexityBadgeClass[selectedUploadProject.complexity] || ''}
                      >
                        Complexité : {complexityLabel[selectedUploadProject.complexity] || selectedUploadProject.complexity}
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {selectedUploadProject.participants.length} participant{selectedUploadProject.participants.length === 1 ? '' : 's'}
                    </Badge>
                    {selectedUploadProject.startDate && (
                      <Badge variant="outline">Assigné le {formatDate(selectedUploadProject.startDate)}</Badge>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Participants</Label>
              {selectedUploadParticipants.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sélectionnez un projet pour charger les participants.</p>
              ) : (
                <div className="space-y-2">
                  {selectedUploadParticipants.map((participant) => {
                    const member = members.find((m) => m.profileId === participant.profileId);
                    const displayName = member?.name || participant.name;
                    return (
                      <div key={participant.profileId} className="rounded-md border p-3 space-y-2">
                        <label className="flex items-center gap-2 text-sm">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-300">inclus</span>
                          <span className="font-medium">{displayName}</span>
                          <Badge variant="outline">{participant.assignmentType}</Badge>
                          {participant.assignmentType === 'internal' ? (
                            <span className="text-xs text-sky-700 font-normal">score requis</span>
                          ) : (
                            <span className="text-xs text-amber-600 font-normal">décrire la contribution pour la révision du manager d'origine</span>
                          )}
                        </label>

                        {participant.assignmentType === 'internal' && (
                          <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/70 p-3">
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-sky-950">Score d'exécution (0–20)</Label>
                              <p className="text-xs text-sky-900 dark:text-sky-200">
                                Score × plafond de complexité = contribution finale. Ex. : 16/20 sur un projet Élevé → (16/20) × 85 = 68/100.
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
                            <Label className="text-xs font-semibold text-amber-950">Qu'a réellement fait ce membre externe ?</Label>
                            <Textarea
                              value={uploadContributions[participant.profileId] || ''}
                              onChange={(e) =>
                                setUploadContributions((prev) => ({
                                  ...prev,
                                  [participant.profileId]: e.target.value,
                                }))
                              }
                              placeholder="Exemple : a géré l'intégration API, coordonné les tests avec le client, résolu les blocages de déploiement, et livré le script prêt pour la production."
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
            {pvInternalParticipants.length > 0 && (
              <div className={`flex-1 flex items-center gap-2 text-sm ${pvAllScoresEntered ? 'text-emerald-700' : 'text-sky-700'}`}>
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-white ${pvAllScoresEntered ? 'bg-emerald-500' : 'bg-sky-500'}`}>
                  {pvScoredCount}
                </span>
                <span>/ {pvInternalParticipants.length} score{pvInternalParticipants.length > 1 ? 's' : ''} d'exécution saisi{pvInternalParticipants.length > 1 ? 's' : ''}</span>
              </div>
            )}
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              Annuler
            </Button>
            <Button onClick={handleUploadPv} disabled={!canUpload}>
              {uploading ? 'Import en cours...' : 'Importer le PV'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Internal Project Evaluation Dialog ─────────────────────────────── */}
      <Dialog open={internalEvalOpen} onOpenChange={setInternalEvalOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              Évaluer un projet interne
            </DialogTitle>
            <DialogDescription>
              Attribuez une note d'exécution (0–20) à chaque participant. Aucun PV n'est requis pour les projets internes — la complexité est définie à la création du projet.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Projet interne</Label>
              <Select value={internalEvalProjectId} onValueChange={handleInternalEvalProjectChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionner un projet interne" />
                </SelectTrigger>
                <SelectContent>
                  {internalProjects.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">Aucun projet interne disponible</div>
                  ) : (
                    internalProjects.map((project) => (
                      <SelectItem key={project.project_id} value={project.project_id}>
                        {project.projectName}{project.complexity ? ` — ${complexityLabel[project.complexity] || project.complexity}` : ''}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {selectedInternalProject && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium">{selectedInternalProject.projectName}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedInternalProject.endDate
                        ? `Date de fin : ${formatDate(selectedInternalProject.endDate)}`
                        : 'Projet en cours'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedInternalProject.complexity && (
                      <Badge
                        variant="outline"
                        className={complexityBadgeClass[selectedInternalProject.complexity] || ''}
                      >
                        Complexité : {complexityLabel[selectedInternalProject.complexity] || selectedInternalProject.complexity}
                        {' '}(plafond {complexityCeiling[selectedInternalProject.complexity] || 65}/100)
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {selectedInternalProject.participants.length} participant{selectedInternalProject.participants.length === 1 ? '' : 's'}
                    </Badge>
                  </div>
                </div>
              </div>
            )}

            {internalProjectParticipants.length === 0 && internalEvalProjectId && (
              <p className="text-sm text-muted-foreground rounded-md border border-dashed p-4 text-center">
                Ce projet n'a aucun participant enregistré.
              </p>
            )}

            {internalProjectParticipants.length > 0 && (
              <div className="space-y-2">
                <Label>Notation des participants</Label>
                <div className="space-y-2">
                  {internalProjectParticipants.map((participant) => {
                    const member = members.find((m) => m.profileId === participant.profileId);
                    const displayName = member?.name || participant.name;
                    const complexity = selectedInternalProject?.complexity || 'medium';
                    const ceiling = complexityCeiling[complexity] || 65;
                    const rawScore = internalEvalScores[participant.profileId];
                    const parsedScore = rawScore !== undefined && rawScore !== '' ? Number(rawScore) : null;
                    const previewScore =
                      parsedScore !== null && Number.isFinite(parsedScore) && parsedScore >= 0 && parsedScore <= 20
                        ? ((parsedScore / 20) * ceiling).toFixed(1)
                        : null;

                    return (
                      <div key={participant.profileId} className="rounded-md border p-3 space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <p className="font-medium text-sm">{displayName}</p>
                          </div>
                          {previewScore !== null && (
                            <div className="text-xs text-emerald-700 dark:text-emerald-400 font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-full px-2 py-0.5">
                              → {previewScore} / {ceiling} pts
                            </div>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-sky-900 dark:text-sky-200">Score d'exécution (0–20)</Label>
                          <p className="text-xs text-muted-foreground">
                            (score / 20) × {ceiling} = contribution au pilier Projets
                          </p>
                          <Input
                            type="number"
                            min={0}
                            max={20}
                            step={0.5}
                            placeholder="ex. : 15"
                            value={internalEvalScores[participant.profileId] || ''}
                            onChange={(e) =>
                              setInternalEvalScores((prev) => ({ ...prev, [participant.profileId]: e.target.value }))
                            }
                            className="max-w-[120px]"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            {internalProjectParticipants.length > 0 && (
              <div className={`flex-1 flex items-center gap-2 text-sm ${internalAllScoresEntered ? 'text-emerald-700' : 'text-sky-700'}`}>
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold text-white ${internalAllScoresEntered ? 'bg-emerald-500' : 'bg-sky-500'}`}>
                  {internalScoredCount}
                </span>
                <span>/ {internalProjectParticipants.length} score{internalProjectParticipants.length > 1 ? 's' : ''} saisi{internalProjectParticipants.length > 1 ? 's' : ''}</span>
                {!internalAllScoresEntered && (
                  <span className="text-xs text-sky-600">— saisissez tous les scores pour valider</span>
                )}
              </div>
            )}
            <Button variant="outline" onClick={() => setInternalEvalOpen(false)}>
              Annuler
            </Button>
            <Button
              onClick={handleSubmitInternalEval}
              disabled={submittingInternalEval || !internalAllScoresEntered}
            >
              {submittingInternalEval ? 'Enregistrement...' : 'Valider les évaluations'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerProjectsPage;
