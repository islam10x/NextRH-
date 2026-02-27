// User Roles
export type UserRole = 'employee' | 'team_manager' | 'bid_manager';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatar?: string;
  teamId?: string;
  title: string;
  yearsOfExperience: number;
}

// Certification Status
export type CertificationStatus = 'active' | 'expiring_soon' | 'expired';

export interface Certification {
  id: string;
  employeeId: string;
  name: string;
  issuer: string;
  issueDate: string;
  expirationDate: string;
  status: CertificationStatus;
  credentialId?: string;
  documentUrl?: string;
}

export type TrainingStatus = 'assigned' | 'in_progress' | 'completed';

// Training
export interface Training {
  id: string;
  employeeId?: string;
  name: string;
  provider?: string;
  completionDate?: string;
  duration?: string;
  description?: string;
  status?: TrainingStatus;
  dueDate?: string;
  trainingUrl?: string;
  proofFilePath?: string;
  assigneeName?: string;
  assignedAt?: string;
  startDate?: string;
}

// Project
export interface Project {
  id: string;
  employeeId: string;
  name: string;
  client: string;
  startDate: string;
  endDate?: string;
  technologies: string[];
  description: string;
  role: string;
}

// Employee (extended user for profiles)
export interface Employee extends User {
  department: string;
  skills: string[];
  certifications: Certification[];
  trainings: Training[];
  projects: Project[];
  cvLastUpdated?: string;
  summary?: string;
  education?: Education[];
}

export interface Education {
  id: string;
  institution: string;
  degree: string;
  field: string;
  graduationYear: string;
}

// Team
export interface Team {
  id: string;
  name: string;
  managerId: string;
  memberIds: string[];
}

// CV Generation
export type CVFormat = 'standard' | 'canadian' | 'eu' | 'client_specific';
export type FontOption = 'Arial' | 'Times New Roman' | 'Calibri' | 'Helvetica';

export interface CVGenerationRequest {
  employeeId: string;
  format: CVFormat;
  font: FontOption;
}

// Notification
export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  read: boolean;
  createdAt: string;
  notificationType?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

// AI Chat
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  results?: Employee[];
}

// Dashboard Stats
export interface CertificationStats {
  active: number;
  expiringSoon: number;
  expired: number;
  total: number;
}

export interface DashboardStats {
  totalEmployees: number;
  totalCertifications: number;
  certificationsByStatus: CertificationStats;
  totalTeams: number;
  expiringThisMonth: number;
}

// File Upload
export type UploadStatus = 'idle' | 'uploading' | 'parsing' | 'completed' | 'error';

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  status: UploadStatus;
  progress: number;
  uploadedAt?: string;
  error?: string;
}

export interface ParsedCertificationMetadata {
  name: string;
  status: 'active' | 'expired' | 'unknown';
  expiration: string | null;
}

export interface ParsedEmployeeMetadata {
  name: string;
  skills: string[];
  certifications: ParsedCertificationMetadata[];
  experience_years: number;
  last_update: string;
}
