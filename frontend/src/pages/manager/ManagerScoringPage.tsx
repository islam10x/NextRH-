import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
import { Trophy, Calculator, FileCheck, ClipboardList, Info, BriefcaseBusiness, UserRound, CalendarClock, ChevronRight } from 'lucide-react';
import {
  scoringService,
  LeaderboardEntry,
  EmployeeScore,
  ProjectScoreDetail,
  PendingExternalEvaluation,
} from '@/services/scoring.service';
import { teamService } from '@/services/team.service';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
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

const ManagerScoringPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [year, setYear] = useState(currentYear);

  const [pendingExternalEvaluations, setPendingExternalEvaluations] = useState<PendingExternalEvaluation[]>([]);
  const [externalScores, setExternalScores] = useState<Record<string, string>>({});
  const [submittingExternal, setSubmittingExternal] = useState<string | null>(null);

  const [targetOpen, setTargetOpen] = useState(false);
  const [targetProfileId, setTargetProfileId] = useState('');
  const [targetCertValue, setTargetCertValue] = useState(2);
  const [settingTarget, setSettingTarget] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);
  const [selectedScore, setSelectedScore] = useState<EmployeeScore | null>(null);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);

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

  const handleOpenBreakdown = async (entry: LeaderboardEntry) => {
    setSelectedEntry(entry);
    setSelectedScore(null);
    setBreakdownOpen(true);
    setLoadingBreakdown(true);
    try {
      const score = await scoringService.getScore(entry.profileId, year);
      setSelectedScore(score);
    } catch {
      setSelectedScore(null);
    } finally {
      setLoadingBreakdown(false);
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
      window.dispatchEvent(new Event('scoring:updated'));

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
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Team Scoring</h1>
            {pendingReviewsCount > 0 && (
              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                {pendingReviewsCount} pending external review{pendingReviewsCount > 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">Use this page for ranking visibility and external review decisions.</p>
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
        <Button variant="outline" onClick={() => setTargetOpen(true)}>
          <FileCheck className="mr-2 h-4 w-4" /> Set Certification Target
        </Button>
        <Button variant="secondary" onClick={handleComputeTeam} disabled={loading}>
          <Calculator className="mr-2 h-4 w-4" />
          {loading ? 'Computing...' : 'Compute Scores'}
        </Button>
      </div>

      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Trophy className="h-5 w-5 text-slate-700" />
            Team Ranking {year}
          </CardTitle>
          <CardDescription>Open on the full team ranking by default. Click a member row to inspect exactly how the score was built.</CardDescription>
        </CardHeader>
        <CardContent>
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
                    <TableHead className="w-20 text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fullTeamScores.map((entry) => (
                    <TableRow
                      key={entry.profileId}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => handleOpenBreakdown(entry)}
                    >
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
                      <TableCell className="text-right">
                        <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

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

      <Dialog open={breakdownOpen} onOpenChange={setBreakdownOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedEntry?.employeeName || 'Score Breakdown'}</DialogTitle>
            <DialogDescription>Detailed score explanation for {year}. This dialog shows the exact pillars and project contributions currently counted in the employee&apos;s score.</DialogDescription>
          </DialogHeader>
          {loadingBreakdown ? (
            <p className="py-8 text-center text-muted-foreground">Loading score breakdown...</p>
          ) : !selectedScore ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              No computed annual score is available yet for this employee.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Final</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{selectedScore.finalScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Projects</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{selectedScore.projectScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Certifications</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{selectedScore.certificationScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Trainings</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{selectedScore.trainingScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Formations</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">{selectedScore.formationScore.toFixed(1)}</p>
                </div>
              </div>

              {selectedScore.scoreDetails?.headline && (
                <Alert className="border-slate-200 bg-slate-50">
                  <Info className="h-4 w-4 text-slate-700" />
                  <AlertTitle>{selectedScore.scoreDetails.headline.title}</AlertTitle>
                  <AlertDescription>{selectedScore.scoreDetails.headline.message}</AlertDescription>
                </Alert>
              )}

              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="text-base">Applied formulas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-700">
                  <p>{selectedScore.scoreDetails?.formulas?.projects || 'Project contribution is based on manager score when available, otherwise on project complexity only.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.certifications || 'Certification score depends on progress against the annual target.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.trainings || 'Completed trainings add 20 points each.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.formations || 'Delivered formations add 25 points each.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.final || 'Final score = average of the four pillars.'}</p>
                </CardContent>
              </Card>

              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="text-base">Project contribution details</CardTitle>
                  <CardDescription>Each card below explains one project currently counted in the employee&apos;s score.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(selectedScore.scoreDetails?.pillars?.projects?.items || []).length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
                      No project contribution is currently counted for this employee.
                    </div>
                  ) : (
                    (selectedScore.scoreDetails?.pillars?.projects?.items || []).map((project: ProjectScoreDetail) => (
                      <div key={`${project.project_name}-${project.completion_date || 'undated'}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-slate-900">{project.project_name}</p>
                              <Badge className={complexityColor[project.complexity]}>{project.complexity}</Badge>
                              <Badge variant="outline">{project.evaluation_status}</Badge>
                              {project.pv_verified && <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Verified PV</Badge>}
                            </div>
                            <p className="text-xs text-slate-500">Reference date: {project.completion_date || 'Current assignment year'}</p>
                            <p className="text-sm text-slate-700">{project.explanation}</p>
                          </div>
                          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-right">
                            <p className="text-xs uppercase tracking-wide text-slate-500">Contribution</p>
                            <p className="mt-1 text-2xl font-semibold text-slate-900">{project.contribution_score.toFixed(1)}</p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          )}
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
