import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Upload, Trophy, Calculator, FileCheck, TrendingUp, Settings } from 'lucide-react';
import { scoringService, LeaderboardEntry, ProjectRecord, AvailableProject } from '@/services/scoring.service';
import { teamService } from '@/services/team.service';
import { useAuth } from '@/contexts/AuthContext';

const currentYear = new Date().getFullYear();

const complexityLabel: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const complexityColor: Record<string, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-100 text-red-800',
};
const roleLabel: Record<string, string> = {
  contributor: 'Contributor',
  technical_lead: 'Technical Lead',
  project_lead: 'Project Lead',
};

const ManagerScoringPage: React.FC = () => {
  const { user } = useAuth();
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [year, setYear] = useState(currentYear);

  // Upload PV state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProfileId, setUploadProfileId] = useState('');
  const [uploadProjectId, setUploadProjectId] = useState('');        // existing project or '__new__'
  const [uploadProjectName, setUploadProjectName] = useState('');    // new project name
  const [uploadClientName, setUploadClientName] = useState('');      // new project client
  const [uploadComplexity, setUploadComplexity] = useState('medium');
  const [uploadRole, setUploadRole] = useState('contributor');
  const [uploading, setUploading] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<AvailableProject[]>([]);
  const [projectFilteredMembers, setProjectFilteredMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);

  // Target state
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetProfileId, setTargetProfileId] = useState('');
  const [targetCertValue, setTargetCertValue] = useState(2);
  const [settingTarget, setSettingTarget] = useState(false);

  // Score detail state
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailProjects, setDetailProjects] = useState<ProjectRecord[]>([]);
  const [detailName, setDetailName] = useState('');

  // Weights config state
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [wProject, setWProject] = useState(35);
  const [wCert, setWCert] = useState(25);
  const [wTraining, setWTraining] = useState(20);
  const [wFormation, setWFormation] = useState(20);
  const [savingWeights, setSavingWeights] = useState(false);

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
      toast.error('Failed to load members');
    }
  };

  const loadLeaderboard = async () => {
    setLoading(true);
    try {
      const data = await scoringService.getLeaderboard(year);
      setLeaderboard(data);
    } catch {
      // No scores yet — that's fine
      setLeaderboard([]);
    } finally {
      setLoading(false);
    }
  };

  /** Build a full team view: scored members from leaderboard + unscored members at 0 */
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

  const openWeightsDialog = async () => {
    try {
      const w = await scoringService.getWeights();
      setWProject(Math.round(Number(w.projectWeight) * 100));
      setWCert(Math.round(Number(w.certificationWeight) * 100));
      setWTraining(Math.round(Number(w.trainingWeight) * 100));
      setWFormation(Math.round(Number(w.formationWeight) * 100));
    } catch {
      // keep defaults
    }
    setWeightsOpen(true);
  };

  const handleSaveWeights = async () => {
    setSavingWeights(true);
    try {
      await scoringService.updateWeights(wProject / 100, wCert / 100, wTraining / 100, wFormation / 100);
      await loadLeaderboard();
      toast.success('Weights updated');
      setWeightsOpen(false);
    } catch (err: any) {
      if (err?.response?.status === 403) {
        toast.error('Vous n\'êtes pas autorisé à modifier les poids');
      } else {
        toast.error(err?.response?.data?.message || 'Error updating weights');
      }
    } finally {
      setSavingWeights(false);
    }
  };

  useEffect(() => {
    loadMembers();
  }, []);

  useEffect(() => {
    loadLeaderboard();
  }, [year]);

  const handleUploadPv = async () => {
    if (!uploadFile || !uploadProfileId) {
      toast.error('Please select a file and an employee');
      return;
    }
    if (!uploadProjectId) {
      toast.error('Please select a project');
      return;
    }
    if (uploadProjectId === '__new__' && !uploadProjectName.trim()) {
      toast.error('Please enter the project name');
      return;
    }
    setUploading(true);
    try {
      const isNew = uploadProjectId === '__new__';
      const result = await scoringService.uploadPv(
        uploadFile,
        uploadProfileId,
        isNew ? undefined : uploadProjectId,
        isNew ? uploadProjectName : undefined,
        isNew ? uploadClientName : undefined,
        isNew ? uploadComplexity : undefined,
        isNew ? uploadRole : undefined,
      );
      if (result.status === 'duplicate') {
        toast.warning(result.message || 'Document already imported');
      } else {
        toast.success('PV imported successfully — recalculating score...');
        // Auto-recompute score for this employee
        try {
          await scoringService.computeScore(uploadProfileId, year);
          await loadLeaderboard();
        } catch { /* score will update on next manual compute */ }
      }
      setUploadOpen(false);
      setUploadFile(null);
      setUploadProjectId('');
      setUploadProjectName('');
      setUploadClientName('');
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Error importing PV");
    } finally {
      setUploading(false);
    }
  };

  const openUploadDialog = async () => {
    setUploadOpen(true);
    setUploadProjectId('');
    setUploadProfileId('');
    setProjectFilteredMembers([]);
    try {
      const projects = await scoringService.listProjects();
      setAvailableProjects(projects);
    } catch {
      setAvailableProjects([]);
    }
  };

  const handleProjectChange = (projectId: string) => {
    setUploadProjectId(projectId);
    setUploadProfileId(''); // reset employee when project changes
    if (projectId === '__new__') {
      setProjectFilteredMembers(members);
    } else {
      const project = availableProjects.find((p) => p.project_id === projectId);
      if (project) {
        const participantIds = new Set(project.participants.map((p) => p.profileId));
        setProjectFilteredMembers(members.filter((m) => m.profileId && participantIds.has(m.profileId)));
      } else {
        setProjectFilteredMembers([]);
      }
    }
  };

  const handleSetTarget = async () => {
    if (!targetProfileId) return;
    setSettingTarget(true);
    try {
      await scoringService.setTarget(targetProfileId, year, targetCertValue);
      toast.success('Certification target set');
      setTargetOpen(false);
      // Reload leaderboard since target change triggers score recomputation
      await loadLeaderboard();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Error setting target");
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
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Error calculating scores');
    } finally {
      setLoading(false);
    }
  };

  const showDetail = async (profileId: string, name: string) => {
    try {
      const projects = await scoringService.getProjectRecords(profileId);
      setDetailProjects(projects);
      setDetailName(name);
      setDetailOpen(true);
    } catch {
      toast.error('Failed to load details');
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Employee Scoring</h1>
          <p className="text-muted-foreground">Evaluate and rank your team members</p>
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

      {/* Actions */}
      <div className="flex gap-3 flex-wrap">
        <Button onClick={openUploadDialog}>
          <Upload className="mr-2 h-4 w-4" /> Importer un PV
        </Button>
        <Button variant="outline" onClick={() => setTargetOpen(true)}>
          <FileCheck className="mr-2 h-4 w-4" /> Définir objectif certification
        </Button>
        <Button variant="secondary" onClick={handleComputeTeam} disabled={loading}>
          <Calculator className="mr-2 h-4 w-4" />
          {loading ? 'Calculating...' : 'Calculer les scores'}
        </Button>
        {(user?.role === 'bid_manager' || user?.role === 'team_manager') && (
          <Button variant="ghost" onClick={openWeightsDialog}>
            <Settings className="mr-2 h-4 w-4" /> Configurer les poids
          </Button>
        )}
      </div>

      {/* Leaderboard */}
      <Tabs defaultValue="leaderboard">
        <TabsList>
          <TabsTrigger value="leaderboard">
            <Trophy className="mr-2 h-4 w-4" /> Classement
          </TabsTrigger>
        </TabsList>

        <TabsContent value="leaderboard">
          <Card>
            <CardHeader>
              <CardTitle>Leaderboard {year}</CardTitle>
              <CardDescription>
                {user?.role === 'team_manager'
                  ? 'Team leaderboard. The global percentile indicates the percentage of scored employees that each collaborator outperforms.'
                  : 'Displayed leaderboard. The global percentile indicates the percentage of scored employees that each collaborator outperforms.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fullTeamScores.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No members in the team.
                </p>
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
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fullTeamScores.map((entry) => (
                      <TableRow key={entry.profileId}>
                        <TableCell>
                          {entry.rank > 0 ? (
                            <Badge
                              variant={entry.rank <= 3 ? 'default' : 'secondary'}
                              className={entry.rank === 1 ? 'bg-yellow-500' : entry.rank === 2 ? 'bg-gray-400' : entry.rank === 3 ? 'bg-amber-600' : ''}
                            >
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
                          {entry.percentile != null ? `${entry.percentile.toFixed(0)}%` : '—'}
                        </TableCell>
                        <TableCell>
                          {entry.rank > 0 && (
                            <Button size="sm" variant="ghost" onClick={() => showDetail(entry.profileId, entry.employeeName)}>
                              <TrendingUp className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Upload PV Dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import PV</DialogTitle>
            <DialogDescription>
              Import a handover record (PV) in PDF for a team member.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Project</Label>
              <Select value={uploadProjectId} onValueChange={handleProjectChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((p) => (
                    <SelectItem key={p.project_id} value={p.project_id}>
                      {p.projectName}{p.clientName ? ` — ${p.clientName}` : ''}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">➕ New project (outside system)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Employee</Label>
              <Select
                value={uploadProfileId}
                onValueChange={setUploadProfileId}
                disabled={!uploadProjectId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={uploadProjectId ? 'Select an employee' : 'Choisir d\'abord un projet'} />
                </SelectTrigger>
                <SelectContent>
                  {projectFilteredMembers
                    .filter((m) => m.profileId)
                    .map((m) => (
                      <SelectItem key={m.profileId!} value={m.profileId!}>
                        {m.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {uploadProjectId === '__new__' && (
              <>
                <div>
                  <Label>Project name</Label>
                  <Input
                    placeholder="Ex: Project Alpha"
                    value={uploadProjectName}
                    onChange={(e) => setUploadProjectName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Client</Label>
                  <Input
                    placeholder="Client name (optional)"
                    value={uploadClientName}
                    onChange={(e) => setUploadClientName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Project complexity</Label>
                  <Select value={uploadComplexity} onValueChange={setUploadComplexity}>
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
                <div>
                  <Label>Employee role</Label>
                  <Select value={uploadRole} onValueChange={setUploadRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contributor">Contributor</SelectItem>
                      <SelectItem value="technical_lead">Technical Lead</SelectItem>
                      <SelectItem value="project_lead">Project Lead</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div>
              <Label>PDF File</Label>
              <Input
                type="file"
                accept=".pdf"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              Annuler
            </Button>
            <Button onClick={handleUploadPv} disabled={uploading || !uploadFile || !uploadProfileId || !uploadProjectId}>
              {uploading ? 'Importing...' : 'Importer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Target Dialog */}
      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Certification Target {year}</DialogTitle>
            <DialogDescription>
              Set the expected number of certifications for an employee this year.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Employee</Label>
              <Select value={targetProfileId} onValueChange={setTargetProfileId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an employee" />
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
              <Label>Number of certifications</Label>
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
              {settingTarget ? 'Saving...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project Records Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Project details — {detailName}</DialogTitle>
          </DialogHeader>
          {detailProjects.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">No projects recorded</p>
          ) : (
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
                {detailProjects.map((p) => (
                  <TableRow key={p.record_id}>
                    <TableCell className="font-medium">{p.projectName}</TableCell>
                    <TableCell>{p.clientName || '—'}</TableCell>
                    <TableCell>
                      <Badge className={complexityColor[p.complexity]}>
                        {complexityLabel[p.complexity]}
                      </Badge>
                    </TableCell>
                    <TableCell>{roleLabel[p.employeeRole]}</TableCell>
                    <TableCell>
                      {p.pvVerified ? (
                        <Badge className="bg-green-100 text-green-800">✓ Verified</Badge>
                      ) : (
                        <Badge variant="secondary">No</Badge>
                      )}
                    </TableCell>
                    <TableCell>{p.completionDate || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Weights Config Dialog */}
      <Dialog open={weightsOpen} onOpenChange={setWeightsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Configure scoring weights</DialogTitle>
            <DialogDescription>
              Each weight represents the percentage of the final score (e.g. 35 for projects = 35%). The sum of weights must be 100%.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Project Weight ({wProject}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wProject} onChange={(e) => setWProject(Number(e.target.value))} />
            </div>
            <div>
              <Label>Certification Weight ({wCert}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wCert} onChange={(e) => setWCert(Number(e.target.value))} />
            </div>
            <div>
              <Label>Training Weight ({wTraining}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wTraining} onChange={(e) => setWTraining(Number(e.target.value))} />
            </div>
            <div>
              <Label>Workshop Weight ({wFormation}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wFormation} onChange={(e) => setWFormation(Number(e.target.value))} />
            </div>
            <p className={`text-sm ${Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1 ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
              Total: {wProject + wCert + wTraining + wFormation}%
              {Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1 && ' ⚠ The sum must be 100%'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWeightsOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveWeights} disabled={savingWeights || Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1}>
              {savingWeights ? 'Saving...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerScoringPage;
