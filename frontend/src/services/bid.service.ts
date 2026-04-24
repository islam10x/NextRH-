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

export type RagStreamEvent =
  | { type: 'results'; data: any[] }
  | { type: 'token'; data: string }
  | { type: 'replace'; data: string }
  | { type: 'done' };

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

  async chatStream(
    message: string,
    sessionId = 'bid-chat',
    onEvent?: (event: RagStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const baseUrl = String(api.defaults.baseURL || '').replace(/\/+$/, '');
    const token = sessionStorage.getItem('access_token');
    const response = await fetch(`${baseUrl}/rag/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal,
    });

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      throw new Error(`RAG stream failed: ${response.status} ${body}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No readable stream from backend');

    const decoder = new TextDecoder();
    let buffer = '';

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== 'string') return;

      if (
        parsed.type === 'results' ||
        parsed.type === 'token' ||
        parsed.type === 'replace' ||
        parsed.type === 'done'
      ) {
        onEvent?.(parsed as RagStreamEvent);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }

    if (buffer.trim()) {
      handleLine(buffer);
    }
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
    engine: 'primary' | 'fallback' = 'primary',
  ): Promise<Blob> {
    const formData = new FormData();
    formData.append('template', templateFile);
    formData.append('employeeId', employeeId);

    const res = await api.post(`/cv/generate?format=${format}&engine=${engine}`, formData, {
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
    engine: 'primary' | 'fallback' = 'primary',
  ): Promise<Blob> {
    const res = await api.post(
      `/cv/generate-from-stored?format=${format}&engine=${engine}`,
      { templateEmployeeId, targetEmployeeId },
      { responseType: 'blob' },
    );
    return res.data as Blob;
  },
};
