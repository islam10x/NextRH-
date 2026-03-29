import api from './api';
import { Project } from '@/types';

const mapProject = (p: any): Project => ({
  id: p.id || p.participant_id || p.participantId,
  employeeId: p.employeeId || p.employee_id || '',
  assigneeProfileId: p.assigneeProfileId || p.assignee_profile_id || p.profileId || p.profile_id,
  assigneeName: p.assigneeName || p.assignee_name,
  assigneeEmail: p.assigneeEmail || p.assignee_email,
  name: p.name || p.projectName || p.project_name || '',
  client: p.client || p.clientName || p.client_name || '',
  startDate: p.startDate || p.start_date || '',
  endDate: p.endDate || p.end_date || undefined,
  technologies: p.technologies || p.skills || [],
  description: p.description || '',
  role: p.role || 'Contributor',
});

export const projectService = {
  async listMine(): Promise<Project[]> {
    const res = await api.get('/projects/me');
    return Array.isArray(res.data) ? res.data.map(mapProject) : [];
  },

  async listTeam(): Promise<Project[]> {
    const res = await api.get('/projects/team');
    return Array.isArray(res.data) ? res.data.map(mapProject) : [];
  },

  async assign(payload: {
    projectName: string;
    clientName?: string;
    projectDescription?: string;
    startDate?: string;
    endDate?: string;
    technologies?: string[];
    assigneeProfileIds: string[];
    role?: string;
  }) {
    return api.post('/projects/assign', payload);
  },

  async updateParticipation(participantId: string, payload: { description?: string; role?: string }) {
    return api.patch(`/projects/participations/${participantId}`, payload);
  },
};
