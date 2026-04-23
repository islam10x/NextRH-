import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trophy, FolderKanban, Award, GraduationCap, BookOpen, History, Crown, RefreshCw, AlertCircle, Target, CheckCircle2, Clock3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { scoringService, TrainingRecord, ProjectRecord, EmployeeScore, LeaderboardEntry, ScoringTarget, ProjectScoreDetail } from '@/services/scoring.service';
import { projectService } from '@/services/project.service';
import { CvProfile, Project, Training } from '@/types';
import api from '@/services/api';
import { Separator } from '@/components/ui/separator';
import { trainingService } from '@/services/training.service';

const complexityLabel: Record<string, string> = { low: 'Basse', medium: 'Moyenne', high: 'Haute' };

const getYearFromDate = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
};

const matchesYear = (year: number, ...values: Array<string | null | undefined>) =>
  values.some((value) => getYearFromDate(value) === year);

const buildProjectKey = (projectName?: string | null, clientName?: string | null) =>
  `${String(projectName || '').trim().toLowerCase()}::${String(clientName || '').trim().toLowerCase()}`;

const formatScore = (value?: number | null) => Number(value ?? 0).toFixed(1);

const getEvaluationStatusBadge = (status?: ProjectScoreDetail['evaluation_status']) => {
  switch (status) {
    case 'pending_external_manager':
      return { label: 'Awaiting home manager review', className: 'bg-amber-100 text-amber-900 hover:bg-amber-100' };
    case 'scored_by_home_manager':
      return { label: 'Reviewed by home manager', className: 'bg-emerald-100 text-emerald-900 hover:bg-emerald-100' };
    default:
      return { label: 'Reviewed by project manager', className: 'bg-sky-100 text-sky-900 hover:bg-sky-100' };
  }
};

const EmployeeScoringPage: React.FC = () => {
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecord[]>([]);
  const [projectRecords, setProjectRecords] = useState<ProjectRecord[]>([]);
  const [pmProjects, setPmProjects] = useState<Project[]>([]);
  const [assignedTrainings, setAssignedTrainings] = useState<Training[]>([]);
  const [profileData, setProfileData] = useState<CvProfile | null>(null);
  const [score, setScore] = useState<EmployeeScore | null>(null);
  const [scoreHistory, setScoreHistory] = useState<EmployeeScore[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [target, setTarget] = useState<ScoringTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [profileId, setProfileId] = useState('');
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    api.get('/cv/profile/me').then((res) => {
      const pid = res.data?.profile_id || res.data?.profileId || '';
      setProfileId(pid);
      setProfileData(res.data || null);
    }).catch(() => {});
  }, []);

  const loadData = async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      const [tRecs, pRecs, myProjects, myTrainings, profile, sc, hist, lb, tg] = await Promise.all([
        scoringService.getTrainingRecords(profileId),
        scoringService.getProjectRecords(profileId),
        projectService.listMine().catch(() => [] as Project[]),
        trainingService.listMine().catch(() => [] as Training[]),
        api.get<CvProfile>('/cv/profile/me').then((res) => res.data).catch(() => null),
        scoringService.getScore(profileId, currentYear),
        scoringService.getScoreHistory(profileId),
        scoringService.getLeaderboard(currentYear),
        scoringService.getTarget(profileId, currentYear),
      ]);
      setTrainingRecords(tRecs);
      setProjectRecords(pRecs);
      setPmProjects(myProjects);
      setAssignedTrainings(myTrainings);
      setProfileData(profile);
      // Ensures truthy object when scores are 0, allowing proper component rendering checks
      setScore(sc);
      setScoreHistory(hist.filter((h) => h.scoreYear !== currentYear));
      setLeaderboard(lb);
      setTarget(tg);
    } catch {
      // Handled silently for now
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [profileId]);

  const handleRecompute = async () => {
    if (!profileId) return;
    setRecomputing(true);
    try {
      await api.post('/scoring/compute', { profileId, year: currentYear });
      await loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setRecomputing(false);
    }
  };

  const bestScore = leaderboard.length > 0 ? leaderboard[0] : null;
  const certificationsThisYear = (profileData?.certifications || []).filter(
    (cert) => cert.status === 'active' && matchesYear(currentYear, cert.issueDate),
  ).length;
  const completedAssignedTrainingsThisYear = assignedTrainings.filter(
    (training) => training.status === 'completed' && matchesYear(currentYear, training.completionDate, training.startDate, training.dueDate),
  ).length;
  const formationsThisYear = trainingRecords.filter(
    (record) => matchesYear(currentYear, record.endDate, record.startDate),
  ).length;
  const projectOverviewMap = new Map<
    string,
    {
      key: string;
      projectName: string;
      clientName: string | null;
      role: string | null;
      startDate: string | null;
      endDate: string | null;
      hasPv: boolean;
      pvDate: string | null;
    }
  >();

  pmProjects.forEach((project) => {
    const key = buildProjectKey(project.name, project.client);
    projectOverviewMap.set(key, {
      key,
      projectName: project.name,
      clientName: project.client || null,
      role: project.role || null,
      startDate: project.startDate || null,
      endDate: project.endDate || null,
      hasPv: false,
      pvDate: null,
    });
  });

  projectRecords.forEach((record) => {
    const key = buildProjectKey(record.projectName, record.clientName);
    const existing = projectOverviewMap.get(key);
    projectOverviewMap.set(key, {
      key,
      projectName: existing?.projectName || record.projectName,
      clientName: existing?.clientName || record.clientName,
      role: existing?.role || null,
      startDate: existing?.startDate || null,
      endDate: existing?.endDate || record.completionDate || null,
      hasPv: existing?.hasPv || record.pvVerified,
      pvDate: record.completionDate || existing?.pvDate || null,
    });
  });

  const projectOverview = Array.from(projectOverviewMap.values());
  const verifiedProjectCount = projectOverview.filter((project) => project.hasPv).length;
  const scoreDetails = score?.scoreDetails;
  const scoreHeadline = scoreDetails?.headline;
  const projectDetails = scoreDetails?.pillars?.projects?.items || [];
  const certificationDetails = scoreDetails?.pillars?.certifications;
  const trainingDetails = scoreDetails?.pillars?.trainings;
  const formationDetails = scoreDetails?.pillars?.formations;
  const pillarCards = [
    {
      key: 'projects',
      label: 'Projects',
      score: score?.projectScore ?? 0,
      description: scoreDetails?.formulas?.projects || 'Each validated project adds its own contribution to the project pillar.',
      progress: Math.max(0, Math.min(100, score?.projectScore ?? 0)),
      meta: `${projectDetails.length} project(s) counted`,
    },
    {
      key: 'certifications',
      label: 'Certifications',
      score: score?.certificationScore ?? 0,
      description: certificationDetails?.explanation || scoreDetails?.formulas?.certifications || 'Your certification score depends on progress against your annual target.',
      progress: Math.max(0, Math.min(100, certificationDetails?.progress_percent ?? score?.certificationScore ?? 0)),
      meta: certificationDetails
        ? `${certificationDetails.count}/${certificationDetails.effective_target} target reached`
        : `${certificationsThisYear} certification(s) counted`,
    },
    {
      key: 'trainings',
      label: 'Trainings',
      score: score?.trainingScore ?? 0,
      description: trainingDetails?.explanation || scoreDetails?.formulas?.trainings || 'Each completed training adds 20 points.',
      progress: Math.max(0, Math.min(100, score?.trainingScore ?? 0)),
      meta: `${trainingDetails?.count ?? completedAssignedTrainingsThisYear} completed training(s)`,
    },
    {
      key: 'formations',
      label: 'Formations',
      score: score?.formationScore ?? 0,
      description: formationDetails?.explanation || scoreDetails?.formulas?.formations || 'Each delivered formation adds 25 points.',
      progress: Math.max(0, Math.min(100, score?.formationScore ?? 0)),
      meta: `${formationDetails?.count ?? formationsThisYear} delivered formation(s)`,
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">Mon Scoring</h1>
        <div className="flex items-center justify-center p-12">
          <RefreshCw className="h-8 w-8 text-primary animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Mon Scoring</h1>
          <p className="text-muted-foreground">Consultez vos scores, classement et historique de projets/formations</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRecompute} disabled={recomputing || loading} variant="default" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${recomputing ? 'animate-spin' : ''}`} />
            Recalculer mon score
          </Button>
        </div>
      </div>

      {/* Score Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="border-2 border-primary/20 flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><Trophy className="h-4 w-4" /> Score Final</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl lg:text-3xl font-bold">{score ? Number(score.finalScore).toFixed(1) : '0.0'}</div>
            {score?.rankGlobal ? (
              <p className="text-xs text-muted-foreground mt-1">
                Rang #{score.rankGlobal}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Pas classé
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><FolderKanban className="h-4 w-4" /> Projets</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.projectScore).toFixed(1) : '0.0'}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {projectOverview.length} projet(s), {verifiedProjectCount} avec PV
            </p>
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><Award className="h-4 w-4" /> Certifications</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.certificationScore).toFixed(1) : '0.0'}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {certificationsThisYear} certification(s) obtenue(s)
              {target ? ` / objectif ${target.certificationTarget}` : ' / objectif non défini'}
            </p>
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><GraduationCap className="h-4 w-4" /> Trainings</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.trainingScore).toFixed(1) : '0.0'}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {completedAssignedTrainingsThisYear} training(s) assigné(s) terminé(s)
            </p>
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><BookOpen className="h-4 w-4" /> Formations</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.formationScore).toFixed(1) : '0.0'}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {formationsThisYear} formation(s) dispensée(s)
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Best score highlight */}

      {bestScore && (
        <Card className="bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-950/20 dark:to-amber-950/20 border-yellow-200 dark:border-yellow-800">
          <CardContent className="flex items-center gap-4 py-4">
            <Crown className="h-6 w-6 text-yellow-500" />
            <div>
              <p className="text-sm font-medium">Meilleur score {currentYear}</p>
              <p className="text-lg font-bold">{bestScore.employeeName} — {bestScore.finalScore.toFixed(1)} pts</p>
            </div>
            {score?.rankGlobal && (
              <div className="ml-auto text-right">
                <p className="text-sm text-muted-foreground">Votre position</p>
                <p className="text-lg font-bold">#{score.rankGlobal} / {leaderboard.length}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {scoreHeadline && (
        <Alert className="border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-cyan-50">
          <Target className="h-4 w-4 text-emerald-700" />
          <AlertTitle>{scoreHeadline.title}</AlertTitle>
          <AlertDescription>
            <p>{scoreHeadline.message}</p>
            {score?.percentile != null && (
              <p className="mt-2 text-xs text-muted-foreground">
                You are ahead of {Number(score.percentile).toFixed(1)}% of scored employees this year.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>How Your Score Is Calculated</CardTitle>
          <CardDescription>The score is built from four pillars, then averaged for {currentYear}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {pillarCards.map((pillar) => (
              <div key={pillar.key} className="rounded-2xl border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{pillar.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{pillar.meta}</p>
                  </div>
                  <Badge variant="secondary">
                    {pillar.key === 'certifications' ? `${formatScore(pillar.score)}/100` : `${formatScore(pillar.score)} pts`}
                  </Badge>
                </div>
                <div className="mt-4 h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, pillar.progress))}%` }}
                  />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{pillar.description}</p>
              </div>
            ))}
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Applied formulas</p>
            <div className="space-y-1 text-muted-foreground">
              <p>{scoreDetails?.formulas?.projects || 'Each project adds a contribution based on manager score or, if still pending, complexity and PV verification.'}</p>
              <p>{scoreDetails?.formulas?.certifications || 'Certifications are compared with the annual target.'}</p>
              <p>{scoreDetails?.formulas?.trainings || 'Each completed training adds 20 points.'}</p>
              <p>{scoreDetails?.formulas?.formations || 'Each delivered formation adds 25 points.'}</p>
              <p>{scoreDetails?.formulas?.final || 'Final score = average of the four pillars.'}</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Certification target</p>
            <p className="text-muted-foreground">
              {target
                ? `Your manager set a target of ${target.certificationTarget} certification(s) for ${currentYear}. ${certificationsThisYear} certification(s) are currently counted.`
                : `No custom certification target is set for ${currentYear}. ${certificationsThisYear} certification(s) are currently counted.`}
            </p>
          </div>

          <Separator />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Completed trainings</p>
              <p className="font-semibold">{completedAssignedTrainingsThisYear}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Delivered formations</p>
              <p className="font-semibold">{formationsThisYear}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Projects with verified PV</p>
              <p className="font-semibold">{verifiedProjectCount} / {projectOverview.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Why You Got This Score</CardTitle>
          <CardDescription>
            Every in-year project counted by the scoring engine and the exact rule used for its contribution.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {projectDetails.length === 0 ? (
            <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">
              No project contribution is currently counted for {currentYear}. Once a project falls inside the scoring year, it will appear here with its exact score explanation.
            </div>
          ) : (
            <div className="space-y-3">
              {projectDetails.map((project) => {
                const statusBadge = getEvaluationStatusBadge(project.evaluation_status);
                return (
                  <div key={`${project.project_name}-${project.completion_date || 'undated'}`} className="rounded-2xl border p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{project.project_name}</p>
                          <Badge variant="outline">{complexityLabel[project.complexity] || project.complexity}</Badge>
                          <Badge className={statusBadge.className}>{statusBadge.label}</Badge>
                          {project.pv_verified && <Badge className="bg-emerald-500 hover:bg-emerald-500">Verified PV</Badge>}
                        </div>
                        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="h-3.5 w-3.5" />
                            {project.completion_date || 'No completion date'}
                          </span>
                          {project.manager_score_raw != null && (
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              Manager input: {formatScore(project.manager_score_raw)}/{project.manager_score_scale_max}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{project.explanation}</p>
                      </div>
                      <div className="min-w-[150px] rounded-2xl bg-muted/30 p-4 text-right">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Contribution</p>
                        <p className="mt-1 text-2xl font-bold">{formatScore(project.contribution_score)}</p>
                        <p className="text-xs text-muted-foreground">out of 100 in the project pillar</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs: Projects (read-only), Formations (with upload), Classement, History */}
      <Tabs defaultValue="projects">
        <TabsList>
          <TabsTrigger value="projects"><FolderKanban className="mr-2 h-4 w-4" /> Projets ({projectOverview.length})</TabsTrigger>
          <TabsTrigger value="formations"><BookOpen className="mr-2 h-4 w-4" /> Formations ({trainingRecords.length})</TabsTrigger>
          <TabsTrigger value="classement"><Trophy className="mr-2 h-4 w-4" /> Classement</TabsTrigger>
          {scoreHistory.length > 0 && (
            <TabsTrigger value="history"><History className="mr-2 h-4 w-4" /> Historique</TabsTrigger>
          )}
        </TabsList>

        {/* Projects Tab — all projects that count in scoring */}
        <TabsContent value="projects">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Mes projets et statut PV</CardTitle>
                <CardDescription>Vos projets assignés et l'état du PV associé pour le scoring.</CardDescription>
              </CardHeader>
              <CardContent>
                {projectOverview.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">Aucun projet enregistré</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Projet</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Dates</TableHead>
                        <TableHead>PV</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projectOverview.map((project) => (
                        <TableRow key={project.key}>
                          <TableCell className="font-medium">{project.projectName}</TableCell>
                          <TableCell>{project.clientName || '—'}</TableCell>
                          <TableCell>
                            {project.startDate ? project.startDate.slice(0, 10) : '—'}
                            {project.endDate ? ` → ${project.endDate.slice(0, 10)}` : ''}
                          </TableCell>
                          <TableCell>
                            {project.hasPv ? <Badge className="bg-green-500">Oui</Badge> : <Badge variant="secondary">Non</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {projectRecords.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Détail des PV importés</CardTitle>
                  <CardDescription>Imported PVs from your manager. When a manager score is not entered yet, a verified PV can still support a provisional project score.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Projet</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Complexité</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Contribution</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projectRecords.map((r) => {
                        const matchingBreakdown = projectDetails.find(
                          (project) =>
                            project.project_name.trim().toLowerCase() === r.projectName.trim().toLowerCase() &&
                            (project.completion_date || '') === (r.completionDate || ''),
                        );
                        const statusBadge = getEvaluationStatusBadge(r.evaluationStatus);
                        return (
                          <TableRow key={r.record_id}>
                            <TableCell className="font-medium">{r.projectName}</TableCell>
                            <TableCell>{r.clientName || '—'}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{complexityLabel[r.complexity] || r.complexity}</Badge>
                            </TableCell>
                            <TableCell>
                              <div className="space-y-1">
                                <Badge className={statusBadge.className}>{statusBadge.label}</Badge>
                                {r.pvVerified && <p className="text-xs text-muted-foreground">Verified PV on file</p>}
                              </div>
                            </TableCell>
                            <TableCell>
                              {matchingBreakdown ? (
                                <div>
                                  <p className="font-medium">{formatScore(matchingBreakdown.contribution_score)}/100</p>
                                  <p className="text-xs text-muted-foreground">{matchingBreakdown.explanation}</p>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">Available after the next recompute</span>
                              )}
                            </TableCell>
                            <TableCell>{r.completionDate || r.createdAt?.slice(0, 10) || '—'}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Formations Tab — read-only view */}
        <TabsContent value="formations">
          <Card>
            <CardHeader>
              <CardTitle>Mes Formations dispensées</CardTitle>
              <CardDescription>Formations que vous avez données aux clients. Importez vos feuilles de présence depuis la page Projets.</CardDescription>
            </CardHeader>
            <CardContent>
              {trainingRecords.length === 0 ? (
                <p className="text-muted-foreground text-center py-6">Aucune formation enregistrée</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Formation</TableHead>
                      <TableHead>Formateur</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Lieu</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Participants</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trainingRecords.map((r) => (
                      <TableRow key={r.record_id}>
                        <TableCell className="font-medium">{r.trainingName}</TableCell>
                        <TableCell>{r.trainerName || '—'}</TableCell>
                        <TableCell>{r.clientName || '—'}</TableCell>
                        <TableCell>{r.location || '—'}</TableCell>
                        <TableCell>
                          {r.startDate ? r.startDate : '—'}
                          {r.endDate ? ` → ${r.endDate}` : ''}
                        </TableCell>
                        <TableCell>{r.participantCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Classement Tab */}
        <TabsContent value="classement">
          <Card>
            <CardHeader>
              <CardTitle>Classement {currentYear}</CardTitle>
              <CardDescription>Classement global de tous les employés scorés.</CardDescription>
            </CardHeader>
            <CardContent>
              {leaderboard.length === 0 ? (
                <p className="text-muted-foreground text-center py-6">Aucun classement disponible pour {currentYear}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Rang</TableHead>
                      <TableHead>Employé</TableHead>
                      <TableHead className="text-right">Projets</TableHead>
                      <TableHead className="text-right">Certif.</TableHead>
                      <TableHead className="text-right">Trainings</TableHead>
                      <TableHead className="text-right">Format.</TableHead>
                      <TableHead className="text-right">Score Final</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leaderboard.map((entry) => {
                      const isMe = entry.profileId === profileId;
                      return (
                        <TableRow key={entry.profileId} className={isMe ? 'bg-primary/5 font-medium' : ''}>
                          <TableCell>
                            <Badge
                              variant={entry.rank <= 3 ? 'default' : 'secondary'}
                              className={entry.rank === 1 ? 'bg-yellow-500' : entry.rank === 2 ? 'bg-gray-400' : entry.rank === 3 ? 'bg-amber-600' : ''}
                            >
                              #{entry.rank}
                            </Badge>
                          </TableCell>
                          <TableCell className={isMe ? 'font-bold' : 'font-medium'}>
                            {entry.employeeName}{isMe ? ' (vous)' : ''}
                          </TableCell>
                          <TableCell className="text-right">{entry.projectScore.toFixed(1)}</TableCell>
                          <TableCell className="text-right">{entry.certificationScore.toFixed(1)}</TableCell>
                          <TableCell className="text-right">{entry.trainingScore.toFixed(1)}</TableCell>
                          <TableCell className="text-right">{(entry.formationScore ?? 0).toFixed(1)}</TableCell>
                          <TableCell className="text-right font-bold">{entry.finalScore.toFixed(1)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        {scoreHistory.length > 0 && (
          <TabsContent value="history">
            <Card>
              <CardHeader>
                <CardTitle>Historique des scores</CardTitle>
                <CardDescription>Évolution de vos scores au fil des années</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Année</TableHead>
                      <TableHead className="text-right">Projets</TableHead>
                      <TableHead className="text-right">Certif.</TableHead>
                      <TableHead className="text-right">Trainings</TableHead>
                      <TableHead className="text-right">Formations</TableHead>
                      <TableHead className="text-right">Score Final</TableHead>
                      <TableHead className="text-right">Rang</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scoreHistory.map((h) => (
                      <TableRow key={h.score_id}>
                        <TableCell className="font-medium">{h.scoreYear}</TableCell>
                        <TableCell className="text-right">{Number(h.projectScore).toFixed(1)}</TableCell>
                        <TableCell className="text-right">{Number(h.certificationScore).toFixed(1)}</TableCell>
                        <TableCell className="text-right">{Number(h.trainingScore).toFixed(1)}</TableCell>
                        <TableCell className="text-right">{Number(h.formationScore).toFixed(1)}</TableCell>
                        <TableCell className="text-right font-bold">{Number(h.finalScore).toFixed(1)}</TableCell>
                        <TableCell className="text-right">
                          {h.rankGlobal ? `#${h.rankGlobal}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};

export default EmployeeScoringPage;
