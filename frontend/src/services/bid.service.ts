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
};
