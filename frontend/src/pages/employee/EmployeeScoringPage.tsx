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

const complexityLabel: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const roleLabel: Record<string, string> = { contributor: 'Contributor', technical_lead: 'Technical Lead', project_lead: 'Project Lead' };

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
        <h1 className="text-2xl font-bold">My Scoring</h1>
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
          <h1 className="text-2xl font-bold">My Scoring</h1>
          <p className="text-muted-foreground">View your scores, leaderboard, and history of projects/workshops</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRecompute} disabled={recomputing || loading} variant="default" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${recomputing ? 'animate-spin' : ''}`} />
            Recompute my score
          </Button>
        </div>
      </div>

      {/* Score Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="border-2 border-primary/20 flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><Trophy className="h-4 w-4" /> Final Score</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl lg:text-3xl font-bold">{score ? Number(score.finalScore).toFixed(1) : '0.0'}</div>
            {score?.rankGlobal ? (
              <p className="text-xs text-muted-foreground mt-1">
                Rank #{score.rankGlobal}
                {score.percentile != null && ` · Ahead of ${score.percentile.toFixed(0)}% of scored employees`}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Not ranked
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="flex flex-col justify-between">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-1 font-medium"><FolderKanban className="h-4 w-4" /> Projects</CardDescription>
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
            <CardDescription className="flex items-center gap-1 font-medium"><BookOpen className="h-4 w-4" /> Workshops</CardDescription>
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
              <p className="text-sm font-medium">Best score {currentYear}</p>
              <p className="text-lg font-bold">{bestScore.employeeName} — {bestScore.finalScore.toFixed(1)} pts</p>
            </div>
            {score?.rankGlobal && (
              <div className="ml-auto text-right">
                <p className="text-sm text-muted-foreground">Your position</p>
                <p className="text-lg font-bold">#{score.rankGlobal} / {leaderboard.length}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Weights, formulas and target</CardTitle>
          <CardDescription>
            Active weights and formulas used for your {currentYear} scoring. Only projects dated in the current year are counted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Project Weight</p>
              <p className="font-semibold">{toPercent(activeWeights?.projectWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Certification Weight</p>
              <p className="font-semibold">{toPercent(activeWeights?.certificationWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Training Weight</p>
              <p className="font-semibold">{toPercent(activeWeights?.trainingWeight)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Workshop Weight</p>
              <p className="font-semibold">{toPercent(activeWeights?.formationWeight)}</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Formulas used</p>
            <div className="space-y-1 text-muted-foreground">
              <p>Projects = Sum(10 × Complexity × Role × PV Bonus)</p>
              <p>Certifications = (Number of certifications / Annual Target) × 100</p>
              <p>Trainings = Number of completed trainings × 10</p>
              <p>Workshops = Number of workshops delivered × 10</p>
              <p>Final Score = Project Weight × Project Score + Certification Weight × Certification Score + Training Weight × Training Score + Workshop Weight × Workshop Score</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Certification Target</p>
            <p className="text-muted-foreground">
              {target ? `Target defined by manager for ${currentYear}: ${target.certificationTarget} certification(s).` : `No specific target defined by manager for ${currentYear}.`}
            </p>
          </div>

          <Separator />

          <div className="space-y-2 text-sm">
            <p className="font-medium">Global Percentile</p>
            <p className="text-muted-foreground">
              The global percentile indicates the percentage of scored employees this year who have a lower score than yours. Example: 80% means your score is higher than 80% of scored employees.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Tabs: Projects (read-only), Formations (with upload), Classement, History */}
      <Tabs defaultValue="projects">
        <TabsList>
          <TabsTrigger value="projects"><FolderKanban className="mr-2 h-4 w-4" /> Projects ({pmProjects.length + projectRecords.length})</TabsTrigger>
          <TabsTrigger value="formations"><BookOpen className="mr-2 h-4 w-4" /> Workshops ({trainingRecords.length})</TabsTrigger>
          <TabsTrigger value="classement"><Trophy className="mr-2 h-4 w-4" /> Leaderboard</TabsTrigger>
          {scoreHistory.length > 0 && (
            <TabsTrigger value="history"><History className="mr-2 h-4 w-4" /> History</TabsTrigger>
          )}
        </TabsList>

        {/* Projects Tab — all projects that count in scoring */}
        <TabsContent value="projects">
          <div className="space-y-6">
            {/* PM Projects — assigned by manager */}
            <Card>
              <CardHeader>
                <CardTitle>Assigned Projects</CardTitle>
                <CardDescription>Projects assigned by your manager — count towards your project score</CardDescription>
              </CardHeader>
              <CardContent>
                {pmProjects.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">No assigned projects</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Project</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Role</TableHead>
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
                  <CardTitle>Projects with PV</CardTitle>
                  <CardDescription>Handover records (PV) imported by your manager — give a verification bonus (+25%)</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Project</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Complexity</TableHead>
                        <TableHead>Role</TableHead>
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
                              ? <Badge className="bg-green-500">Verified</Badge>
                              : <Badge variant="secondary">Pending</Badge>}
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
              <CardTitle>Workshops Delivered</CardTitle>
              <CardDescription>Workshops you have delivered to clients. Import your attendance sheets from the Projects page.</CardDescription>
            </CardHeader>
            <CardContent>
              {trainingRecords.length === 0 ? (
                <p className="text-muted-foreground text-center py-6">No workshops recorded</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workshop</TableHead>
                      <TableHead>Trainer</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Location</TableHead>
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
              <CardTitle>Leaderboard {currentYear}</CardTitle>
              <CardDescription>Global leaderboard of all scored employees. The global percentile indicates the percentage of scored employees that each collaborator outperforms.</CardDescription>
            </CardHeader>
            <CardContent>
              {leaderboard.length === 0 ? (
                <p className="text-muted-foreground text-center py-6">No leaderboard available for {currentYear}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Rank</TableHead>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Projects</TableHead>
                      <TableHead className="text-right">Certif.</TableHead>
                      <TableHead className="text-right">Trainings</TableHead>
                      <TableHead className="text-right">Workshops</TableHead>
                      <TableHead className="text-right">Final Score</TableHead>
                      <TableHead className="text-right">Global Percentile</TableHead>
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
                            {entry.employeeName}{isMe ? ' (you)' : ''}
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
                <CardTitle>Score History</CardTitle>
                <CardDescription>Evolution of your scores over the years</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Projects</TableHead>
                      <TableHead className="text-right">Certif.</TableHead>
                      <TableHead className="text-right">Trainings</TableHead>
                      <TableHead className="text-right">Workshops</TableHead>
                      <TableHead className="text-right">Final Score</TableHead>
                      <TableHead className="text-right">Rank</TableHead>
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
