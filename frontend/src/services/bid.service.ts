import api from './api';

export interface BidCertStats {
  total: number;
  active: number;
  expiringSoon: number;
  expired: number;
  expiringThisMonth: number;
  byOrg: { name: string; value: number }[];
}

export interface BidDashboardStats {
  totalEmployees: number;
  totalTeams: number;
  certStats: BidCertStats;
}

export interface RagChatResponse {
  answer: string;
  context: { content: string; metadata: Record<string, any> }[];
}

export const bidService = {
  async getDashboardStats(): Promise<BidDashboardStats> {
    const [usersRes, certStatsRes, teamsRes] = await Promise.all([
      api.get('/users'),
      api.get('/certifications/bid/stats'),
      api.get('/teams/count'),
    ]);

    const employees = (usersRes.data as any[]).filter((u) => u.role === 'employee');

    return {
      totalEmployees: employees.length,
      totalTeams: teamsRes.data.count,
      certStats: certStatsRes.data as BidCertStats,
    };
  },

  async chat(message: string, sessionId = 'bid-chat'): Promise<RagChatResponse> {
    const res = await api.post('/rag/chat', { message, session_id: sessionId });
    return res.data as RagChatResponse;
  },

  /**
   * Generate a CV by uploading a template and specifying an employee.
   * @param format - 'docx' for download, 'pdf' for preview
   * Returns the generated file as a Blob.
   */
  async generateCv(
    employeeId: string,
    templateFile: File,
    format: 'docx' | 'pdf' = 'docx',
    language: 'en' | 'fr' = 'en',
    engine: 'primary' | 'fallback' = 'primary',
  ): Promise<Blob> {
    const formData = new FormData();
    formData.append('template', templateFile);
    formData.append('employeeId', employeeId);

    const res = await api.post(`/cv/generate?format=${format}&language=${language}&engine=${engine}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      responseType: 'blob',
    });
    return res.data as Blob;
  },

  /**
   * Generate a CV using another employee's stored CV as the template.
   * @param format - 'docx' for download, 'pdf' for preview
   */
  async generateCvFromStored(
    templateEmployeeId: string,
    targetEmployeeId: string,
    format: 'docx' | 'pdf' = 'docx',
  ): Promise<Blob> {
    const res = await api.post(
      `/cv/generate-from-stored?format=${format}`,
      { templateEmployeeId, targetEmployeeId },
      { responseType: 'blob' },
    );
    return res.data as Blob;
  },
};
