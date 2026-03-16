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
};