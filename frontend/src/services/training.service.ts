import api from './api';
import { Training, TrainingStatus } from '@/types';

export interface BackendTraining {
  training_id: string;
  trainingTitle: string;
  provider?: string;
  dueDate?: string;
  status?: TrainingStatus;
  trainingUrl?: string;
  proofFilePath?: string;
  startDate?: string;
  endDate?: string;
}

const mapTraining = (t: any): Training => ({
  id: t.training_id || t.id,
  name: t.trainingTitle || t.training_title || t.name,
  provider: t.provider,
  certificationName: t.certificationName || t.certification_name,
  certificationIssueDate: t.certificationIssueDate || t.certification_issue_date,
  status: t.status,
  dueDate: t.dueDate || t.due_date,
  completionDate: t.endDate || t.end_date,
  startDate: t.startDate || t.start_date,
  trainingUrl: t.trainingUrl || t.training_url,
  proofFilePath: t.proofFilePath || t.proof_file_path,
  proofUrl: `${api.defaults.baseURL?.replace(/\/$/, '') || ''}/training/${t.training_id || t.id}/proof`,
  description: t.description,
  assignedByName: t.assignedByName || t.assigned_by_name,
  assigneeName:
    t.assigneeName ||
    (t.profile?.user
      ? [t.profile.user.first_name || t.profile.user.firstName, t.profile.user.last_name || t.profile.user.lastName]
          .filter(Boolean)
          .join(' ')
      : undefined) ||
    t.profile?.user?.email,
  assignedAt: t.createdAt || t.created_at,
});

export const trainingService = {
  async listMine(): Promise<Training[]> {
    const res = await api.get<BackendTraining[]>('/training/me');
    return res.data.map(mapTraining);
  },

  async listAssignedByMe(): Promise<Training[]> {
    const res = await api.get<BackendTraining[]>('/training/assigned/me');
    return res.data.map(mapTraining);
  },

  async assign(payload: {
    trainingTitle: string;
    provider?: string;
    trainingUrl?: string;
    dueDate?: string;
    description?: string;
    assigneeProfileIds: string[];
  }) {
    return api.post('/training/assign', payload);
  },

  async start(trainingId: string) {
    await api.patch(`/training/${trainingId}/status`, { status: 'in_progress' });
  },

  async completeWithoutProof(trainingId: string, payload: { endDate?: string; description?: string }) {
    await api.patch(`/training/${trainingId}/status`, { status: 'completed', ...payload });
  },

  async uploadProof(trainingId: string, file: File, payload: { issueDate?: string; description?: string; relatedProjectId?: string } = {}) {
    const form = new FormData();
    form.append('file', file);
    if (payload.issueDate) form.append('issueDate', payload.issueDate);
    if (payload.description) form.append('description', payload.description);
    if (payload.relatedProjectId) form.append('relatedProjectId', payload.relatedProjectId);
    await api.post(`/training/${trainingId}/proof`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  async downloadProof(trainingId: string): Promise<Blob> {
    const res = await api.get(`/training/${trainingId}/proof`, {
      responseType: 'blob',
    });
    return res.data;
  },
};
