import api from './api';

// ── Types ────────────────────────────────────────────────────────────────

export interface ProjectRecord {
  record_id: string;
  profileId: string;
  projectName: string;
  clientName: string | null;
  projectDescription: string | null;
  completionDate: string | null;
  complexity: 'low' | 'medium' | 'high';
  employeeRole: 'contributor' | 'technical_lead' | 'project_lead';
  pvVerified: boolean;
  submittedBy: string | null;
  sourceFilename: string | null;
  createdAt: string;
}

export interface TrainingRecord {
  record_id: string;
  profileId: string;
  trainingName: string;
  trainerName: string | null;
  clientName: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  participantCount: number;
  sourceFilename: string | null;
  createdAt: string;
}

export interface ScoringTarget {
  target_id: string;
  profileId: string;
  targetYear: number;
  certificationTarget: number;
}

export interface ScoringWeights {
  projectWeight: number;
  certificationWeight: number;
  trainingWeight: number;
  formationWeight: number;
}

export interface EmployeeScore {
  score_id: string;
  profileId: string;
  scoreYear: number;
  projectScore: number;
  certificationScore: number;
  trainingScore: number;
  formationScore: number;
  finalScore: number;
  rankGlobal: number | null;
  rankInTeam: number | null;
  percentile: number | null;
  scoreDetails: Record<string, any> | null;
}

export interface LeaderboardEntry {
  rank: number;
  profileId: string;
  employeeName: string;
  finalScore: number;
  projectScore: number;
  certificationScore: number;
  trainingScore: number;
  formationScore: number;
  percentile: number | null;
}

export interface UploadResult {
  status: 'created' | 'duplicate';
  message?: string;
  record?: ProjectRecord | TrainingRecord;
  parsed_data?: Record<string, any>;
  results?: Array<{
    profileId: string;
    employeeName: string;
    status: 'created' | 'duplicate';
    message?: string;
  }>;
}

export interface AvailableProject {
  project_id: string;
  projectName: string;
  clientName: string | null;
  complexity: string | null;
  startDate: string | null;
  endDate: string | null;
  participants: { profileId: string; name: string; role: string }[];
}

const normalizeEmployeeScore = (score: any): EmployeeScore | null => {
  if (!score) return null;

  return {
    ...score,
    projectScore: Number(score.projectScore ?? 0),
    certificationScore: Number(score.certificationScore ?? 0),
    trainingScore: Number(score.trainingScore ?? 0),
    formationScore: Number(score.formationScore ?? 0),
    finalScore: Number(score.finalScore ?? 0),
    percentile: score.percentile != null ? Number(score.percentile) : null,
  };
};

const normalizeWeights = (weights: any): ScoringWeights => ({
  projectWeight: Number(weights?.projectWeight ?? 0),
  certificationWeight: Number(weights?.certificationWeight ?? 0),
  trainingWeight: Number(weights?.trainingWeight ?? 0),
  formationWeight: Number(weights?.formationWeight ?? 0),
});

// ── Service ──────────────────────────────────────────────────────────────

export const scoringService = {
  // ── Upload ──────────────────────────────────────────────────────────

  /** Team Manager uploads a PV for an employee */
  async uploadPv(
    file: File,
    profileIds: string[],
    projectId?: string,
    projectName?: string,
    clientName?: string,
    complexity?: string,
    employeeRole?: string,
  ): Promise<UploadResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('profileIds', JSON.stringify(profileIds));
    if (projectId) formData.append('projectId', projectId);
    if (projectName) formData.append('projectName', projectName);
    if (clientName) formData.append('clientName', clientName);
    if (complexity) formData.append('complexity', complexity);
    if (employeeRole) formData.append('employeeRole', employeeRole);

    const res = await api.post('/scoring/upload-pv', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },

  /** Employee uploads their own training sheet */
  async uploadTrainingSheet(file: File): Promise<UploadResult> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await api.post('/scoring/upload-training-sheet', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },

  // ── Targets ─────────────────────────────────────────────────────────

  async setTarget(profileId: string, targetYear: number, certificationTarget: number) {
    const res = await api.post('/scoring/targets', { profileId, targetYear, certificationTarget });
    return res.data;
  },

  async getTarget(profileId: string, year: number): Promise<ScoringTarget | null> {
    try {
      const res = await api.get(`/scoring/targets/${profileId}/${year}`);
      return res.data;
    } catch {
      return null;
    }
  },

  // ── Score ───────────────────────────────────────────────────────────

  async computeScore(profileId: string, year: number) {
    const res = await api.post('/scoring/compute', { profileId, year });
    return res.data;
  },

  async computeTeamScores(year: number) {
    const res = await api.post('/scoring/compute-team', { year });
    return res.data;
  },

  async getScore(profileId: string, year: number): Promise<EmployeeScore | null> {
    try {
      const res = await api.get(`/scoring/score/${profileId}/${year}`);
      return normalizeEmployeeScore(res.data);
    } catch {
      return null;
    }
  },

  async getScoreHistory(profileId: string): Promise<EmployeeScore[]> {
    const res = await api.get(`/scoring/history/${profileId}`);
    return (res.data || []).map((score: any) => normalizeEmployeeScore(score)).filter(Boolean);
  },

  // ── Records ─────────────────────────────────────────────────────────

  async getProjectRecords(profileId: string): Promise<ProjectRecord[]> {
    const res = await api.get(`/scoring/project-records/${profileId}`);
    return res.data || [];
  },

  async getTrainingRecords(profileId: string): Promise<TrainingRecord[]> {
    const res = await api.get(`/scoring/training-records/${profileId}`);
    return res.data || [];
  },

  async updateProjectRecord(recordId: string, data: { complexity?: string; employeeRole?: string }) {
    const res = await api.patch(`/scoring/project-records/${recordId}`, data);
    return res.data;
  },

  /** List all projects (for PV upload project selector) */
  async listProjects(): Promise<AvailableProject[]> {
    const res = await api.get('/scoring/projects');
    return res.data || [];
  },

  // ── Leaderboard ─────────────────────────────────────────────────────

  async getLeaderboard(year: number, teamId?: string, limit?: number): Promise<LeaderboardEntry[]> {
    const params: Record<string, string> = { year: String(year) };
    if (teamId) params.teamId = teamId;
    if (limit) params.limit = String(limit);

    const res = await api.get('/scoring/leaderboard', { params });
    return res.data || [];
  },

  // ── Weights ─────────────────────────────────────────────────────────

  async getWeights(teamId?: string) {
    const params = teamId ? { teamId } : {};
    const res = await api.get('/scoring/weights', { params });
    return normalizeWeights(res.data);
  },

  async updateWeights(projectWeight: number, certificationWeight: number, trainingWeight: number, formationWeight: number, teamId?: string) {
    const res = await api.patch('/scoring/weights', {
      projectWeight,
      certificationWeight,
      trainingWeight,
      formationWeight,
      teamId,
    });
    return res.data;
  },
};
