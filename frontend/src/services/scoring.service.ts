import api from './api';

export interface ProjectRecord {
  record_id: string;
  profileId: string;
  projectName: string;
  clientName: string | null;
  projectDescription: string | null;
  completionDate: string | null;
  complexity: 'low' | 'medium' | 'high';
  pvVerified: boolean;
  individualScore: number | null;
  evaluationStatus: 'scored_by_own_manager' | 'pending_external_manager' | 'scored_by_home_manager';
  externalContributionDescription: string | null;
  externalHomeManagerId: string | null;
  evaluatedByManagerId: string | null;
  evaluatedAt: string | null;
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

export interface ProjectScoreDetail {
  project_name: string;
  complexity: 'low' | 'medium' | 'high';
  completion_date: string | null;
  pv_verified: boolean;
  evaluation_status: 'scored_by_own_manager' | 'pending_external_manager' | 'scored_by_home_manager';
  manager_score_raw: number | null;
  manager_score_scale_max: number;
  contribution_score: number;
  scoring_method: 'manager_score_converted' | 'legacy_manager_score' | 'complexity_fallback';
  explanation: string;
}

export interface ScoreDetails {
  project_score: number;
  certification_score: number;
  training_score: number;
  formation_score: number;
  final_score: number;
  score_formula: string;
  manager_score_scale_max: number;
  project_count: number;
  pending_external_count: number;
  scored_project_count: number;
  evaluated_projects?: ProjectScoreDetail[];
  pending_external_projects?: ProjectScoreDetail[];
  headline?: {
    tone: 'excellent' | 'strong' | 'developing' | 'starting';
    title: string;
    message: string;
  };
  scale?: {
    manager_score_max: number;
    pillar_score_max: number;
    final_score_max: number;
  };
  formulas?: {
    final?: string;
    projects?: string;
    certifications?: string;
    trainings?: string;
    formations?: string;
  };
  workflow?: {
    scoring_year?: number;
    pending_external_projects_use_provisional_complexity?: boolean;
    next_actions?: string[];
  };
  pillars?: {
    projects?: {
      score: number;
      total_projects_in_year: number;
      scored_projects: number;
      pending_external_projects: number;
      items: ProjectScoreDetail[];
    };
    certifications?: {
      score: number;
      count: number;
      target: number;
      effective_target: number;
      progress_percent: number;
      explanation: string;
    };
    trainings?: {
      score: number;
      count: number;
      points_per_completed_training: number;
      explanation: string;
    };
    formations?: {
      score: number;
      count: number;
      points_per_delivered_formation: number;
      explanation: string;
    };
  };
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
  scoreDetails: ScoreDetails | null;
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
    status: 'created' | 'updated' | 'duplicate';
    message?: string;
  }>;
}

export interface AvailableProject {
  project_id: string;
  projectName: string;
  clientName: string | null;
  projectType: 'internal' | 'external';
  complexity: string | null;
  startDate: string | null;
  endDate: string | null;
  participants: {
    profileId: string;
    name: string;
    assignmentType: 'internal' | 'external';
    homeManagerId: string | null;
  }[];
}

export interface PvPreview {
  document_type: string;
  file_hash: string;
  parsed_data: {
    project_name?: string | null;
    client_name?: string | null;
    completion_date?: string | null;
    team_members?: Array<{ name: string; role?: string }>;
    completion_confirmed?: boolean;
    assumptions?: string[];
    complexity?: string | null;
  };
}

export interface PendingExternalEvaluation {
  recordId: string;
  profileId: string;
  projectName: string;
  clientName: string | null;
  complexity: string | null;
  externalContributionDescription: string | null;
  completionDate: string | null;
  submittedBy: string | null;
  createdAt: string;
  employeeName: string;
}

export interface PendingInternalEvaluation {
  recordId: string;
  profileId: string;
  projectName: string;
  clientName: string | null;
  projectDescription: string | null;
  complexity: string | null;
  completionDate: string | null;
  assignmentDate: string | null;
  createdAt: string;
  employeeName: string;
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

export const scoringService = {
  async previewPv(file: File): Promise<PvPreview> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await api.post('/scoring/preview-pv', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },

  async uploadPv(
    file: File,
    profileIds: string[],
    projectId: string,
    complexity?: string,
    profileEvaluations?: Array<{ profileId: string; score?: number; contributionDescription?: string }>,
  ): Promise<UploadResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('profileIds', JSON.stringify(profileIds));
    formData.append('projectId', projectId);
    if (complexity) formData.append('complexity', complexity);
    if (profileEvaluations?.length) {
      formData.append('profileEvaluations', JSON.stringify(profileEvaluations));
    }

    const res = await api.post('/scoring/upload-pv', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },

  async uploadTrainingSheet(file: File): Promise<UploadResult> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await api.post('/scoring/upload-training-sheet', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },

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

  async computeScore(profileId: string, year: number) {
    const res = await api.post('/scoring/compute', { profileId, year });
    return res.data;
  },

  async computeTeamScores(year: number) {
    const res = await api.post('/scoring/compute-team', { year });
    return res.data;
  },

  async computeAllScores(year: number) {
    const res = await api.post('/scoring/compute-all', { year });
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

  async getProjectRecords(profileId: string): Promise<ProjectRecord[]> {
    const res = await api.get(`/scoring/project-records/${profileId}`);
    return res.data || [];
  },

  async getTrainingRecords(profileId: string): Promise<TrainingRecord[]> {
    const res = await api.get(`/scoring/training-records/${profileId}`);
    return res.data || [];
  },

  async updateProjectRecord(recordId: string, data: { complexity?: string }) {
    const res = await api.patch(`/scoring/project-records/${recordId}`, data);
    return res.data;
  },

  async listPendingExternalEvaluations(): Promise<PendingExternalEvaluation[]> {
    const res = await api.get('/scoring/external-evaluations/pending');
    return res.data || [];
  },

  async listPendingInternalEvaluations(): Promise<PendingInternalEvaluation[]> {
    const res = await api.get('/scoring/internal-evaluations/pending');
    return res.data || [];
  },

  async scoreExternalEvaluation(recordId: string, score: number) {
    const res = await api.post(`/scoring/external-evaluations/${recordId}/score`, { score });
    return res.data;
  },

  async scoreInternalEvaluation(recordId: string, score: number) {
    const res = await api.post(`/scoring/internal-evaluations/${recordId}/score`, { score });
    return res.data;
  },

  async listProjects(): Promise<AvailableProject[]> {
    const res = await api.get('/scoring/projects');
    return res.data || [];
  },

  async getLeaderboard(year: number, teamId?: string, limit?: number): Promise<LeaderboardEntry[]> {
    const params: Record<string, string> = { year: String(year) };
    if (teamId) params.teamId = teamId;
    if (limit) params.limit = String(limit);

    const res = await api.get('/scoring/leaderboard', { params });
    return res.data || [];
  },
};
