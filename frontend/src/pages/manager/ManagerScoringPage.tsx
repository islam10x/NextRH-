import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Upload, Trophy, Calculator, FileCheck, ClipboardList, ArrowRight, Info, Eye, BriefcaseBusiness, UserRound, CalendarClock } from 'lucide-react';
import {
  scoringService,
  LeaderboardEntry,
  AvailableProject,
  PendingExternalEvaluation,
} from '@/services/scoring.service';
import { teamService } from '@/services/team.service';
import { useAuth } from '@/contexts/AuthContext';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const currentYear = new Date().getFullYear();

const complexityLabel: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const complexityColor: Record<string, string> = {
  low: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
  medium: 'border border-sky-200 bg-sky-50 text-sky-700',
  high: 'border border-rose-200 bg-rose-50 text-rose-700',
};

const formatDate = (dateString?: string | null) => {
  if (!dateString) return 'No date';
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return parsed.toLocaleDateString();
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

const getApiErrorStatus = (error: unknown) => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    return (error as { response?: { status?: number } }).response?.status;
  }

  return undefined;
};

const ManagerScoringPage: React.FC = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [year, setYear] = useState(currentYear);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState('');
  const [uploadComplexity, setUploadComplexity] = useState<'low' | 'medium' | 'high'>('medium');
  const [uploadProfileIds, setUploadProfileIds] = useState<string[]>([]);
  const [uploadScores, setUploadScores] = useState<Record<string, string>>({});
  const [uploadContributions, setUploadContributions] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<AvailableProject[]>([]);
  const [pendingExternalEvaluations, setPendingExternalEvaluations] = useState<PendingExternalEvaluation[]>([]);
  const [externalScores, setExternalScores] = useState<Record<string, string>>({});
  const [submittingExternal, setSubmittingExternal] = useState<string | null>(null);

  const [targetOpen, setTargetOpen] = useState(false);
  const [targetProfileId, setTargetProfileId] = useState('');
  const [targetCertValue, setTargetCertValue] = useState(2);
  const [settingTarget, setSettingTarget] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  const selectedProject = useMemo(
    () => availableProjects.find((project) => project.project_id === uploadProjectId),
    [availableProjects, uploadProjectId],
  );
  const selectedParticipants = useMemo(() => selectedProject?.participants || [], [selectedProject]);
  const focusedRecordId = searchParams.get('recordId');

  const orderedPendingEvaluations = useMemo(() => {
    if (!focusedRecordId) return pendingExternalEvaluations;
    return [...pendingExternalEvaluations].sort((left, right) => {
      if (left.recordId === focusedRecordId) return -1;
      if (right.recordId === focusedRecordId) return 1;
      return 0;
    });
  }, [focusedRecordId, pendingExternalEvaluations]);

  const loadMembers = async () => {
    try {
      const data = await teamService.listMyMembers();
      setMembers(
        data.map((m) => ({
          userId: m.userId,
          profileId: m.profileId,
          name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
          email: m.email,
        })),
      );
    } catch {
      toast.error('Failed to load team members');
    }
  };

  const loadLeaderboard = async () => {
    setLoading(true);
    try {
      const data = await scoringService.getLeaderboard(year);
      setLeaderboard(data);
    } catch {
      setLeaderboard([]);
    } finally {
      setLoading(false);
    }
  };

  const loadPendingExternalEvaluations = async () => {
    if (user?.role !== 'team_manager') {
      setPendingExternalEvaluations([]);
      return;
    }

    try {
      const rows = await scoringService.listPendingExternalEvaluations();
      setPendingExternalEvaluations(rows);
    } catch {
      setPendingExternalEvaluations([]);
    }
  };

  useEffect(() => {
    loadMembers();
  }, []);

  useEffect(() => {
    loadLeaderboard();
    loadPendingExternalEvaluations();
  }, [year, user?.role]);

  const getFullTeamScores = (): LeaderboardEntry[] => {
    const scoredProfileIds = new Set(leaderboard.map((e) => e.profileId));
    const unscoredMembers: LeaderboardEntry[] = members
      .filter((m) => m.profileId && !scoredProfileIds.has(m.profileId))
      .map((m) => ({
        rank: 0,
        profileId: m.profileId!,
        employeeName: m.name,
        finalScore: 0,
        projectScore: 0,
        certificationScore: 0,
        trainingScore: 0,
        formationScore: 0,
        percentile: null,
      }));
    return [...leaderboard, ...unscoredMembers];
  };

  const fullTeamScores = getFullTeamScores();
  const scoredMembersCount = leaderboard.length;
  const pendingReviewsCount = orderedPendingEvaluations.length;
  const totalMembersCount = fullTeamScores.length;

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
    } catch {
      setAvailableProjects([]);
    }
  };

  const handleProjectChange = (projectId: string) => {
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
      toast.error('Select at least one participant');
      return;
    }

    const participantsById = new Map(
      selectedParticipants.map((participant) => [participant.profileId, participant]),
    );
    for (const profileId of uploadProfileIds) {
      const participant = participantsById.get(profileId);
      if (!participant) continue;
      const internalRawScore = uploadScores[profileId];
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
      await loadLeaderboard();
      await loadPendingExternalEvaluations();
    } catch (error: unknown) {
      if (getApiErrorStatus(error) === 409) {
        toast.warning(getApiErrorMessage(error, 'This PV was already submitted.'));
      } else {
        toast.error(getApiErrorMessage(error, 'PV upload failed'));
      }
    } finally {
      setUploading(false);
    }
  };

  const handleSetTarget = async () => {
    if (!targetProfileId) return;
    setSettingTarget(true);
    try {
      await scoringService.setTarget(targetProfileId, year, targetCertValue);
      toast.success('Certification target updated');
      setTargetOpen(false);
      await loadLeaderboard();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to set target'));
    } finally {
      setSettingTarget(false);
    }
  };

  const handleComputeTeam = async () => {
    setLoading(true);
    try {
      await scoringService.computeTeamScores(year);
      toast.success('Team scores computed');
      await loadLeaderboard();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Score calculation failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitExternalScore = async (recordId: string) => {
    const rawScore = externalScores[recordId];
    const numericScore = Number(rawScore);
    if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 20) {
      toast.error('Enter a score between 0 and 20.');
      return;
    }

    setSubmittingExternal(recordId);
    try {
      await scoringService.scoreExternalEvaluation(recordId, numericScore);
      toast.success('External evaluation saved and added to the score');
      setExternalScores((prev) => ({ ...prev, [recordId]: '' }));
      await Promise.all([loadPendingExternalEvaluations(), loadLeaderboard()]);

      if (focusedRecordId === recordId) {
        const next = new URLSearchParams(searchParams.toString());
        next.delete('recordId');
        next.delete('panel');
        setSearchParams(next, { replace: true });
      }
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Failed to submit external score'));
    } finally {
      setSubmittingExternal(null);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team Scoring</h1>
          <p className="text-muted-foreground">Upload PVs, score your members, and track team performance.</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Button onClick={openUploadDialog}>
          <Upload className="mr-2 h-4 w-4" /> Upload PV
        </Button>
        <Button variant="outline" onClick={() => setTargetOpen(true)}>
          <FileCheck className="mr-2 h-4 w-4" /> Set Certification Target
        </Button>
        <Button variant="secondary" onClick={handleComputeTeam} disabled={loading}>
          <Calculator className="mr-2 h-4 w-4" />
          {loading ? 'Computing...' : 'Compute Scores'}
        </Button>
        <Button variant="outline" onClick={() => setLeaderboardOpen(true)}>
          <Eye className="mr-2 h-4 w-4" /> View Team Ranking
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
        <Alert className="border-slate-200 bg-gradient-to-r from-slate-50 via-white to-slate-100">
          <Info className="h-4 w-4 text-sky-700" />
          <AlertTitle>Scoring workflow for managers</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Internal team members are scored directly by you on a 0 to 20 scale, then automatically converted into the project pillar on a 0 to 100 scale.
            </p>
            <p>
              External members receive an immediate provisional score from project complexity and verified PV status, then their home manager finalizes the score after reading your contribution description.
            </p>
          </AlertDescription>
        </Alert>

        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Scoring Overview</CardTitle>
            <CardDescription>Use this space to upload evidence, review pending requests, and open ranking only when you need it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pending reviews</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{pendingReviewsCount}</p>
              <p className="mt-1 text-sm text-slate-600">Requests waiting for a home manager decision.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scored members</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{scoredMembersCount}</p>
              <p className="mt-1 text-sm text-slate-600">Employees already visible in the current ranking.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team members</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{totalMembersCount}</p>
              <p className="mt-1 text-sm text-slate-600">All members currently in your team perimeter.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {user?.role === 'team_manager' && (orderedPendingEvaluations.length > 0 || focusedRecordId) && (
        <Card className="border-slate-200 bg-white shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <ClipboardList className="h-5 w-5 text-slate-700" />
                  Incoming Review Requests
                </CardTitle>
                <CardDescription>
                  Each card below is one pending decision. Identity, project context, manager notes, and scoring action are separated so you can review faster with less visual noise.
                </CardDescription>
              </div>
              <Badge className="w-fit bg-sky-600 text-white hover:bg-sky-600">
                {orderedPendingEvaluations.length} pending
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {orderedPendingEvaluations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-muted-foreground">
                This external evaluation is no longer pending.
              </div>
            ) : (
              orderedPendingEvaluations.map((item) => {
                const isFocused = item.recordId === focusedRecordId;
                return (
                  <div
                    key={item.recordId}
                    className={`rounded-2xl border p-4 shadow-sm transition-colors ${
                      isFocused
                        ? 'border-sky-300 bg-sky-50/30 ring-2 ring-sky-100'
                        : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr_320px]">
                      <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-semibold text-slate-950">{item.employeeName}</p>
                          <Badge className={complexityColor[item.complexity || 'medium'] || complexityColor.medium}>
                            {complexityLabel[item.complexity || 'medium'] || 'Medium'} complexity
                          </Badge>
                          {isFocused && <Badge className="border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-50">Opened from notification</Badge>}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-slate-200 bg-white p-3">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              <UserRound className="h-3.5 w-3.5" /> Employee
                            </p>
                            <p className="font-medium text-slate-900">{item.employeeName}</p>
                            <p className="text-sm text-slate-600">External member review pending final decision.</p>
                          </div>
                          <div className="rounded-xl border border-slate-200 bg-white p-3">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              <BriefcaseBusiness className="h-3.5 w-3.5" /> Project
                            </p>
                            <p className="font-medium text-slate-900">{item.projectName}</p>
                            <p className="text-sm text-slate-600">{item.clientName || 'No client specified'}</p>
                          </div>
                          <div className="rounded-xl border border-slate-200 bg-white p-3 sm:col-span-2">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              <CalendarClock className="h-3.5 w-3.5" /> Timing
                            </p>
                            <p className="text-sm text-slate-700">Submitted {formatDate(item.createdAt)} and linked to PV dated {formatDate(item.completionDate)}.</p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Project manager summary
                        </p>
                        <p className="text-sm leading-6 text-slate-800">
                          {item.externalContributionDescription || 'No contribution description was provided.'}
                        </p>
                      </div>

                      <div className="w-full space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div>
                          <Label className="text-sm font-semibold">Final score (/20)</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            This score is converted to /100 and becomes the definitive project contribution for the employee.
                          </p>
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={20}
                          step="0.5"
                          placeholder="Example: 16.5"
                          value={externalScores[item.recordId] || ''}
                          onChange={(e) =>
                            setExternalScores((prev) => ({ ...prev, [item.recordId]: e.target.value }))
                          }
                        />
                        <Button
                          className="w-full"
                          onClick={() => handleSubmitExternalScore(item.recordId)}
                          disabled={submittingExternal === item.recordId}
                        >
                          {submittingExternal === item.recordId ? 'Saving...' : 'Submit score and update ranking'}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={leaderboardOpen} onOpenChange={setLeaderboardOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Team Ranking {year}</DialogTitle>
            <DialogDescription>
              Open the ranking when you need comparison details, without keeping it in the main workspace all the time.
            </DialogDescription>
          </DialogHeader>
          {fullTeamScores.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">No team members available.</p>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Rank</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead className="text-right">Projects</TableHead>
                    <TableHead className="text-right">Cert.</TableHead>
                    <TableHead className="text-right">Training</TableHead>
                    <TableHead className="text-right">Formation</TableHead>
                    <TableHead className="text-right">Final</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fullTeamScores.map((entry) => (
                    <TableRow key={entry.profileId}>
                      <TableCell>
                        {entry.rank > 0 ? (
                          <Badge variant={entry.rank <= 3 ? 'default' : 'secondary'}>
                            #{entry.rank}
                          </Badge>
                        ) : (
                          <Badge variant="outline">—</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{entry.employeeName}</TableCell>
                      <TableCell className="text-right">{entry.projectScore.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{entry.certificationScore.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{entry.trainingScore.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{(entry.formationScore ?? 0).toFixed(1)}</TableCell>
                      <TableCell className="text-right font-bold">{entry.finalScore.toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload PV</DialogTitle>
            <DialogDescription>
              For internal members, give a manager score out of 20. For external members, add a concise contribution summary for the home manager review.
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
                <Select value={uploadProjectId} onValueChange={handleProjectChange}>
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

            {selectedProject && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-medium">{selectedProject.projectName}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedProject.clientName || 'No client'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{selectedProject.projectType}</Badge>
                    <Badge variant="outline">
                      {selectedProject.participants.length} participant{selectedProject.participants.length === 1 ? '' : 's'}
                    </Badge>
                    {selectedProject.startDate && (
                      <Badge variant="outline">Assigned {formatDate(selectedProject.startDate)}</Badge>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>Participants</Label>
              {selectedParticipants.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Select a project to load participants.
                </p>
              ) : (
                <div className="space-y-2">
                  {selectedParticipants.map((participant) => {
                    const member = members.find((m) => m.profileId === participant.profileId);
                    const displayName = member?.name || participant.name;
                    const isExternal = participant.assignmentType === 'external';
                    return (
                      <div key={participant.profileId} className="rounded-md border p-3 space-y-2">
                        <label className="flex items-center gap-2 text-sm">
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                            included
                          </span>
                          <span className="font-medium">{displayName}</span>
                          <Badge variant="outline">{participant.assignmentType}</Badge>
                          {isExternal && (
                            <span className="text-xs text-amber-600 font-normal">
                              describe contribution only
                            </span>
                          )}
                        </label>

                        {participant.assignmentType === 'internal' && (
                          <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/70 p-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Individual score (0-20)</Label>
                              <p className="text-xs text-sky-900">
                                This manager score is converted to /100 for the project pillar: for example 16/20 becomes 80/100.
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
                            <div className="flex items-center gap-2 text-[11px] text-sky-900">
                              <ArrowRight className="h-3.5 w-3.5" />
                              Encourage consistency: use the same standard across team members so employees can trust the scoring process.
                            </div>
                          </div>
                        )}

                        {participant.assignmentType === 'external' && (
                          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/70 p-3">
                            <Label className="text-xs font-semibold text-amber-950">
                              What did this external member actually do?
                            </Label>
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
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUploadPv} disabled={uploading}>
              {uploading ? 'Uploading...' : 'Upload PV'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Certification Target {year}</DialogTitle>
            <DialogDescription>
              Set yearly certification target for one member in your team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Employee</Label>
              <Select value={targetProfileId} onValueChange={setTargetProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {members
                    .filter((m) => m.profileId)
                    .map((m) => (
                      <SelectItem key={m.profileId!} value={m.profileId!}>
                        {m.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Certification count</Label>
              <Input
                type="number"
                min={0}
                max={20}
                value={targetCertValue}
                onChange={(e) => setTargetCertValue(Number(e.target.value))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTargetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSetTarget} disabled={settingTarget || !targetProfileId}>
              {settingTarget ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerScoringPage;
