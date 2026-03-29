import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { projectService } from '@/services/project.service';
import { Project } from '@/types';
import { Briefcase, Building2, Calendar, Code, User } from 'lucide-react';
import { toast } from 'sonner';

const formatDate = (dateString?: string) => {
  if (!dateString) return 'n/a';
  try {
    return new Date(dateString).toISOString().slice(0, 10);
  } catch {
    return dateString;
  }
};

const ManagerProjectsPage: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await projectService.listTeam();
      setProjects(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => {
      const haystack = [
        project.name,
        project.client,
        project.role,
        project.assigneeName,
        project.assigneeEmail,
        ...(project.technologies || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [projects, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground">Assigned projects across your team.</p>
        </div>
        <div className="w-full md:w-64">
          <Input
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Assigned Projects</CardTitle>
          <CardDescription>Track what your team is working on</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : filteredProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects assigned yet.</p>
          ) : (
            <div className="space-y-3">
              {filteredProjects.map((project) => (
                <div key={project.id} className="border rounded-lg p-4 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                        <Briefcase className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{project.name}</p>
                        {project.client && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            {project.client}
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge variant="secondary">{project.role || 'Contributor'}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {project.assigneeName || project.assigneeEmail || 'Unassigned'}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'Present'}
                    </span>
                  </div>

                  {project.description && (
                    <p className="text-sm text-muted-foreground">{project.description}</p>
                  )}

                  {project.technologies?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {project.technologies.map((tech) => (
                        <Badge key={`${project.id}-${tech}`} variant="outline" className="text-xs">
                          <Code className="h-3 w-3 mr-1" />
                          {tech}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagerProjectsPage;
