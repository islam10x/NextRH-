import api from './api';
import { Project } from '@/types';

const mapProject = (p: any): Project => ({
  id: p.id || p.participant_id || p.participantId,
  projectId: p.projectId || p.project_id,
  employeeId: p.employeeId || p.employee_id || '',
  assigneeProfileId: p.assigneeProfileId || p.assignee_profile_id || p.profileId || p.profile_id,
  assigneeName: p.assigneeName || p.assignee_name,
  assigneeEmail: p.assigneeEmail || p.assignee_email,
  assignedByName: p.assignedByName || p.assigned_by_name,
  name: p.name || p.projectName || p.project_name || '',
  client: p.client || p.clientName || p.client_name || '',
  startDate: p.startDate || p.start_date || '',
  endDate: p.endDate || p.end_date || undefined,
  technologies: p.technologies || p.skills || [],
  description: p.description || '',
  role: p.role || null,
  projectType: p.projectType || p.project_type || 'internal',
  assignmentType: p.assignmentType || p.assignment_type || 'internal',
  homeManagerId: p.homeManagerId || p.home_manager_id || null,
});

export interface OwnedProjectLite {
  projectId: string;
  projectName: string;
  clientName: string | null;
  projectType: 'internal' | 'external';
  complexity: string | null;
  startDate: string | null;
  endDate: string | null;
  assignedAt?: string | null;
}

export interface CrossTeamRequest {
  requestId: string;
  projectId: string;
  projectName: string;
  projectDescription?: string | null;
  clientName?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requestNote: string | null;
  responseNote: string | null;
  selectedProfileId: string | null;
  selectedEmployeeName?: string | null;
  createdAt: string;
  respondedAt: string | null;
  targetTeamId: string;
  targetTeamName: string;
  requestingManagerId?: string;
  requestingManagerName?: string;
  requestingTeamName?: string;
  targetManagerId?: string;
  targetManagerName?: string;
}

export const projectService = {
  async listMine(): Promise<Project[]> {
    const res = await api.get('/projects/me');
    return Array.isArray(res.data) ? res.data.map(mapProject) : [];
  },

  async listTeam(): Promise<Project[]> {
    const res = await api.get('/projects/team');
    return Array.isArray(res.data) ? res.data.map(mapProject) : [];
  },

  async listOwned(): Promise<OwnedProjectLite[]> {
    const res = await api.get('/projects/owned');
    return res.data || [];
  },

  async assign(payload: {
    projectName: string;
    clientName?: string;
    projectDescription?: string;
    startDate?: string;
    endDate?: string;
    technologies?: string[];
    assigneeProfileIds: string[];
    projectType: 'internal' | 'external';
    complexity?: string;
  }) {
    return api.post('/projects/assign', payload);
  },

  async requestCrossTeamMember(payload: {
    projectId: string;
    targetTeamId: string;
    requestNote?: string;
  }) {
    const res = await api.post('/projects/cross-team-requests', payload);
    return res.data as CrossTeamRequest;
  },

  async listIncomingCrossTeamRequests(): Promise<CrossTeamRequest[]> {
    const res = await api.get('/projects/cross-team-requests/incoming');
    return res.data || [];
  },

  async listOutgoingCrossTeamRequests(): Promise<CrossTeamRequest[]> {
    const res = await api.get('/projects/cross-team-requests/outgoing');
    return res.data || [];
  },

  async respondCrossTeamRequest(
    requestId: string,
    payload: { approved: boolean; selectedProfileId?: string; responseNote?: string },
  ) {
    const res = await api.patch(`/projects/cross-team-requests/${requestId}/respond`, payload);
    return res.data as CrossTeamRequest;
  },

  async updateParticipation(participantId: string, payload: { description?: string; role?: string }) {
    return api.patch(`/projects/participations/${participantId}`, payload);
  },

  /**
   * Self-service: remove a project from the employee's own CV. Only the
   * employee's own participation row is deleted, never the shared project.
   */
  async deleteParticipation(participantId: string) {
    return api.delete(`/projects/participations/${participantId}`);
  },
};
