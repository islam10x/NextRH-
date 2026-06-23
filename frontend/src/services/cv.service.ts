import api from './api';
import { CvProfile } from '@/types';

export const cvService = {
  async getMyProfile(): Promise<CvProfile> {
    const response = await api.get<CvProfile>('/cv/profile/me');
    return response.data;
  },

  async updateProfileBasics(payload: {
    currentPosition?: string;
    professionalSummary?: string;
    totalExperienceYears?: number;
    phone?: string;
    address?: string;
  }): Promise<CvProfile> {
    const response = await api.patch<CvProfile>('/cv/profile/me', payload);
    return response.data;
  },

  async createWorkExperience(payload: {
    jobTitle: string;
    companyName: string;
    startDate?: string;
    endDate?: string;
    isCurrent?: boolean;
    description?: string;
  }): Promise<CvProfile> {
    const response = await api.post<CvProfile>('/cv/work-experience', payload);
    return response.data;
  },

  async updateWorkExperience(
    experienceId: string,
    payload: {
      jobTitle?: string;
      companyName?: string;
      startDate?: string | null;
      endDate?: string | null;
      isCurrent?: boolean;
      description?: string;
    },
  ): Promise<CvProfile> {
    const response = await api.patch<CvProfile>(`/cv/work-experience/${experienceId}`, payload);
    return response.data;
  },

  async deleteWorkExperience(experienceId: string): Promise<CvProfile> {
    const response = await api.delete<CvProfile>(`/cv/work-experience/${experienceId}`);
    return response.data;
  },

  async createEducation(payload: {
    degree: string;
    fieldOfStudy?: string;
    institution?: string;
    endDate?: string;
  }): Promise<CvProfile> {
    const response = await api.post<CvProfile>('/cv/education', payload);
    return response.data;
  },

  async updateEducation(
    educationId: string,
    payload: {
      degree?: string;
      fieldOfStudy?: string;
      institution?: string;
      endDate?: string | null;
    },
  ): Promise<CvProfile> {
    const response = await api.patch<CvProfile>(`/cv/education/${educationId}`, payload);
    return response.data;
  },

  async deleteEducation(educationId: string): Promise<CvProfile> {
    const response = await api.delete<CvProfile>(`/cv/education/${educationId}`);
    return response.data;
  },
};
