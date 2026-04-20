import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { projectService } from '@/services/project.service';
import { teamService } from '@/services/team.service';
import { Project } from '@/types';
import { Briefcase, Building2, Calendar, Code, Search, User } from 'lucide-react';
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
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [assignSearch, setAssignSearch] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [clientName, setClientName] = useState('');
  const [profileRoles, setProfileRoles] = useState<Record<string, string>>({});
  const [projectComplexity, setProjectComplexity] = useState('medium');
  const [projectStartDate, setProjectStartDate] = useState('');
  const [projectEndDate, setProjectEndDate] = useState('');
  const [projectTechnologies, setProjectTechnologies] = useState('');
  const [projectDescription, setProjectDescription] = useState('');

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

  const loadMembers = async () => {
    setLoadingMembers(true);
    try {
      const data = await teamService.listMyMembers();
      const mapped = data.map((m) => ({
        userId: m.userId,
        profileId: m.profileId,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
        email: m.email,
      }));
      setMembers(mapped);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to load team members');
    } finally {
      setLoadingMembers(false);
    }
  };

  useEffect(() => {
    load();
    loadMembers();
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

  const filteredMembers = useMemo(() => {
    const query = assignSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter((m) => {
      const name = (m.name || '').toLowerCase();
      const email = (m.email || '').toLowerCase();
      return name.includes(query) || email.includes(query);
    });
  }, [assignSearch, members]);

  const toggleSelection = (profileId: string | null) => {
    if (!profileId) {
      toast.error('This member has no profile yet');
      return;
    }
    setSelectedProfiles((prev) => {
      if (prev.includes(profileId)) {
        // Unselect: also remove the role entry
        setProfileRoles((r) => {
          const copy = { ...r };
          delete copy[profileId];
          return copy;
        });
        return prev.filter((id) => id !== profileId);
      }
      // Select: default role = contributor
      setProfileRoles((r) => ({ ...r, [profileId]: 'contributor' }));
      return [...prev, profileId];
    });
  };

  const resetAssignForm = () => {
    setSelectedProfiles([]);
    setAssignSearch('');
    setProjectName('');
    setClientName('');
    setProfileRoles({});
    setProjectComplexity('medium');
    setProjectStartDate('');
    setProjectEndDate('');
    setProjectTechnologies('');
    setProjectDescription('');
  };

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) {
      toast.error('Project name is required.');
      return;
    }
    if (selectedProfiles.length === 0) {
      toast.error('Select at least one team member.');
      return;
    }

    setIsAssigning(true);
    try {
      const technologies = projectTechnologies
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await projectService.assign({
        projectName: projectName.trim(),
        clientName: clientName.trim() || undefined,
        projectDescription: projectDescription.trim() || undefined,
        startDate: projectStartDate || undefined,
        endDate: projectEndDate || undefined,
        technologies: technologies.length ? technologies : undefined,
        assigneeProfileIds: selectedProfiles,
        complexity: projectComplexity,
        roles: profileRoles,
      });

      const count = selectedProfiles.length;
      toast.success(`Project assigned to ${count} member${count === 1 ? '' : 's'}`);
      setIsAssignOpen(false);
      resetAssignForm();
      load();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to assign project');
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground">Assigned projects across your team.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
          <Dialog
            open={isAssignOpen}
            onOpenChange={(open) => {
              if (!open) resetAssignForm();
              setIsAssignOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button className="w-full sm:w-auto">Assign Project</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-xl">Assign Project</DialogTitle>
                <DialogDescription>
                  Assign a project to one or more team members.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAssign} className="space-y-4">
                <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto pr-1">
                  <div className="space-y-2">
                    <Label htmlFor="projectName">Project Name</Label>
                    <Input
                      id="projectName"
                      placeholder="e.g., Cloud Migration Initiative"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="clientName">Client</Label>
                    <Input
                      id="clientName"
                      placeholder="e.g., Company Name"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectComplexity">Complexité</Label>
                    <Select value={projectComplexity} onValueChange={setProjectComplexity}>
                      <SelectTrigger>
                        <SelectValue placeholder="Sélectionner la complexité" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Basse</SelectItem>
                        <SelectItem value="medium">Moyenne</SelectItem>
                        <SelectItem value="high">Haute</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="startDate">Start Date</Label>
                      <Input
                        id="startDate"
                        type="date"
                        value={projectStartDate}
                        onChange={(e) => setProjectStartDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="endDate">End Date</Label>
                      <Input
                        id="endDate"
                        type="date"
                        value={projectEndDate}
                        onChange={(e) => setProjectEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="technologies">Technologies</Label>
                    <Input
                      id="technologies"
                      placeholder="e.g., React, Node.js, AWS"
                      value={projectTechnologies}
                      onChange={(e) => setProjectTechnologies(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="projectDescription">Project Summary</Label>
                    <Input
                      id="projectDescription"
                      placeholder="Short project context for the team"
                      value={projectDescription}
                      onChange={(e) => setProjectDescription(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Team members</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Search team members..."
                        value={assignSearch}
                        onChange={(e) => setAssignSearch(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <div className="max-h-48 overflow-auto rounded-md border p-2 space-y-2">
                      {loadingMembers ? (
                        <p className="text-sm text-muted-foreground">Loading members...</p>
                      ) : members.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No team members found</p>
                      ) : filteredMembers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No matching team members</p>
                      ) : (
                        filteredMembers.map((m) => {
                          const disabled = !m.profileId;
                          const checked = m.profileId ? selectedProfiles.includes(m.profileId) : false;
                          return (
                            <div key={m.userId} className="flex items-center gap-2 text-sm">
                              <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                                <input
                                  type="checkbox"
                                  disabled={disabled}
                                  checked={checked}
                                  onChange={() => toggleSelection(m.profileId)}
                                />
                                <span className={`truncate ${disabled ? 'text-muted-foreground' : ''}`}>
                                  {m.name} ({m.email}) {disabled && '(no profile yet)'}
                                </span>
                              </label>
                              {checked && m.profileId && (
                                <Select
                                  value={profileRoles[m.profileId] || 'contributor'}
                                  onValueChange={(v) =>
                                    setProfileRoles((r) => ({ ...r, [m.profileId!]: v }))
                                  }
                                >
                                  <SelectTrigger className="w-[160px] h-7 text-xs shrink-0">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="contributor">Contributeur</SelectItem>
                                    <SelectItem value="technical_lead">Lead Technique</SelectItem>
                                    <SelectItem value="project_lead">Chef de Projet</SelectItem>
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
                <DialogFooter className="pt-4 gap-2">
                  <Button type="button" variant="ghost" onClick={() => setIsAssignOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isAssigning}>
                    {isAssigning ? 'Assigning...' : 'Assign Project'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <div className="w-full md:w-64">
            <Input
              placeholder="Search projects..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
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
