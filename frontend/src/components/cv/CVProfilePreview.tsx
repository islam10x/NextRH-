import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CvProfile } from '@/types';
import {
  FileText,
  Award,
  Briefcase,
  GraduationCap,
  Code,
  CalendarDays,
  Building2,
  Phone,
  MapPin,
  Mail,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

const fmtDate = (d: string | null) => {
  if (!d) return null;
  try {
    return format(parseISO(d), 'MMM yyyy');
  } catch {
    return d;
  }
};

const formatDateRange = (startDate: string | null | undefined, endDate: string | null | undefined): string | null => {
  const start = fmtDate(startDate ?? null);
  const end = fmtDate(endDate ?? null);

  if (start && end) return `${start} - ${end}`;
  if (start) return start;
  return null;
};

interface CVProfilePreviewProps {
  profile: CvProfile;
  className?: string;
}

export const CVProfilePreview: React.FC<CVProfilePreviewProps> = ({ profile, className }) => {
  return (
    <Card className={cn("max-w-4xl mx-auto shadow-lg print:shadow-none border-t-4 border-t-primary", className)}>
      <CardContent className="cv-document p-8 space-y-8" style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        lineHeight: '1.6',
        color: '#1a1a1a'
      }}>

        {/* Header */}
        <div className="print-header text-center pb-6 border-b">
          <h1 className="text-3xl font-bold text-foreground mb-1">{profile.name}</h1>
          {profile.currentPosition && (
            <p className="position text-xl text-primary font-medium mb-3">{profile.currentPosition}</p>
          )}
          <div className="contact-info flex flex-wrap items-center justify-center gap-4 text-base text-muted-foreground">
            <span className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              {profile.email}
            </span>
            {profile.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="h-4 w-4" />
                {profile.phone}
              </span>
            )}
            {profile.totalExperienceYears != null && (
              <span className="flex items-center gap-1.5">
                <Briefcase className="h-4 w-4" />
                {profile.totalExperienceYears} year{profile.totalExperienceYears !== 1 ? 's' : ''} of experience
              </span>
            )}
          </div>
          {profile.address && (
            <p className="mt-3 text-base text-muted-foreground flex items-center justify-center gap-2">
              <MapPin className="h-5 w-5 shrink-0" />
              {profile.address}
            </p>
          )}
        </div>

        {/* Summary */}
        {profile.professionalSummary && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-3">
              <FileText className="h-5 w-5 text-primary" />
              Professional Summary
            </h2>
            <p className="text-base text-muted-foreground leading-relaxed italic border-l-2 border-muted pl-4">
              {profile.professionalSummary}
            </p>
          </section>
        )}

        {/* Skills */}
        {profile.skills.length > 0 && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-3">
              <Code className="h-5 w-5 text-primary" />
              Technical Skills
            </h2>
            <div className="skills-container flex flex-wrap gap-2">
              {profile.skills.map((s) => (
                <Badge key={s} variant="secondary" className="px-4 py-1.5 text-base font-medium">{s}</Badge>
              ))}
            </div>
          </section>
        )}

        {/* Work Experience */}
        {profile.workExperiences.length > 0 && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-4">
              <Building2 className="h-5 w-5 text-primary" />
              Work Experience
            </h2>
            <div className="space-y-6">
              {profile.workExperiences.map((exp) => (
                <div key={exp.id} className="experience-item border-l-2 border-primary/20 pl-4 py-1">
                  <div className="item-header flex flex-col md:flex-row md:items-start md:justify-between gap-1">
                    <div>
                      <h3 className="item-title font-semibold text-foreground">{exp.jobTitle}</h3>
                      <p className="item-company text-sm text-primary font-medium">{exp.companyName}</p>
                    </div>
                    {formatDateRange(exp.startDate, exp.endDate) && (
                      <span className="item-date text-sm text-muted-foreground flex items-center gap-1.5 shrink-0 bg-muted/50 px-3 py-1.5 rounded">
                        <CalendarDays className="h-4 w-4" />
                        {formatDateRange(exp.startDate, exp.endDate)}
                      </span>
                    )}
                  </div>
                  {exp.description && (
                    <p className="mt-3 text-base text-muted-foreground whitespace-pre-line leading-relaxed">{exp.description}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Projects */}
        {profile.projects.length > 0 && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-4">
              <Briefcase className="h-5 w-5 text-primary" />
              Project Experience
            </h2>
            <div className="space-y-6">
              {profile.projects.map((p) => (
                <ProjectItem key={p.id} project={p} />
              ))}
            </div>
          </section>
        )}

        {/* Certifications */}
        {profile.certifications.length > 0 && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-4">
              <Award className="h-5 w-5 text-primary" />
              Certifications
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {profile.certifications.map((cert) => (
                <div key={cert.id} className="cert-item border border-muted-foreground/10 bg-muted/5 rounded-lg p-3">
                  <h3 className="cert-name font-semibold text-sm text-foreground mb-1 leading-tight">{cert.name}</h3>
                  {cert.issuingOrganization && (
                    <p className="cert-org text-xs text-primary font-medium mb-2">{cert.issuingOrganization}</p>
                  )}
                  <div className="cert-dates flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {cert.issueDate && <span>Issued: {fmtDate(cert.issueDate)}</span>}
                    {cert.expirationDate && <span>Expires: {fmtDate(cert.expirationDate)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Education */}
        {profile.educations.length > 0 && (
          <section className="section">
            <h2 className="section-title text-lg font-semibold flex items-center gap-2 mb-4">
              <GraduationCap className="h-5 w-5 text-primary" />
              Education
            </h2>
            <div className="space-y-4">
              {profile.educations.map((edu) => (
                <div key={edu.id} className="education-item flex flex-col md:flex-row md:justify-between border-b border-muted pb-3 last:border-0 bubble">
                  <div>
                    <h3 className="font-semibold text-sm text-foreground">
                      {edu.degree}{edu.fieldOfStudy ? ` in ${edu.fieldOfStudy}` : ''}
                    </h3>
                    {edu.institution && (
                      <p className="text-xs text-primary font-medium">{edu.institution}</p>
                    )}
                  </div>
                  {edu.endDate && (
                    <p className="text-xs bg-muted px-3 py-1 rounded self-start mt-1 md:mt-0">
                      Graduated: {fmtDate(edu.endDate)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

      </CardContent>
    </Card>
  );
};

const ProjectItem: React.FC<{ project: CvProfile['projects'][0] }> = ({
  project,
}) => {
  const hasInvalidName = !project.name || project.name.toLowerCase() === 'unknown project';

  let displayTitle: string;
  if (!hasInvalidName) {
    displayTitle = project.name;
  } else if (project.generatedTitle) {
    displayTitle = project.generatedTitle;
  } else {
    const words = (project.description ?? '').trim().split(/\s+/);
    displayTitle = words.slice(0, 8).join(' ') + (words.length > 8 ? '...' : '') || 'Untitled Project';
  }

  return (
    <div className="border-l-2 border-primary/20 pl-4 py-1">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-1">
        <div className="flex-1">
          <h3 className="font-semibold text-sm text-foreground">{displayTitle}</h3>
          <div className="flex gap-2 text-xs">
            {project.role && <span className="text-primary font-medium">{project.role}</span>}
            {project.client && <span className="text-muted-foreground">• {project.client}</span>}
          </div>
        </div>
        {formatDateRange(project.startDate, project.endDate) && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5 shrink-0 bg-muted px-3 py-1 rounded">
            <CalendarDays className="h-4 w-4" />
            {formatDateRange(project.startDate, project.endDate)}
          </span>
        )}
      </div>
      {project.description && (
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{project.description}</p>
      )}
      {project.skills.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {project.skills.map((s) => (
            <Badge key={s} variant="outline" className="text-xs px-2 py-0.5 border-primary/20 text-primary/70">{s}</Badge>
          ))}
        </div>
      )}
    </div>
  );
};
