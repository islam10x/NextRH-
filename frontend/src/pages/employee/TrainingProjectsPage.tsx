import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Training, Project } from '@/types';
import { trainingService } from '@/services/training.service';
import { projectService } from '@/services/project.service';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GraduationCap,
  Briefcase,
  Calendar,
  Building2,
  Code,
  ChevronRight,
  Upload,
  Check,
  X,
  Info,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { scoringService } from '@/services/scoring.service';

const TrainingProjectsPage: React.FC = () => {
  const { user } = useAuth();
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') === 'projects' ? 'projects' : 'trainings';
  const [activeTab, setActiveTab] = useState<'trainings' | 'projects'>(initialTab);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [selectedTraining, setSelectedTraining] = useState<Training | null>(null);
  const [completionComment, setCompletionComment] = useState<string>('');
  const [completionFile, setCompletionFile] = useState<File | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectRole, setProjectRole] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [formationFile, setFormationFile] = useState<File | null>(null);
  const [uploadingFormation, setUploadingFormation] = useState(false);
  const [completionProjectId, setCompletionProjectId] = useState<string>('');

  const formatDate = (dateString: string) => {
    if (!dateString) return 'n/a';
    try {
      return format(new Date(dateString), 'yyyy-MM-dd');
    } catch {
      return dateString;
    }
  };

  const openCompletionDialog = (training: Training) => {
    setSelectedTraining(training);
    setCompletionComment('');
    setCompletionFile(null);
    setCompletionProjectId('');
    setCompletionDialogOpen(true);
  };

  const handleComplete = async () => {
    if (!selectedTraining) return;
    try {
      setIsSubmitting(true);
          if (completionFile) {
            await trainingService.uploadProof(selectedTraining.id, completionFile, {
          description: completionComment || undefined,
          relatedProjectId: completionProjectId || undefined,
            });
          } else {
            await trainingService.completeWithoutProof(selectedTraining.id, {
              endDate: undefined,
          description: completionComment || undefined,
            });
          }
      toast.success('Formation marquée comme terminée — votre score a été mis à jour');
      setCompletionDialogOpen(false);
      loadTrainings();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de terminer la formation');
    } finally {
      setIsSubmitting(false);
    }
  };

  const loadTrainings = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const data = await trainingService.listMine();
      setTrainings(data);
    } catch (error: any) {
      console.error('Failed to fetch trainings', error);
      toast.error(error?.response?.data?.message || 'Échec du chargement des formations');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTrainings();
  }, [user]);

  const loadProjects = async () => {
    if (!user) return;
    setIsProjectLoading(true);
    try {
      const data = await projectService.listMine();
      setProjects(data);
    } catch (error: any) {
      console.error('Failed to fetch projects', error);
      toast.error(error?.response?.data?.message || 'Échec du chargement des projets');
    } finally {
      setIsProjectLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, [user]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'projects' || tab === 'trainings') {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const handleTabChange = (value: string) => {
    if (value !== 'trainings' && value !== 'projects') return;
    setActiveTab(value);
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'trainings') {
      next.delete('tab');
    } else {
      next.set('tab', 'projects');
    }
    setSearchParams(next, { replace: true });
  };

  const handleStart = async (trainingId: string) => {
    try {
      await trainingService.start(trainingId);
      toast.success('Formation marquée comme démarrée');
      loadTrainings();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de démarrer la formation');
    }
  };

  const handleFormationUpload = async () => {
    if (!formationFile) return;
    setUploadingFormation(true);
    try {
      const result = await scoringService.uploadTrainingSheet(formationFile);
      if (result.status === 'duplicate') {
        toast.warning(result.message || 'Document déjà importé');
      } else {
        toast.success('Feuille de formation acceptée et score recalculé');
        setFormationFile(null);
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Erreur lors de l'import");
    } finally {
      setUploadingFormation(false);
    }
  };

  const statusBadge = (status?: string) => {
    if (status === 'completed') return <Badge className="bg-success/15 text-success">Terminée</Badge>;
    if (status === 'in_progress') return <Badge className="bg-primary/15 text-primary">En cours</Badge>;
    return <Badge variant="secondary">Assignée</Badge>;
  };

  const TrainingCard: React.FC<{ training: Training }> = ({ training }) => (
    <Card className="hover:shadow-md transition-shadow animate-fade-in">
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className="p-2 rounded-lg bg-accent/10 shrink-0">
            <GraduationCap className="h-5 w-5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-foreground">{training.name}</h3>
              {statusBadge(training.status)}
            </div>
            {training.provider && (
              <p className="text-sm text-muted-foreground">{training.provider}</p>
            )}
            {training.assignedByName && (
              <p className="text-xs text-muted-foreground">Assigné par {training.assignedByName}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {training.dueDate ? formatDate(training.dueDate) : 'Pas d\'échéance'}
              </span>
              {training.trainingUrl && (
                <a
                  href={training.trainingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ChevronRight className="h-3 w-3" />
                  Lien de la formation
                </a>
              )}
            </div>
            {/* comment hidden from employee view */}
            <div className="flex items-center gap-2 mt-3">
              {training.status !== 'in_progress' && training.status !== 'completed' && (
                <Button size="sm" variant="outline" onClick={() => handleStart(training.id)}>
                  Commencer
                </Button>
              )}
              {training.status === 'in_progress' && (
                <Button size="sm" onClick={() => openCompletionDialog(training)}>
                  Marquer comme terminée
                </Button>
              )}
              {training.proofFilePath && (
                <span className="text-xs text-muted-foreground truncate">{training.proofFilePath}</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const ProjectCard: React.FC<{ project: Project }> = ({ project }) => (
    <Card className="hover:shadow-md transition-shadow animate-fade-in">
      <CardContent className="p-5">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                <Briefcase className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">{project.name}</h3>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />
                  {project.client}
                </div>
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0">
              {project.role}
            </Badge>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>
              {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'En cours'}
            </span>
          </div>
          {project.assignedByName && (
            <p className="text-xs text-muted-foreground">Assigné par {project.assignedByName}</p>
          )}

          <p className="text-sm text-muted-foreground line-clamp-2">
            {project.description || 'Ajoutez vos détails de contribution pour enrichir votre CV.'}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {project.technologies.map((tech) => (
              <Badge key={tech} variant="outline" className="text-xs">
                <Code className="h-3 w-3 mr-1" />
                {tech}
              </Badge>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSelectedProject(project);
                setProjectRole(project.role || '');
                setProjectDescription(project.description || '');
                setIsProjectDialogOpen(true);
              }}
            >
              Mettre à jour ma contribution
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Formations & Projets</h1>
        <p className="text-muted-foreground">Suivez votre développement professionnel et votre expérience projet</p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="trainings" className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            Formations ({trainings.length})
          </TabsTrigger>
          <TabsTrigger value="projects" className="flex items-center gap-2">
            <Briefcase className="h-4 w-4" />
            Projets ({projects.length})
          </TabsTrigger>
        </TabsList>

        {/* Training Tab */}
        <TabsContent value="trainings" className="space-y-4">
          {isLoading ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Chargement des formations...</CardContent></Card>
          ) : trainings.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {trainings.map((training) => (
                <TrainingCard key={training.id} training={training} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <GraduationCap className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h3 className="font-medium text-lg mb-1">Aucune formation enregistrée</h3>
                <p className="text-muted-foreground text-sm">
                  Les formations sont assignées par votre manager. Revenez bientôt.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Projects Tab */}
        <TabsContent value="projects" className="space-y-4">
          {isProjectLoading ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Chargement des projets...</CardContent></Card>
          ) : projects.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-16 text-center">
                <Briefcase className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h3 className="font-medium text-lg mb-1">Aucun projet assigné</h3>
                <p className="text-muted-foreground text-sm mb-4">
                  Votre manager assignera des projets ici. Une fois assigné, ajoutez vos détails de contribution.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Formation Upload — formateur attendance sheet */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-start gap-4">
                <div className="p-2 rounded-lg bg-accent/10 shrink-0">
                  <Upload className="h-5 w-5 text-accent" />
                </div>
                <div className="flex-1 space-y-2">
                  <h3 className="font-semibold text-foreground">Importer une feuille de formation (formateur)</h3>
                  <p className="text-sm text-muted-foreground">
                    Importez votre feuille de présence (PDF) pour les formations que vous avez dispensées aux clients. Chaque formation comptabilisée rapporte 10 points.
                  </p>
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Label>Fichier PDF</Label>
                      <Input
                        type="file"
                        accept=".pdf"
                        onChange={(e) => setFormationFile(e.target.files?.[0] || null)}
                      />
                    </div>
                    <Button onClick={handleFormationUpload} disabled={uploadingFormation || !formationFile}>
                      {uploadingFormation ? 'Import en cours...' : 'Importer'}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={completionDialogOpen} onOpenChange={setCompletionDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Terminer la formation</DialogTitle>
            <DialogDescription>
              Confirmez que vous avez terminé cette formation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Training name highlight */}
            <div className="rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 p-3 flex items-center gap-3">
              <GraduationCap className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
              <p className="font-semibold text-green-700 dark:text-green-300">{selectedTraining?.name}</p>
            </div>

            {/* Comment */}
            <div className="space-y-1.5">
              <Label htmlFor="description">
                Commentaire pour le manager{' '}
                <span className="text-muted-foreground font-normal text-xs">(optionnel)</span>
              </Label>
              <Textarea
                id="description"
                value={completionComment}
                onChange={(e) => setCompletionComment(e.target.value)}
                placeholder="Partagez vos impressions ou remarques avec votre manager..."
                rows={3}
              />
            </div>

            {/* Proof upload — improved UX */}
            <div className="space-y-2">
              <Label>
                Preuve de certification{' '}
                <span className="text-muted-foreground font-normal text-xs">(optionnel)</span>
              </Label>
              {completionFile ? (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                  <Check className="h-4 w-4 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{completionFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(completionFile.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setCompletionFile(null)}
                    aria-label="Supprimer le fichier"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <label
                    htmlFor="proof"
                    className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-dashed border-muted hover:border-primary/40 cursor-pointer transition-colors text-center"
                  >
                    <Upload className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      Cliquez pour joindre une certification
                    </span>
                    <span className="text-xs text-muted-foreground">PDF, DOCX, PNG, JPG</span>
                    <input
                      id="proof"
                      type="file"
                      accept=".pdf,.docx,.png,.jpg,.jpeg"
                      className="hidden"
                      onChange={(e) => setCompletionFile(e.target.files?.[0] || null)}
                    />
                  </label>
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-2.5 flex items-start gap-2">
                    <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Vous pouvez terminer sans preuve. Joindre une certification officielle permet de valider votre complétion et améliore votre score.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Related project */}
            {projects.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="relatedProject">
                  Projet associé{' '}
                  <span className="text-muted-foreground font-normal text-xs">(optionnel)</span>
                </Label>
                <Select value={completionProjectId} onValueChange={(v) => setCompletionProjectId(v === 'none' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sélectionner un projet..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucun</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}{p.client ? ` — ${p.client}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompletionDialogOpen(false)}>
              Annuler
            </Button>
            <Button onClick={handleComplete} disabled={!selectedTraining || isSubmitting}>
              {isSubmitting ? 'Envoi en cours...' : completionFile ? 'Confirmer avec preuve' : 'Confirmer sans preuve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>

      <Dialog open={isProjectDialogOpen} onOpenChange={setIsProjectDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mettre à jour ma contribution</DialogTitle>
            <DialogDescription>
              Décrivez votre contribution à ce projet. Cela apparaîtra dans votre CV.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Projet</Label>
              <p className="text-sm font-semibold text-foreground">{selectedProject?.name || 'Projet'}</p>
              {selectedProject?.client && (
                <p className="text-xs text-muted-foreground">{selectedProject.client}</p>
              )}
            </div>
            {selectedProject?.role && (
              <div className="space-y-1">
                <Label>Votre rôle</Label>
                <p className="text-sm text-muted-foreground">{selectedProject.role}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="projectContribution">Contribution</Label>
              <Textarea
                id="projectContribution"
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                placeholder="Décrivez vos contributions et réalisations..."
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsProjectDialogOpen(false)}>
              Annuler
            </Button>
            <Button
              onClick={async () => {
                if (!selectedProject) return;
                try {
                  await projectService.updateParticipation(selectedProject.id, {
                    description: projectDescription,
                  });
                  toast.success('Contribution au projet mise à jour');
                  setIsProjectDialogOpen(false);
                  loadProjects();
                } catch (error: any) {
                  toast.error(error?.response?.data?.message || 'Impossible de mettre à jour le projet');
                }
              }}
            >
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TrainingProjectsPage;
