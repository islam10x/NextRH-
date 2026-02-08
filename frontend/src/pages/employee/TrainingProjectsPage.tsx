import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { mockEmployees } from '@/data/mockData';
import { Employee, Training, Project } from '@/types';
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

const TrainingProjectsPage: React.FC = () => {
  const { user } = useAuth();
  const [isTrainingDialogOpen, setIsTrainingDialogOpen] = useState(false);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);

  const employeeData = mockEmployees.find((emp) => emp.id === user?.id) as Employee | undefined;
  const trainings = employeeData?.trainings || [];
  const projects = employeeData?.projects || [];

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM yyyy');
    } catch {
      return dateString;
    }
  };

  const TrainingCard: React.FC<{ training: Training }> = ({ training }) => (
    <Card className="hover:shadow-md transition-shadow animate-fade-in">
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className="p-2 rounded-lg bg-accent/10 shrink-0">
            <GraduationCap className="h-5 w-5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground">{training.name}</h3>
            <p className="text-sm text-muted-foreground">{training.provider}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formatDate(training.completionDate)}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {training.duration}
              </span>
            </div>
            {training.description && (
              <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                {training.description}
              </p>
            )}
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
          <div className="flex justify-end">
            <Dialog open={isTrainingDialogOpen} onOpenChange={setIsTrainingDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Training
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Training</DialogTitle>
                  <DialogDescription>
                    Add a new training or course you've completed.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="trainingName">Training Name</Label>
                    <Input id="trainingName" placeholder="e.g., Advanced Kubernetes" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="provider">Provider</Label>
                    <Input id="provider" placeholder="e.g., Coursera, Udemy" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="completionDate">Completion Date</Label>
                      <Input id="completionDate" type="date" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="duration">Duration</Label>
                      <Input id="duration" placeholder="e.g., 40 hours" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="trainingDesc">Description (Optional)</Label>
                    <Textarea id="trainingDesc" placeholder="Brief description of what you learned..." />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsTrainingDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setIsTrainingDialogOpen(false)}>Add Training</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {trainings.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {trainings.map((training) => (
                <TrainingCard key={training.id} training={training} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-16 text-center">
                <GraduationCap className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h3 className="font-medium text-lg mb-1">No training records</h3>
                <p className="text-muted-foreground text-sm mb-4">
                  Add your completed training and courses
                </p>
                <Button onClick={() => setIsTrainingDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Training
                </Button>
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
    </div>
  );
};

export default TrainingProjectsPage;
