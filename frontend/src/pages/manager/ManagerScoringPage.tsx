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
import { EmptyState } from '@/components/common/EmptyState';
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

const complexityLabel: Record<string, string> = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
const complexityColor: Record<string, string> = {
  low: 'border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400',
  medium: 'border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400',
  high: 'border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400',
};

const formatDate = (dateString?: string | null) => {
  if (!dateString) return 'Aucune date';
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
      toast.error("Impossible de charger les membres — veuillez actualiser la page.");
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
  const pendingReviewsCount = orderedPendingEvaluations.length;
  const totalMembersCount = fullTeamScores.length;
  const scoredEntries = leaderboard.filter((e) => e.finalScore > 0);
  const scoredMembersCount = scoredEntries.length;
  const avgScore = scoredMembersCount > 0
    ? scoredEntries.reduce((sum, e) => sum + e.finalScore, 0) / scoredMembersCount
    : null;
  const topEntry = scoredEntries[0] ?? null;

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
      toast.success('Objectif de certification mis à jour');
      setTargetOpen(false);
      await loadLeaderboard();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Impossible de définir l\'objectif'));
    } finally {
      setSettingTarget(false);
    }
  };

  const handleComputeTeam = async () => {
    setLoading(true);
    try {
      await scoringService.computeTeamScores(year);
      toast.success('Scores de l\'équipe calculés');
      await loadLeaderboard();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'Échec du calcul des scores'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitExternalScore = async (recordId: string) => {
    const rawScore = externalScores[recordId];
    const numericScore = Number(rawScore);
    if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 20) {
      toast.error('Saisissez un score entre 0 et 20.');
      return;
    }

    setSubmittingExternal(recordId);
    try {
      await scoringService.scoreExternalEvaluation(recordId, numericScore);
      toast.success('Évaluation externe enregistrée et ajoutée au score');
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
      toast.error(getApiErrorMessage(error, 'Échec de la soumission du score externe'));
    } finally {
      setSubmittingExternal(null);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Scoring d'équipe</h1>
            {pendingReviewsCount > 0 && (
              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                {pendingReviewsCount} révision{pendingReviewsCount > 1 ? 's' : ''} externe{pendingReviewsCount > 1 ? 's' : ''} en attente
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">Utilisez cette page pour la visibilité du classement et les décisions de révision externe.</p>
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
          <FileCheck className="mr-2 h-4 w-4" /> Définir un objectif de certification
        </Button>
        <Button variant="secondary" onClick={handleComputeTeam} disabled={loading}>
          <Calculator className="mr-2 h-4 w-4" />
          {loading ? 'Calcul en cours...' : 'Calculer les scores'}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Membres évalués</CardTitle>
            <Trophy className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{scoredMembersCount}<span className="text-lg font-normal text-muted-foreground"> / {totalMembersCount}</span></div>
            <p className="text-xs text-muted-foreground mt-1">Ont un score pour {year}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Moyenne de l'équipe</CardTitle>
            <Calculator className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{avgScore !== null ? avgScore.toFixed(1) : '—'}</div>
            <p className="text-xs text-muted-foreground mt-1">Moyenne du score final</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Meilleur performeur</CardTitle>
            <Trophy className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">{topEntry ? topEntry.employeeName.split(' ')[0] : '—'}</div>
            <p className="text-xs text-muted-foreground mt-1">{topEntry ? `Score : ${topEntry.finalScore.toFixed(1)}` : 'Aucun score disponible'}</p>
          </CardContent>
        </Card>

      </div>

      <Card className="border-border bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Trophy className="h-5 w-5 text-foreground" />
            Classement de l'équipe {year}
          </CardTitle>
          <CardDescription>Affiche le classement complet de l'équipe par défaut. Cliquez sur une ligne pour voir le détail du calcul du score.</CardDescription>
        </CardHeader>
        <CardContent>
          {fullTeamScores.length === 0 ? (
            <EmptyState
              icon={<Trophy />}
              title="Aucun score disponible"
              description="Les scores apparaîtront ici une fois que les membres de l'équipe auront importé leur CV et été évalués."
            />
          ) : (
            <div className="rounded-2xl border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Rang</TableHead>
                    <TableHead>Employé</TableHead>
                    <TableHead className="text-right">Projets</TableHead>
                    <TableHead className="text-right">Cert.</TableHead>
                    <TableHead className="text-right">Formation</TableHead>
                    <TableHead className="text-right">Formations</TableHead>
                    <TableHead className="text-right">Final</TableHead>
                    <TableHead className="w-20 text-right">Détails</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fullTeamScores.map((entry) => (
                    <TableRow
                      key={entry.profileId}
                      className="cursor-pointer hover:bg-muted/50"
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
                        <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
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
        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <ClipboardList className="h-5 w-5 text-foreground" />
                  Demandes d'évaluation reçues
                </CardTitle>
                <CardDescription>
                  Chaque carte ci-dessous correspond à une décision en attente. L'identité, le contexte du projet, les notes du manager et l'action de scoring sont séparés pour faciliter la révision.
                </CardDescription>
              </div>
              <Badge className="w-fit bg-sky-600 text-white hover:bg-sky-600">
                {orderedPendingEvaluations.length} en attente
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {orderedPendingEvaluations.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-card/70 p-4 text-sm text-muted-foreground">
                Cette évaluation externe n'est plus en attente.
              </div>
            ) : (
              orderedPendingEvaluations.map((item) => {
                const isFocused = item.recordId === focusedRecordId;
                return (
                  <div
                    key={item.recordId}
                    className={`rounded-2xl border p-4 shadow-sm transition-colors ${
                      isFocused
                        ? 'border-sky-300 dark:border-sky-700 bg-sky-50/30 dark:bg-sky-950/20 ring-2 ring-sky-100 dark:ring-sky-900'
                        : 'border-border bg-card'
                    }`}
                  >
                    <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr_320px]">
                      <div className="space-y-3 rounded-2xl border border-border bg-muted/50 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-semibold text-foreground">{item.employeeName}</p>
                          <Badge className={complexityColor[item.complexity || 'medium'] || complexityColor.medium}>
                            {complexityLabel[item.complexity || 'medium'] || 'Medium'} complexity
                          </Badge>
                          {isFocused && <Badge className="border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/30">Ouvert depuis une notification</Badge>}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-border bg-card p-3">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              <UserRound className="h-3.5 w-3.5" /> Employé
                            </p>
                            <p className="font-medium text-foreground">{item.employeeName}</p>
                            <p className="text-sm text-muted-foreground">Évaluation du membre externe en attente de décision finale.</p>
                          </div>
                          <div className="rounded-xl border border-border bg-card p-3">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              <BriefcaseBusiness className="h-3.5 w-3.5" /> Projet
                            </p>
                            <p className="font-medium text-foreground">{item.projectName}</p>
                            <p className="text-sm text-muted-foreground">{item.clientName || 'Aucun client spécifié'}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-card p-3 sm:col-span-2">
                            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              <CalendarClock className="h-3.5 w-3.5" /> Calendrier
                            </p>
                            <p className="text-sm text-foreground">Soumis le {formatDate(item.createdAt)} et lié au PV daté du {formatDate(item.completionDate)}.</p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-border bg-card p-4">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Résumé du chef de projet
                        </p>
                        <p className="text-sm leading-6 text-foreground">
                          {item.externalContributionDescription || 'Aucune description de contribution n\'a été fournie.'}
                        </p>
                      </div>

                      <div className="w-full space-y-3 rounded-2xl border border-border bg-muted/50 p-4">
                        <div>
                          <Label className="text-sm font-semibold">Score final (/20)</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Ce score est converti en /100 et devient la contribution définitive au projet pour l'employé.
                          </p>
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={20}
                          step="0.5"
                          placeholder="Exemple : 16.5"
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
                          {submittingExternal === item.recordId ? 'Enregistrement...' : 'Soumettre le score et mettre à jour le classement'}
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
            <DialogTitle>{selectedEntry?.employeeName || 'Détail du score'}</DialogTitle>
            <DialogDescription>Explication détaillée du score pour {year}. Ce panneau affiche les piliers exacts et les contributions aux projets comptabilisés dans le score de l'employé.</DialogDescription>
          </DialogHeader>
          {loadingBreakdown ? (
            <p className="py-8 text-center text-muted-foreground">Chargement du détail du score...</p>
          ) : !selectedScore ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/50 p-6 text-sm text-muted-foreground">
              Aucun score annuel calculé n'est encore disponible pour cet employé.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-5">
                <div className="rounded-2xl border border-border bg-muted/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Final</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{selectedScore.finalScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-border bg-muted/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projets</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{selectedScore.projectScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-border bg-muted/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Certifications</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{selectedScore.certificationScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-border bg-muted/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Formations</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{selectedScore.trainingScore.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-border bg-muted/50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Formations internes</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{selectedScore.formationScore.toFixed(1)}</p>
                </div>
              </div>

              {selectedScore.scoreDetails?.headline && (
                <Alert className="border-border bg-muted/50">
                  <Info className="h-4 w-4 text-foreground" />
                  <AlertTitle>{selectedScore.scoreDetails.headline.title}</AlertTitle>
                  <AlertDescription>{selectedScore.scoreDetails.headline.message}</AlertDescription>
                </Alert>
              )}

              <Card className="border-border">
                <CardHeader>
                  <CardTitle className="text-base">Formules appliquées</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-foreground">
                  <p>{selectedScore.scoreDetails?.formulas?.projects || 'La contribution au projet est basée sur le score du manager si disponible, sinon sur la complexité du projet uniquement.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.certifications || 'Le score de certification dépend de la progression par rapport à l\'objectif annuel.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.trainings || 'Chaque formation complétée ajoute 20 points.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.formations || 'Chaque formation dispensée ajoute 25 points.'}</p>
                  <p>{selectedScore.scoreDetails?.formulas?.final || 'Score final = moyenne des quatre piliers.'}</p>
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardHeader>
                  <CardTitle className="text-base">Détail des contributions aux projets</CardTitle>
                  <CardDescription>Chaque carte ci-dessous explique un projet actuellement comptabilisé dans le score de l'employé.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(selectedScore.scoreDetails?.pillars?.projects?.items || []).length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border bg-muted/50 p-5 text-sm text-muted-foreground">
                      Aucune contribution au projet n'est actuellement comptabilisée pour cet employé.
                    </div>
                  ) : (
                    (selectedScore.scoreDetails?.pillars?.projects?.items || []).map((project: ProjectScoreDetail) => (
                      <div key={`${project.project_name}-${project.completion_date || 'undated'}`} className="rounded-2xl border border-border bg-muted/50 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-foreground">{project.project_name}</p>
                              <Badge className={complexityColor[project.complexity]}>{project.complexity}</Badge>
                              <Badge variant="outline">{project.evaluation_status}</Badge>
                              {project.pv_verified && <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">PV vérifié</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">Date de référence : {project.completion_date || 'Année d\'affectation en cours'}</p>
                            <p className="text-sm text-foreground">{project.explanation}</p>
                          </div>
                          <div className="rounded-2xl border border-border bg-card px-4 py-3 text-right">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Contribution</p>
                            <p className="mt-1 text-2xl font-semibold text-foreground">{project.contribution_score.toFixed(1)}</p>
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
            <DialogTitle>Objectif de certification {year}</DialogTitle>
            <DialogDescription>
              Définissez un objectif annuel de certification pour un membre de votre équipe.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Employé</Label>
              <Select value={targetProfileId} onValueChange={setTargetProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionner un employé" />
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
              <Label>Nombre de certifications</Label>
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
              Annuler
            </Button>
            <Button onClick={handleSetTarget} disabled={settingTarget || !targetProfileId}>
              {settingTarget ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerScoringPage;
