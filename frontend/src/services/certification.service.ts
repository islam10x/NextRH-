import api from './api';
import { CertificationStatus } from '@/types';

export interface TeamCertification {
  certification_id: string;
  certificationName: string;
  issuingOrganization: string | null;
  issueDate: Date | null;
  expirationDate: Date | null;
  status: CertificationStatus;
  credentialId: string | null;
  hasProof: boolean;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
}

export interface CertificationStats {
  total: number;
  active: number;
  expiring_soon: number;
  expired: number;
}

export const certificationService = {
  /**
   * Get all certifications for team members managed by the current user
   */
  async getTeamCertifications(): Promise<TeamCertification[]> {
    const response = await api.get('/certifications/team');
    return response.data;
  },

  /**
   * Get certification statistics for the manager's team
   */
  async getTeamCertificationStats(): Promise<CertificationStats> {
    const response = await api.get('/certifications/team/stats');
    return response.data;
  },

  /**
   * Fetch a certification's proof file (authenticated) and return an object URL.
   * The caller is responsible for revoking the URL when done.
   */
  async getCertificationProofUrl(certificationId: string): Promise<string> {
    const response = await api.get(`/certifications/${certificationId}/proof`, {
      responseType: 'blob',
    });
    return URL.createObjectURL(response.data as Blob);
  },

  /**
   * Upload a certification file (for employees)
   */
  async uploadCertification(file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post('/certifications/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    return response.data;
  },

  /**
   * Self-service: create a manual (unverified) certification entry to
   * correct a CV parsing error.
   */
  async createCertification(payload: {
    certificationName: string;
    issuingOrganization?: string;
    issueDate?: string;
    expirationDate?: string;
    credentialId?: string;
  }) {
    const response = await api.post('/certifications', payload);
    return response.data;
  },

  /**
   * Self-service: edit a certification's metadata. The backend rejects this
   * once the certification is verified (isUploaded=true).
   */
  async updateCertification(
    certificationId: string,
    payload: {
      certificationName?: string;
      issuingOrganization?: string;
      issueDate?: string | null;
      expirationDate?: string | null;
      credentialId?: string;
    },
  ) {
    const response = await api.patch(`/certifications/${certificationId}`, payload);
    return response.data;
  },

  async deleteCertification(certificationId: string) {
    const response = await api.delete(`/certifications/${certificationId}`);
    return response.data;
  },
};