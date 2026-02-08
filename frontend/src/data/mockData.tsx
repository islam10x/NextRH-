import { Employee, Team, Notification, CertificationStats, DashboardStats, ChatMessage } from '@/types';

// Helper to generate dates
const daysFromNow = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
};

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
};

// Mock Employees
export const mockEmployees: Employee[] = [
  {
    id: 'emp-001',
    email: 'john.smith@company.com',
    name: 'John Smith',
    role: 'employee',
    teamId: 'team-001',
    title: 'Senior Cloud Architect',
    yearsOfExperience: 8,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['AWS', 'Azure', 'Kubernetes', 'Terraform', 'Docker', 'Python', 'Go'],
    summary: 'Experienced cloud architect with expertise in designing and implementing scalable cloud solutions.',
    certifications: [
      {
        id: 'cert-001',
        employeeId: 'emp-001',
        name: 'AWS Solutions Architect Professional',
        issuer: 'Amazon Web Services',
        issueDate: daysAgo(365),
        expirationDate: daysFromNow(365),
        status: 'active',
        credentialId: 'AWS-SAP-12345',
      },
      {
        id: 'cert-002',
        employeeId: 'emp-001',
        name: 'Certified Kubernetes Administrator',
        issuer: 'CNCF',
        issueDate: daysAgo(180),
        expirationDate: daysFromNow(25),
        status: 'expiring_soon',
        credentialId: 'CKA-67890',
      },
    ],
    trainings: [
      {
        id: 'train-001',
        employeeId: 'emp-001',
        name: 'Advanced Terraform Patterns',
        provider: 'HashiCorp',
        completionDate: daysAgo(90),
        duration: '40 hours',
        description: 'Deep dive into Terraform modules, workspaces, and best practices.',
      },
    ],
    projects: [
      {
        id: 'proj-001',
        employeeId: 'emp-001',
        name: 'Cloud Migration Initiative',
        client: 'Global Bank Corp',
        startDate: daysAgo(180),
        endDate: daysAgo(30),
        technologies: ['AWS', 'Terraform', 'Docker', 'Kubernetes'],
        description: 'Led the migration of legacy infrastructure to AWS cloud, reducing operational costs by 40%.',
        role: 'Lead Cloud Architect',
      },
    ],
    education: [
      {
        id: 'edu-001',
        institution: 'MIT',
        degree: 'Master of Science',
        field: 'Computer Science',
        graduationYear: '2016',
      },
    ],
    cvLastUpdated: daysAgo(7),
  },
  {
    id: 'emp-002',
    email: 'sarah.johnson@company.com',
    name: 'Sarah Johnson',
    role: 'employee',
    teamId: 'team-001',
    title: 'DevOps Engineer',
    yearsOfExperience: 5,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['Jenkins', 'GitLab CI', 'Docker', 'Kubernetes', 'Ansible', 'Python'],
    summary: 'DevOps specialist focused on CI/CD pipelines and infrastructure automation.',
    certifications: [
      {
        id: 'cert-003',
        employeeId: 'emp-002',
        name: 'Azure DevOps Engineer Expert',
        issuer: 'Microsoft',
        issueDate: daysAgo(400),
        expirationDate: daysAgo(35),
        status: 'expired',
        credentialId: 'AZ-400-11111',
      },
      {
        id: 'cert-004',
        employeeId: 'emp-002',
        name: 'Docker Certified Associate',
        issuer: 'Docker',
        issueDate: daysAgo(200),
        expirationDate: daysFromNow(165),
        status: 'active',
        credentialId: 'DCA-22222',
      },
    ],
    trainings: [
      {
        id: 'train-002',
        employeeId: 'emp-002',
        name: 'GitOps Fundamentals',
        provider: 'Linux Foundation',
        completionDate: daysAgo(60),
        duration: '24 hours',
      },
    ],
    projects: [
      {
        id: 'proj-002',
        employeeId: 'emp-002',
        name: 'CI/CD Pipeline Modernization',
        client: 'TechStart Inc',
        startDate: daysAgo(120),
        technologies: ['GitLab CI', 'Docker', 'Kubernetes', 'ArgoCD'],
        description: 'Implemented GitOps-based deployment pipelines reducing deployment time by 60%.',
        role: 'DevOps Lead',
      },
    ],
    education: [
      {
        id: 'edu-002',
        institution: 'Stanford University',
        degree: 'Bachelor of Science',
        field: 'Software Engineering',
        graduationYear: '2019',
      },
    ],
    cvLastUpdated: daysAgo(14),
  },
  {
    id: 'emp-003',
    email: 'michael.chen@company.com',
    name: 'Michael Chen',
    role: 'employee',
    teamId: 'team-001',
    title: 'Full Stack Developer',
    yearsOfExperience: 6,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'GraphQL', 'AWS Lambda'],
    summary: 'Full stack developer with strong focus on modern web technologies and serverless architecture.',
    certifications: [
      {
        id: 'cert-005',
        employeeId: 'emp-003',
        name: 'AWS Developer Associate',
        issuer: 'Amazon Web Services',
        issueDate: daysAgo(300),
        expirationDate: daysFromNow(65),
        status: 'active',
        credentialId: 'AWS-DVA-33333',
      },
    ],
    trainings: [],
    projects: [
      {
        id: 'proj-003',
        employeeId: 'emp-003',
        name: 'Customer Portal Redesign',
        client: 'RetailMax',
        startDate: daysAgo(90),
        technologies: ['React', 'Node.js', 'PostgreSQL', 'AWS'],
        description: 'Built new customer-facing portal with improved UX and performance.',
        role: 'Senior Developer',
      },
    ],
    education: [
      {
        id: 'edu-003',
        institution: 'UC Berkeley',
        degree: 'Bachelor of Science',
        field: 'Computer Science',
        graduationYear: '2018',
      },
    ],
    cvLastUpdated: daysAgo(30),
  },
  {
    id: 'emp-004',
    email: 'emily.davis@company.com',
    name: 'Emily Davis',
    role: 'employee',
    teamId: 'team-002',
    title: 'Data Engineer',
    yearsOfExperience: 4,
    department: 'Data & Analytics',
    avatar: '',
    skills: ['Python', 'Spark', 'Airflow', 'Snowflake', 'dbt', 'SQL'],
    summary: 'Data engineer specializing in building scalable data pipelines and ETL processes.',
    certifications: [
      {
        id: 'cert-006',
        employeeId: 'emp-004',
        name: 'Databricks Certified Data Engineer',
        issuer: 'Databricks',
        issueDate: daysAgo(150),
        expirationDate: daysFromNow(215),
        status: 'active',
        credentialId: 'DB-DE-44444',
      },
      {
        id: 'cert-007',
        employeeId: 'emp-004',
        name: 'Google Cloud Professional Data Engineer',
        issuer: 'Google Cloud',
        issueDate: daysAgo(500),
        expirationDate: daysFromNow(10),
        status: 'expiring_soon',
        credentialId: 'GCP-DE-55555',
      },
    ],
    trainings: [
      {
        id: 'train-003',
        employeeId: 'emp-004',
        name: 'dbt Fundamentals',
        provider: 'dbt Labs',
        completionDate: daysAgo(45),
        duration: '16 hours',
      },
    ],
    projects: [
      {
        id: 'proj-004',
        employeeId: 'emp-004',
        name: 'Data Lake Implementation',
        client: 'HealthCare Plus',
        startDate: daysAgo(200),
        endDate: daysAgo(60),
        technologies: ['Spark', 'Delta Lake', 'Airflow', 'Python'],
        description: 'Designed and implemented enterprise data lake architecture.',
        role: 'Data Engineer',
      },
    ],
    education: [
      {
        id: 'edu-004',
        institution: 'Carnegie Mellon',
        degree: 'Master of Science',
        field: 'Data Science',
        graduationYear: '2020',
      },
    ],
    cvLastUpdated: daysAgo(21),
  },
  {
    id: 'emp-005',
    email: 'david.wilson@company.com',
    name: 'David Wilson',
    role: 'employee',
    teamId: 'team-002',
    title: 'Machine Learning Engineer',
    yearsOfExperience: 7,
    department: 'Data & Analytics',
    avatar: '',
    skills: ['Python', 'TensorFlow', 'PyTorch', 'MLOps', 'Kubernetes', 'AWS SageMaker'],
    summary: 'ML engineer with extensive experience in production ML systems and MLOps practices.',
    certifications: [
      {
        id: 'cert-008',
        employeeId: 'emp-005',
        name: 'AWS Machine Learning Specialty',
        issuer: 'Amazon Web Services',
        issueDate: daysAgo(100),
        expirationDate: daysFromNow(265),
        status: 'active',
        credentialId: 'AWS-MLS-66666',
      },
      {
        id: 'cert-009',
        employeeId: 'emp-005',
        name: 'TensorFlow Developer Certificate',
        issuer: 'Google',
        issueDate: daysAgo(200),
        expirationDate: daysFromNow(165),
        status: 'active',
        credentialId: 'TF-DEV-77777',
      },
    ],
    trainings: [],
    projects: [
      {
        id: 'proj-005',
        employeeId: 'emp-005',
        name: 'Fraud Detection System',
        client: 'FinanceFirst',
        startDate: daysAgo(150),
        technologies: ['Python', 'TensorFlow', 'Kubernetes', 'Kafka'],
        description: 'Built real-time fraud detection ML pipeline processing 1M+ transactions daily.',
        role: 'ML Lead',
      },
    ],
    education: [
      {
        id: 'edu-005',
        institution: 'Georgia Tech',
        degree: 'PhD',
        field: 'Machine Learning',
        graduationYear: '2017',
      },
    ],
    cvLastUpdated: daysAgo(5),
  },
  {
    id: 'emp-006',
    email: 'lisa.martinez@company.com',
    name: 'Lisa Martinez',
    role: 'employee',
    teamId: 'team-003',
    title: 'Security Engineer',
    yearsOfExperience: 9,
    department: 'Security',
    avatar: '',
    skills: ['SIEM', 'Penetration Testing', 'AWS Security', 'Compliance', 'Python', 'Splunk'],
    summary: 'Cybersecurity expert with focus on cloud security and compliance frameworks.',
    certifications: [
      {
        id: 'cert-010',
        employeeId: 'emp-006',
        name: 'CISSP',
        issuer: 'ISC²',
        issueDate: daysAgo(400),
        expirationDate: daysFromNow(330),
        status: 'active',
        credentialId: 'CISSP-88888',
      },
      {
        id: 'cert-011',
        employeeId: 'emp-006',
        name: 'AWS Security Specialty',
        issuer: 'Amazon Web Services',
        issueDate: daysAgo(250),
        expirationDate: daysFromNow(115),
        status: 'active',
        credentialId: 'AWS-SCS-99999',
      },
    ],
    trainings: [
      {
        id: 'train-004',
        employeeId: 'emp-006',
        name: 'Advanced Threat Hunting',
        provider: 'SANS Institute',
        completionDate: daysAgo(30),
        duration: '40 hours',
      },
    ],
    projects: [
      {
        id: 'proj-006',
        employeeId: 'emp-006',
        name: 'Zero Trust Implementation',
        client: 'Internal',
        startDate: daysAgo(180),
        endDate: daysAgo(30),
        technologies: ['Okta', 'AWS IAM', 'Splunk', 'Terraform'],
        description: 'Led zero trust security model implementation across cloud infrastructure.',
        role: 'Security Lead',
      },
    ],
    education: [
      {
        id: 'edu-006',
        institution: 'NYU',
        degree: 'Master of Science',
        field: 'Cybersecurity',
        graduationYear: '2015',
      },
    ],
    cvLastUpdated: daysAgo(10),
  },
  // Additional employees for variety
  {
    id: 'emp-007',
    email: 'james.brown@company.com',
    name: 'James Brown',
    role: 'employee',
    teamId: 'team-001',
    title: 'Site Reliability Engineer',
    yearsOfExperience: 5,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['Go', 'Prometheus', 'Grafana', 'Kubernetes', 'Terraform', 'Python'],
    summary: 'SRE focused on observability and reliability engineering.',
    certifications: [
      {
        id: 'cert-012',
        employeeId: 'emp-007',
        name: 'Google Cloud Professional Cloud Architect',
        issuer: 'Google Cloud',
        issueDate: daysAgo(180),
        expirationDate: daysFromNow(185),
        status: 'active',
        credentialId: 'GCP-PCA-10101',
      },
    ],
    trainings: [],
    projects: [
      {
        id: 'proj-007',
        employeeId: 'emp-007',
        name: 'Observability Platform',
        client: 'Internal',
        startDate: daysAgo(100),
        technologies: ['Prometheus', 'Grafana', 'Loki', 'Tempo'],
        description: 'Built unified observability platform for all cloud services.',
        role: 'SRE Lead',
      },
    ],
    education: [],
    cvLastUpdated: daysAgo(15),
  },
  {
    id: 'emp-008',
    email: 'anna.taylor@company.com',
    name: 'Anna Taylor',
    role: 'employee',
    teamId: 'team-002',
    title: 'Business Intelligence Analyst',
    yearsOfExperience: 3,
    department: 'Data & Analytics',
    avatar: '',
    skills: ['Tableau', 'Power BI', 'SQL', 'Python', 'Looker'],
    summary: 'BI analyst creating actionable insights from complex data.',
    certifications: [
      {
        id: 'cert-013',
        employeeId: 'emp-008',
        name: 'Tableau Desktop Specialist',
        issuer: 'Tableau',
        issueDate: daysAgo(100),
        expirationDate: daysFromNow(265),
        status: 'active',
        credentialId: 'TAB-DS-20202',
      },
    ],
    trainings: [],
    projects: [],
    education: [],
    cvLastUpdated: daysAgo(45),
  },
  {
    id: 'emp-009',
    email: 'robert.lee@company.com',
    name: 'Robert Lee',
    role: 'employee',
    teamId: 'team-003',
    title: 'Network Security Specialist',
    yearsOfExperience: 6,
    department: 'Security',
    avatar: '',
    skills: ['Firewalls', 'VPN', 'Network Monitoring', 'Wireshark', 'Cisco'],
    summary: 'Network security specialist with expertise in enterprise network protection.',
    certifications: [
      {
        id: 'cert-014',
        employeeId: 'emp-009',
        name: 'Cisco CCNP Security',
        issuer: 'Cisco',
        issueDate: daysAgo(600),
        expirationDate: daysAgo(60),
        status: 'expired',
        credentialId: 'CCNP-SEC-30303',
      },
    ],
    trainings: [],
    projects: [],
    education: [],
    cvLastUpdated: daysAgo(60),
  },
  {
    id: 'emp-010',
    email: 'jennifer.white@company.com',
    name: 'Jennifer White',
    role: 'employee',
    teamId: 'team-001',
    title: 'Cloud Solutions Engineer',
    yearsOfExperience: 4,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['AWS', 'Azure', 'CloudFormation', 'ARM Templates', 'Python'],
    summary: 'Multi-cloud specialist helping clients navigate cloud adoption.',
    certifications: [
      {
        id: 'cert-015',
        employeeId: 'emp-010',
        name: 'Azure Solutions Architect Expert',
        issuer: 'Microsoft',
        issueDate: daysAgo(200),
        expirationDate: daysFromNow(165),
        status: 'active',
        credentialId: 'AZ-305-40404',
      },
      {
        id: 'cert-016',
        employeeId: 'emp-010',
        name: 'AWS Solutions Architect Associate',
        issuer: 'Amazon Web Services',
        issueDate: daysAgo(350),
        expirationDate: daysFromNow(15),
        status: 'expiring_soon',
        credentialId: 'AWS-SAA-50505',
      },
    ],
    trainings: [],
    projects: [],
    education: [],
    cvLastUpdated: daysAgo(25),
  },
];

// Mock Teams
export const mockTeams: Team[] = [
  {
    id: 'team-001',
    name: 'Cloud Engineering',
    managerId: 'mgr-001',
    memberIds: ['emp-001', 'emp-002', 'emp-003', 'emp-007', 'emp-010'],
  },
  {
    id: 'team-002',
    name: 'Data & Analytics',
    managerId: 'mgr-002',
    memberIds: ['emp-004', 'emp-005', 'emp-008'],
  },
  {
    id: 'team-003',
    name: 'Security',
    managerId: 'mgr-003',
    memberIds: ['emp-006', 'emp-009'],
  },
];

// Mock Managers
export const mockManagers: Employee[] = [
  {
    id: 'mgr-001',
    email: 'mark.anderson@company.com',
    name: 'Mark Anderson',
    role: 'manager',
    teamId: 'team-001',
    title: 'Cloud Engineering Manager',
    yearsOfExperience: 12,
    department: 'Cloud Engineering',
    avatar: '',
    skills: ['Leadership', 'AWS', 'Azure', 'Strategic Planning'],
    summary: 'Engineering leader with 12+ years of experience in cloud technologies.',
    certifications: [],
    trainings: [],
    projects: [],
    education: [],
  },
  {
    id: 'mgr-002',
    email: 'patricia.garcia@company.com',
    name: 'Patricia Garcia',
    role: 'manager',
    teamId: 'team-002',
    title: 'Data & Analytics Manager',
    yearsOfExperience: 10,
    department: 'Data & Analytics',
    avatar: '',
    skills: ['Leadership', 'Data Strategy', 'Analytics', 'Machine Learning'],
    summary: 'Data leader driving analytics transformation.',
    certifications: [],
    trainings: [],
    projects: [],
    education: [],
  },
];

// Mock BID Manager
export const mockBidManager: Employee = {
  id: 'bid-001',
  email: 'alex.thompson@company.com',
  name: 'Alex Thompson',
  role: 'bid_manager',
  title: 'BID Manager',
  yearsOfExperience: 15,
  department: 'Business Development',
  avatar: '',
  skills: ['Proposal Writing', 'Strategy', 'Client Relations', 'Resource Planning'],
  summary: 'Experienced bid manager leading strategic proposals.',
  certifications: [],
  trainings: [],
  projects: [],
  education: [],
};

// Mock Notifications
export const mockNotifications: Notification[] = [
  {
    id: 'notif-001',
    userId: 'emp-001',
    title: 'Certification Expiring Soon',
    message: 'Your Certified Kubernetes Administrator certification expires in 25 days.',
    type: 'warning',
    read: false,
    createdAt: daysAgo(1),
  },
  {
    id: 'notif-002',
    userId: 'emp-002',
    title: 'Certification Expired',
    message: 'Your Azure DevOps Engineer Expert certification has expired.',
    type: 'error',
    read: false,
    createdAt: daysAgo(35),
  },
  {
    id: 'notif-003',
    userId: 'emp-001',
    title: 'CV Updated',
    message: 'Your CV has been successfully updated and is ready for review.',
    type: 'success',
    read: true,
    createdAt: daysAgo(7),
  },
];

// Helper functions
export const getCertificationStats = (employees: Employee[]): CertificationStats => {
  let active = 0;
  let expiringSoon = 0;
  let expired = 0;

  employees.forEach((emp) => {
    emp.certifications.forEach((cert) => {
      if (cert.status === 'active') active++;
      else if (cert.status === 'expiring_soon') expiringSoon++;
      else if (cert.status === 'expired') expired++;
    });
  });

  return { active, expiringSoon, expired, total: active + expiringSoon + expired };
};

export const getDashboardStats = (): DashboardStats => {
  const allEmployees = mockEmployees;
  const stats = getCertificationStats(allEmployees);

  return {
    totalEmployees: allEmployees.length,
    totalCertifications: stats.total,
    certificationsByStatus: stats,
    totalTeams: mockTeams.length,
    expiringThisMonth: stats.expiringSoon,
  };
};

export const getEmployeeById = (id: string): Employee | undefined => {
  return [...mockEmployees, ...mockManagers, mockBidManager].find((emp) => emp.id === id);
};

export const getTeamMembers = (teamId: string): Employee[] => {
  const team = mockTeams.find((t) => t.id === teamId);
  if (!team) return [];
  return mockEmployees.filter((emp) => team.memberIds.includes(emp.id));
};

export const searchEmployees = (query: string): Employee[] => {
  const lowerQuery = query.toLowerCase();
  return mockEmployees.filter((emp) => {
    const matchName = emp.name.toLowerCase().includes(lowerQuery);
    const matchSkills = emp.skills.some((skill) => skill.toLowerCase().includes(lowerQuery));
    const matchCerts = emp.certifications.some((cert) => cert.name.toLowerCase().includes(lowerQuery));
    const matchTitle = emp.title.toLowerCase().includes(lowerQuery);
    return matchName || matchSkills || matchCerts || matchTitle;
  });
};

// Simulated AI responses
export const mockAIResponses: Record<string, string> = {
  'aws': 'I found 4 employees with AWS certifications. Here are the top matches based on your criteria.',
  'kubernetes': 'I found 2 employees with Kubernetes experience. John Smith has the CKA certification.',
  'java': 'I found 1 employee with Java skills. Michael Chen is available for bid assignments.',
  'default': 'Based on your query, I found several matching profiles. Here are the results.',
};
