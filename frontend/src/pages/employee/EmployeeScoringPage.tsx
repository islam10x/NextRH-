import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trophy, FolderKanban, Award, GraduationCap, BookOpen, History, Crown, RefreshCw, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { scoringService, TrainingRecord, ProjectRecord, EmployeeScore, LeaderboardEntry, ScoringWeights, ScoringTarget } from '@/services/scoring.service';
import { projectService } from '@/services/project.service';
import { Project } from '@/types';
import api from '@/services/api';
import { Separator } from '@/components/ui/separator';

const complexityLabel: Record<string, string> = { low: 'Basse', medium: 'Moyenne', high: 'Haute' };
const roleLabel: Record<string, string> = { contributor: 'Contributeur', technical_lead: 'Lead Technique', project_lead: 'Chef de projet' };

const toPercent = (value?: number) => `${Math.round(Number(value || 0) * 100)}%`;

const EmployeeScoringPage: React.FC = () => {
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecord[]>([]);
  const [projectRecords, setProjectRecords] = useState<ProjectRecord[]>([]);
  const [pmProjects, setPmProjects] = useState<Project[]>([]);
  const [score, setScore] = useState<EmployeeScore | null>(null);
  const [scoreHistory, setScoreHistory] = useState<EmployeeScore[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [weights, setWeights] = useState<ScoringWeights | null>(null);
  const [target, setTarget] = useState<ScoringTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [profileId, setProfileId] = useState('');
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    api.get('/cv/profile/me').then((res) => {
      const pid = res.data?.profile_id || res.data?.profileId || '';
      setProfileId(pid);
    }).catch(() => {});
  }, []);

  const loadData = async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      const [tRecs, pRecs, myProjects, sc, hist, lb, tg] = await Promise.all([
        scoringService.getTrainingRecords(profileId),
        scoringService.getProjectRecords(profileId),
        projectService.listMine().catch(() => [] as Project[]),
        scoringService.getScore(profileId, currentYear),
        scoringService.getScoreHistory(profileId),
        scoringService.getLeaderboard(currentYear),
        scoringService.getTarget(profileId, currentYear),
      ]);
      setTrainingRecords(tRecs);
      setProjectRecords(pRecs);
      setPmProjects(myProjects);
      // Ensures truthy object when scores are 0, allowing proper component rendering checks
      setScore(sc);
      setScoreHistory(hist.filter((h) => h.scoreYear !== currentYear));
      setLeaderboard(lb);
      setTarget(tg);
      setWeights((sc?.scoreDetails?.weights_used as ScoringWeights | undefined) ?? await scoringService.getWeights().catch(() => null));
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
  const details = score?.scoreDetails as Record<string, any> | null;
  const activeWeights = (details?.weights_used as ScoringWeights | undefined) || weights;

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
                {score.percentile != null && ` · Devant ${score.percentile.toFixed(0)}% des employés scorés`}
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
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><Award className="h-4 w-4" /> Certifications</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.certificationScore).toFixed(1) : '0.0'}</div>
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><GraduationCap className="h-4 w-4" /> Trainings</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.trainingScore).toFixed(1) : '0.0'}</div>
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><BookOpen className="h-4 w-4" /> Formations</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-xl lg:text-2xl font-semibold">{score ? Number(score.formationScore).toFixed(1) : '0.0'}</div>
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

      <Card>
        <CardHeader>
          <CardTitle>Poids, formules et objectif</CardTitle>
          <CardDescription>
            Les poids actifs et les formules utilisées pour votre scoring {currentYear}. Les projets comptés sont uniquement ceux datés dans l'année en cours.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Poids Projets</p>
              <p className="font-semibold">{toPercent(activeWeights?.projectWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Poids Certifications</p>
              <p className="font-semibold">{toPercent(activeWeights?.certificationWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Poids Trainings</p>
              <p className="font-semibold">{toPercent(activeWeights?.trainingWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Poids Formations</p>
              <p className="font-semibold">{toPercent(activeWeights?.formationWeight)}</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Formules utilisées</p>
            <div className="space-y-1 text-muted-foreground">
              <p>Projets = Somme(10 × Complexité × Rôle × Bonus PV)</p>
              <p>Certifications = (Nombre de certifications / Objectif annuel) × 100</p>
              <p>Trainings = Nombre de trainings complétés × 10</p>
              <p>Formations = Nombre de formations dispensées × 10</p>
              <p>Score final = Poids Projets × Score Projets + Poids Certifications × Score Certifications + Poids Trainings × Score Trainings + Poids Formations × Score Formations</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Objectif certifications</p>
            <p className="text-muted-foreground">
              {target ? `Objectif défini par le manager pour ${currentYear} : ${target.certificationTarget} certification(s).` : `Aucun objectif spécifique défini par le manager pour ${currentYear}.`}
            </p>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Percentile global</p>
            <p className="text-muted-foreground">
              Le percentile global indique la part des employés scorés cette année qui ont un score inférieur au vôtre. Exemple : 80% signifie que votre score dépasse celui de 80% des employés scorés.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Tabs: Projects (read-only), Formations (with upload), Classement, History */}
      <Tabs defaultValue="projects">
        <TabsList>
          <TabsTrigger value="projects"><FolderKanban className="mr-2 h-4 w-4" /> Projets ({pmProjects.length + projectRecords.length})</TabsTrigger>
          <TabsTrigger value="formations"><BookOpen className="mr-2 h-4 w-4" /> Formations ({trainingRecords.length})</TabsTrigger>
          <TabsTrigger value="classement"><Trophy className="mr-2 h-4 w-4" /> Classement</TabsTrigger>
          {scoreHistory.length > 0 && (
            <TabsTrigger value="history"><History className="mr-2 h-4 w-4" /> Historique</TabsTrigger>
          )}
        </TabsList>

        {/* Projects Tab — all projects that count in scoring */}
        <TabsContent value="projects">
          <div className="space-y-6">
            {/* PM Projects — assigned by manager */}
            <Card>
              <CardHeader>
                <CardTitle>Projets assignés</CardTitle>
                <CardDescription>Projets assignés par votre manager — comptent dans votre score projets</CardDescription>
              </CardHeader>
              <CardContent>
                {pmProjects.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">Aucun projet assigné</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Projet</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>Dates</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pmProjects.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.name}</TableCell>
                          <TableCell>{p.client || '—'}</TableCell>
                          <TableCell>{roleLabel[p.role] || p.role || '—'}</TableCell>
                          <TableCell>
                            {p.startDate ? p.startDate.slice(0, 10) : '—'}
                            {p.endDate ? ` → ${p.endDate.slice(0, 10)}` : ''}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* PV Records — uploaded by manager */}
            {projectRecords.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Projets avec PV</CardTitle>
                  <CardDescription>Procès-verbaux importés par votre manager — donnent un bonus de vérification (+25%)</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Projet</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Complexité</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>PV</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projectRecords.map((r) => (
                        <TableRow key={r.record_id}>
                          <TableCell className="font-medium">{r.projectName}</TableCell>
                          <TableCell>{r.clientName || '—'}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{complexityLabel[r.complexity] || r.complexity}</Badge>
                          </TableCell>
                          <TableCell>{roleLabel[r.employeeRole] || r.employeeRole}</TableCell>
                          <TableCell>
                            {r.pvVerified
                              ? <Badge className="bg-green-500">Vérifié</Badge>
                              : <Badge variant="secondary">En attente</Badge>}
                          </TableCell>
                          <TableCell>{r.completionDate || r.createdAt?.slice(0, 10) || '—'}</TableCell>
                        </TableRow>
                      ))}
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
              <CardDescription>Classement global de tous les employés scorés. Le percentile global indique la part des employés scorés que chaque collaborateur dépasse.</CardDescription>
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
                      <TableHead className="text-right">Percentile global</TableHead>
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
                          <TableCell className="text-right">
                            {entry.percentile != null ? `${entry.percentile.toFixed(0)}%` : '—'}
                          </TableCell>
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
