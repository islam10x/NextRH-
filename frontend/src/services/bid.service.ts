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

export interface CvWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  details?: any;
}

export interface MyTemplateHistoryItem {
  id: string;
  templateName: string;
  templateType: string;
  language: string | null;
  originalFilename: string | null;
  extension: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
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
   * @param language - 'original' (no translation), 'en', or 'fr'
   * Returns the generated file as a Blob and any non-fatal warnings the
   * AI service surfaced in the X-CV-Warnings response header.
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
      signal: options?.signal,
    });

    const warningsHeader = (res.headers as any)?.['x-cv-warnings'];
    let warnings: CvWarning[] = [];
    if (typeof warningsHeader === 'string' && warningsHeader.trim()) {
      try {
        const parsed = JSON.parse(warningsHeader);
        if (Array.isArray(parsed)) {
          warnings = parsed.filter(
            (w): w is CvWarning => !!w && typeof w === 'object' && typeof w.message === 'string',
          );
        }
      } catch {
        // Header malformed — silently ignore; warnings are best-effort.
      }
    }

    return { blob: res.data as Blob, warnings };
  },

  /**
   * Decode an Axios error whose response body is a Blob (e.g. when the
   * request used `responseType: 'blob'`). The server returns JSON on errors,
   * but Axios still hands it back as a Blob — we read it back to text and
   * pull the human-readable message out.
   */
  async extractBlobErrorMessage(err: unknown): Promise<string> {
    const fallback = 'CV generation failed';
    const anyErr = err as { message?: string; response?: { data?: unknown } };
    const data = anyErr?.response?.data;
    if (data instanceof Blob) {
      try {
        const text = await data.text();
        try {
          const parsed = JSON.parse(text);
          return parsed?.message || parsed?.detail || text || fallback;
        } catch {
          return text || fallback;
        }
      } catch {
        return anyErr.message || fallback;
      }
    }
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
      const obj = data as { message?: string; detail?: string };
      return obj.message || obj.detail || anyErr.message || fallback;
    }
    return anyErr.message || fallback;
  },

  /**
   * List the bid manager's previously-used templates so the UI can offer a
   * one-click re-use dropdown above the upload input.
   */
  async listMyTemplates(): Promise<MyTemplateHistoryItem[]> {
    const res = await api.get<MyTemplateHistoryItem[]>('/cv-templates/mine');
    return Array.isArray(res.data) ? res.data : [];
  },

  /**
   * Remove a template from the bid manager's history (deletes the row + the
   * underlying file off disk).
   */
  async deleteMyTemplate(templateId: string): Promise<void> {
    await api.delete(`/cv-templates/${templateId}`);
  },

  /**
   * Generate a CV by re-using a template the bid manager has already used,
   * picked from their history. Mirrors the multipart `generateCv` response
   * shape so callers don't have to special-case it.
   */
  async generateCvFromHistory(
    employeeId: string,
    templateId: string,
    format: 'docx' | 'pdf' = 'docx',
    language: 'en' | 'fr' | 'original' = 'original',
    engine: 'primary' | 'fallback' = 'fallback',
    options?: { signal?: AbortSignal },
  ): Promise<{ blob: Blob; warnings: CvWarning[] }> {
    const params = new URLSearchParams({ format, language, engine });
    const res = await api.post(
      `/cv/generate-from-history?${params.toString()}`,
      { templateId, employeeId },
      {
        responseType: 'blob',
        signal: options?.signal,
      },
    );

    const warningsHeader = (res.headers as any)?.['x-cv-warnings'];
    let warnings: CvWarning[] = [];
    if (typeof warningsHeader === 'string' && warningsHeader.trim()) {
      try {
        const parsed = JSON.parse(warningsHeader);
        if (Array.isArray(parsed)) {
          warnings = parsed.filter(
            (w): w is CvWarning => !!w && typeof w === 'object' && typeof w.message === 'string',
          );
        }
      } catch {
        // Header malformed — silently ignore; warnings are best-effort.
      }
    }

    return { blob: res.data as Blob, warnings };
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
