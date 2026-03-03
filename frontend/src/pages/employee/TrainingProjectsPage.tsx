import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Training, Project } from '@/types';
import { trainingService } from '@/services/training.service';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  GraduationCap,
  Briefcase,
  Plus,
  Calendar,
  Clock,
  Building2,
  Code,
  ChevronRight,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

const TrainingProjectsPage: React.FC = () => {
  const { user } = useAuth();
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [selectedTraining, setSelectedTraining] = useState<Training | null>(null);
  const [completionComment, setCompletionComment] = useState<string>('');
  const [completionFile, setCompletionFile] = useState<File | null>(null);
  const projects: Project[] = [];

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
    setCompletionDialogOpen(true);
  };

  const handleComplete = async () => {
    if (!selectedTraining) return;
    try {
      setIsSubmitting(true);
          if (completionFile) {
            await trainingService.uploadProof(selectedTraining.id, completionFile, {
          description: completionComment || undefined,
            });
          } else {
            await trainingService.completeWithoutProof(selectedTraining.id, {
              endDate: undefined,
          description: completionComment || undefined,
            });
          }
      toast.success('Training marked as completed');
      setCompletionDialogOpen(false);
      loadTrainings();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Unable to complete training');
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
      toast.error(error?.response?.data?.message || 'Failed to load trainings');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTrainings();
  }, [user]);

  const handleStart = async (trainingId: string) => {
    try {
      await trainingService.start(trainingId);
      toast.success('Training marked as started');
      loadTrainings();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Unable to start training');
    }
  };

  const handleUploadProof = async (trainingId: string, file?: File | null) => {
    if (!file) {
      toast.error('Please select a file');
      return;
    }
    try {
      await trainingService.uploadProof(trainingId, file);
      toast.success('Proof uploaded, training completed');
      loadTrainings();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Upload failed');
    }
  };

  const statusBadge = (status?: string) => {
    if (status === 'completed') return <Badge className="bg-success/15 text-success">Completed</Badge>;
    if (status === 'in_progress') return <Badge className="bg-primary/15 text-primary">In progress</Badge>;
    return <Badge variant="secondary">Assigned</Badge>;
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
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {training.dueDate ? formatDate(training.dueDate) : 'No due date'}
              </span>
              {training.trainingUrl && (
                <a
                  href={training.trainingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ChevronRight className="h-3 w-3" />
                  Training link
                </a>
              )}
            </div>
            {/* comment hidden from employee view */}
            <div className="flex items-center gap-2 mt-3">
              {training.status !== 'in_progress' && training.status !== 'completed' && (
                <Button size="sm" variant="outline" onClick={() => handleStart(training.id)}>
                  Start
                </Button>
              )}
              {training.status === 'in_progress' && (
                <Button size="sm" onClick={() => openCompletionDialog(training)}>
                  Mark as completed
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
              {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'Present'}
            </span>
          </div>

          <p className="text-sm text-muted-foreground line-clamp-2">{project.description}</p>

          <div className="flex flex-wrap gap-1.5">
            {project.technologies.map((tech) => (
              <Badge key={tech} variant="outline" className="text-xs">
                <Code className="h-3 w-3 mr-1" />
                {tech}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Training & Projects</h1>
        <p className="text-muted-foreground">Track your professional development and project experience</p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="trainings" className="space-y-6">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="trainings" className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            Training ({trainings.length})
          </TabsTrigger>
          <TabsTrigger value="projects" className="flex items-center gap-2">
            <Briefcase className="h-4 w-4" />
            Projects ({projects.length})
          </TabsTrigger>
        </TabsList>

        {/* Training Tab */}
        <TabsContent value="trainings" className="space-y-4">
          {isLoading ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Loading trainings...</CardContent></Card>
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
                <h3 className="font-medium text-lg mb-1">No training records</h3>
                <p className="text-muted-foreground text-sm">
                  Trainings are assigned by your manager. Check back soon.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Projects Tab */}
        <TabsContent value="projects" className="space-y-4">
          <div className="flex justify-end">
            <Dialog open={isProjectDialogOpen} onOpenChange={setIsProjectDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Project
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add Project</DialogTitle>
                  <DialogDescription>
                    Add a project you've worked on.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="projectName">Project Name</Label>
                    <Input id="projectName" placeholder="e.g., Cloud Migration Initiative" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="client">Client</Label>
                    <Input id="client" placeholder="e.g., Company Name" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="role">Your Role</Label>
                    <Input id="role" placeholder="e.g., Lead Developer" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startDate">Start Date</Label>
                      <Input id="startDate" type="date" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endDate">End Date</Label>
                      <Input id="endDate" type="date" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="technologies">Technologies</Label>
                    <Input id="technologies" placeholder="e.g., React, Node.js, AWS (comma separated)" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectDesc">Description</Label>
                    <Textarea id="projectDesc" placeholder="Describe your contributions and achievements..." />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsProjectDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setIsProjectDialogOpen(false)}>Add Project</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {projects.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-16 text-center">
                <Briefcase className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h3 className="font-medium text-lg mb-1">No project records</h3>
                <p className="text-muted-foreground text-sm mb-4">
                  Add your project experience
                </p>
                <Button onClick={() => setIsProjectDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Project
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={completionDialogOpen} onOpenChange={setCompletionDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Complete Training</DialogTitle>
            <DialogDescription>
              Confirm completion and optionally attach a certification proof.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Training</Label>
              <p className="text-lg font-semibold text-green-700">{selectedTraining?.name}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Comment for manager (optional)</Label>
              <Textarea
                id="description"
                value={completionComment}
                onChange={(e) => setCompletionComment(e.target.value)}
                placeholder="Notes for your manager (optional)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="proof">Upload certification (optional)</Label>
              <Input
                id="proof"
                type="file"
                accept=".pdf,.docx,.png,.jpg,.jpeg"
                onChange={(e) => setCompletionFile(e.target.files?.[0] || null)}
              />
              {completionFile && (
                <p className="text-xs text-muted-foreground">Selected: {completionFile.name}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompletionDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleComplete} disabled={!selectedTraining || isSubmitting}>
              {isSubmitting ? 'Submitting...' : 'Confirm completion'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TrainingProjectsPage;
