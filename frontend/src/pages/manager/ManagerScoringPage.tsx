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
import api from '@/services/api';

const currentYear = new Date().getFullYear();

const complexityLabel: Record<string, string> = { low: 'Basse', medium: 'Moyenne', high: 'Haute' };
const complexityColor: Record<string, string> = {
  low: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-100 text-red-800',
};
const roleLabel: Record<string, string> = {
  contributor: 'Contributeur',
  technical_lead: 'Chef de projet technique',
  project_lead: 'Chef de projet',
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
  const [uploadProfileIds, setUploadProfileIds] = useState<string[]>([]);
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
      if (user?.role === 'bid_manager') {
        const usersResponse = await api.get<any[]>('/users');
        const employees = usersResponse.data.filter((u) => u.role === 'employee' && u.status === 'active');

        const profiles = await Promise.all(
          employees.map(async (employee) => {
            try {
              const profileResponse = await api.get(`/cv/profile/${employee.user_id}`);
              return {
                userId: employee.user_id,
                profileId: profileResponse.data?.profile_id || profileResponse.data?.profileId || null,
                name: [employee.firstName, employee.lastName].filter(Boolean).join(' ') || employee.email,
                email: employee.email,
              };
            } catch {
              return {
                userId: employee.user_id,
                profileId: null,
                name: [employee.firstName, employee.lastName].filter(Boolean).join(' ') || employee.email,
                email: employee.email,
              };
            }
          }),
        );

        setMembers(profiles);
      } else {
        const data = await teamService.listMyMembers();
        setMembers(
          data.map((m) => ({
            userId: m.userId,
            profileId: m.profileId,
            name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
            email: m.email,
          })),
        );
      }
    } catch {
      toast.error('Impossible de charger les membres');
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
      toast.success('Poids mis à jour');
      setWeightsOpen(false);
    } catch (err: any) {
      if (err?.response?.status === 403) {
        toast.error('Vous n\'êtes pas autorisé à modifier les poids');
      } else {
        toast.error(err?.response?.data?.message || 'Erreur lors de la mise à jour des poids');
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
    if (!uploadFile || uploadProfileIds.length === 0) {
      toast.error('Veuillez sélectionner un fichier et au moins un employé');
      return;
    }
    if (!uploadProjectId) {
      toast.error('Veuillez sélectionner un projet');
      return;
    }
    if (uploadProjectId === '__new__' && !uploadProjectName.trim()) {
      toast.error('Veuillez saisir le nom du projet');
      return;
    }
    setUploading(true);
    try {
      const isNew = uploadProjectId === '__new__';
      const result = await scoringService.uploadPv(
        uploadFile,
        uploadProfileIds,
        isNew ? undefined : uploadProjectId,
        isNew ? uploadProjectName : undefined,
        isNew ? uploadClientName : undefined,
        isNew ? uploadComplexity : undefined,
        isNew ? uploadRole : undefined,
      );
      if (result.status === 'duplicate') {
        toast.warning(result.message || 'Aucun nouvel enregistrement créé');
      } else {
        toast.success(result.message || 'PV importé avec succès');
        await loadLeaderboard();
      }
      setUploadOpen(false);
      setUploadFile(null);
      setUploadProjectId('');
      setUploadProfileIds([]);
      setUploadProjectName('');
      setUploadClientName('');
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Erreur lors de l'import du PV");
    } finally {
      setUploading(false);
    }
  };

  const openUploadDialog = async () => {
    setUploadOpen(true);
    setUploadProjectId('');
    setUploadProfileIds([]);
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
    setUploadProfileIds([]); // reset selected employees when project changes
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

  const toggleUploadProfile = (profileId: string) => {
    setUploadProfileIds((current) =>
      current.includes(profileId)
        ? current.filter((id) => id !== profileId)
        : [...current, profileId],
    );
  };

  const handleSetTarget = async () => {
    if (!targetProfileId) return;
    setSettingTarget(true);
    try {
      await scoringService.setTarget(targetProfileId, year, targetCertValue);
      toast.success('Objectif certification défini');
      setTargetOpen(false);
      // Reload leaderboard since target change triggers score recomputation
      await loadLeaderboard();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Erreur lors de la définition de l'objectif");
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
      toast.error(err?.response?.data?.message || 'Erreur lors du calcul');
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
      toast.error('Impossible de charger les détails');
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Scoring Employés</h1>
          <p className="text-muted-foreground">
            {user?.role === 'bid_manager'
              ? 'Évaluez et classez tous les employés.'
              : 'Évaluez et classez les membres de votre équipe'}
          </p>
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
        {user?.role === 'team_manager' && (
          <Button variant="secondary" onClick={handleComputeTeam} disabled={loading}>
            <Calculator className="mr-2 h-4 w-4" />
            {loading ? 'Calcul en cours...' : 'Calculer les scores'}
          </Button>
        )}
        {user?.role === 'bid_manager' && (
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
              <CardTitle>Classement {year}</CardTitle>
              <CardDescription>
                {user?.role === 'team_manager'
                  ? 'Classement de votre équipe.'
                  : 'Classement de tous les employés.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fullTeamScores.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  Aucun membre dans l'équipe.
                </p>
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
            <DialogTitle>Importer un PV</DialogTitle>
            <DialogDescription>
              Importez une Attestation de Bonne Exécution (PDF) pour un ou plusieurs employés de votre équipe.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Projet</Label>
              <Select value={uploadProjectId} onValueChange={handleProjectChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionner un projet" />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((p) => (
                    <SelectItem key={p.project_id} value={p.project_id}>
                      {p.projectName}{p.clientName ? ` — ${p.clientName}` : ''}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">➕ Nouveau projet (hors système)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Employés</Label>
              <div className={`rounded-md border p-3 space-y-2 ${!uploadProjectId ? 'opacity-60' : ''}`}>
                {!uploadProjectId ? (
                  <p className="text-sm text-muted-foreground">Choisir d'abord un projet</p>
                ) : projectFilteredMembers.filter((m) => m.profileId).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {uploadProjectId === '__new__'
                      ? 'Aucun employé disponible dans votre équipe.'
                      : 'Aucun employé de votre équipe n\'est assigné à ce projet.'}
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {uploadProjectId === '__new__'
                        ? 'Vous pouvez sélectionner un ou plusieurs employés de votre équipe.'
                        : 'Pour un projet assigné, vous pouvez sélectionner uniquement les employés assignés à ce projet.'}
                    </p>
                    <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                      {projectFilteredMembers
                        .filter((m) => m.profileId)
                        .map((m) => (
                          <label key={m.profileId!} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={uploadProfileIds.includes(m.profileId!)}
                              onChange={() => toggleUploadProfile(m.profileId!)}
                            />
                            <span>{m.name}</span>
                          </label>
                        ))}
                    </div>
                    {uploadProfileIds.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {uploadProfileIds.length} employé(s) sélectionné(s)
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {uploadProjectId === '__new__' && (
              <>
                <div>
                  <Label>Nom du projet</Label>
                  <Input
                    placeholder="Ex: Projet Alpha"
                    value={uploadProjectName}
                    onChange={(e) => setUploadProjectName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Client</Label>
                  <Input
                    placeholder="Nom du client (optionnel)"
                    value={uploadClientName}
                    onChange={(e) => setUploadClientName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Complexité du projet</Label>
                  <Select value={uploadComplexity} onValueChange={setUploadComplexity}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Basse</SelectItem>
                      <SelectItem value="medium">Moyenne</SelectItem>
                      <SelectItem value="high">Haute</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Rôle de l'employé</Label>
                  <Select value={uploadRole} onValueChange={setUploadRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contributor">Contributeur</SelectItem>
                      <SelectItem value="technical_lead">Lead Technique</SelectItem>
                      <SelectItem value="project_lead">Chef de Projet</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div>
              <Label>Fichier PDF</Label>
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
            <Button onClick={handleUploadPv} disabled={uploading || !uploadFile || uploadProfileIds.length === 0 || !uploadProjectId}>
              {uploading ? 'Import en cours...' : 'Importer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Target Dialog */}
      <Dialog open={targetOpen} onOpenChange={setTargetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Objectif Certification {year}</DialogTitle>
            <DialogDescription>
              Définissez le nombre de certifications attendues pour un employé cette année.
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

      {/* Project Records Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Détails projets — {detailName}</DialogTitle>
          </DialogHeader>
          {detailProjects.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">Aucun projet enregistré</p>
          ) : (
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
                        <Badge className="bg-green-100 text-green-800">✓ Vérifié</Badge>
                      ) : (
                        <Badge variant="secondary">Non</Badge>
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
            <DialogTitle>Configurer les poids de scoring</DialogTitle>
            <DialogDescription>
              Chaque poids représente le pourcentage du score final (ex : 35 pour les projets = 35%). La somme des poids doit être 100%.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Poids Projets ({wProject}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wProject} onChange={(e) => setWProject(Number(e.target.value))} />
            </div>
            <div>
              <Label>Poids Certifications ({wCert}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wCert} onChange={(e) => setWCert(Number(e.target.value))} />
            </div>
            <div>
              <Label>Poids Trainings ({wTraining}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wTraining} onChange={(e) => setWTraining(Number(e.target.value))} />
            </div>
            <div>
              <Label>Poids Formations ({wFormation}%)</Label>
              <Input type="number" min={0} max={100} step={5} value={wFormation} onChange={(e) => setWFormation(Number(e.target.value))} />
            </div>
            <p className={`text-sm ${Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1 ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
              Total : {wProject + wCert + wTraining + wFormation}%
              {Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1 && ' ⚠ La somme doit être 100%'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWeightsOpen(false)}>Annuler</Button>
            <Button onClick={handleSaveWeights} disabled={savingWeights || Math.abs(wProject + wCert + wTraining + wFormation - 100) > 1}>
              {savingWeights ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerScoringPage;
