import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import api from '@/services/api';
import { CvProfile } from '@/types';
import {
  FileText,
  Download,
  Printer,
  Mail,
  Award,
  Briefcase,
  GraduationCap,
  Code,
  Loader2,
  CalendarDays,
  Building2,
  Phone,
  MapPin,
  FileUp,
  Copy,
  Check,
  ChevronLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { useNavigate, useParams } from 'react-router-dom';
import jsPDF from 'jspdf';

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

const CVPreviewPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { employeeId, memberId } = useParams<{ employeeId?: string; memberId?: string }>();
  const targetUserId = employeeId || memberId;
  const [profile, setProfile] = useState<CvProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!user) {
        setLoading(false);
        return;
      }
      try {
        const url = targetUserId ? `/cv/profile/${targetUserId}` : '/cv/profile/me';
        const response = await api.get<CvProfile>(url);
        setProfile(response.data);
      } catch (err) {
        setError('Impossible de charger le profil CV. Veuillez réessayer.');
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, [user, targetUserId]);

  const handleDownloadPDF = async () => {
    try {
      if (!profile) return;

      // Show loading state
      const button = document.querySelector('button:has(.lucide-download)') as HTMLButtonElement;
      if (button) {
        button.disabled = true;
        button.textContent = 'Génération du PDF...';
      }

      // Create PDF document
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentWidth = pageWidth - (2 * margin);
      let yPosition = margin;

      // Helper function to add new page if needed
      const checkPageBreak = (additionalHeight: number = 10) => {
        if (yPosition + additionalHeight > pageHeight - margin) {
          pdf.addPage();
          yPosition = margin;
          return true;
        }
        return false;
      };

      // Helper function to add text with word wrapping
      const addText = (text: string, x: number, y: number, options?: any) => {
        const lines = pdf.splitTextToSize(text, contentWidth - (x - margin));
        pdf.text(lines, x, y, options);
        return lines.length * (options?.lineHeight || 6);
      };

      // Header Section
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(24);
      pdf.setTextColor(31, 41, 55); // Dark gray
      pdf.text(profile.name, margin, yPosition);
      yPosition += 12;

      if (profile.currentPosition) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(16);
        pdf.setTextColor(59, 130, 246); // Blue
        pdf.text(profile.currentPosition, margin, yPosition);
        yPosition += 8;
      }

      // Contact info
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      pdf.setTextColor(107, 114, 128); // Gray
      const contactParts: string[] = [profile.email];
      if (profile.phone) contactParts.push(profile.phone);
      if (profile.totalExperienceYears != null) {
        contactParts.push(`${profile.totalExperienceYears} ans d'expérience`);
      }
      pdf.text(contactParts.join(' • '), margin, yPosition);
      yPosition += 7;

      // Address
      if (profile.address) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.setTextColor(107, 114, 128);
        const addressHeight = addText(profile.address, margin, yPosition);
        yPosition += addressHeight + 8;
      } else {
        yPosition += 8;
      }

      // Add line separator
      pdf.setLineWidth(0.5);
      pdf.setDrawColor(229, 231, 235);
      pdf.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 10;

      // Professional Summary
      if (profile.professionalSummary) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('RÉSUMÉ PROFESSIONNEL', margin, yPosition);
        yPosition += 8;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11);
        pdf.setTextColor(75, 85, 99);
        const summaryHeight = addText(profile.professionalSummary, margin, yPosition);
        yPosition += summaryHeight + 10;
      }

      // Skills Section
      if (profile.skills.length > 0) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('COMPÉTENCES TECHNIQUES', margin, yPosition);
        yPosition += 8;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11);
        pdf.setTextColor(75, 85, 99);
        const skillsText = profile.skills.join(' • ');
        const skillsHeight = addText(skillsText, margin, yPosition);
        yPosition += skillsHeight + 10;
      }

      // Work Experience
      if (profile.workExperiences.length > 0) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('EXPÉRIENCE PROFESSIONNELLE', margin, yPosition);
        yPosition += 8;

        profile.workExperiences.forEach((exp, index) => {
          if (index > 0) checkPageBreak(25);

          // Job title and company
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(12);
          pdf.setTextColor(31, 41, 55);
          pdf.text(exp.jobTitle, margin, yPosition);

          // Date range (right aligned)
          const dateText = formatDateRange(exp.startDate, exp.endDate);
          if (dateText) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(107, 114, 128);
            const dateWidth = pdf.getTextWidth(dateText);
            pdf.text(dateText, pageWidth - margin - dateWidth, yPosition);
          }
          yPosition += 6;

          // Company name
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(11);
          pdf.setTextColor(59, 130, 246);
          const companyHeight = addText(exp.companyName, margin, yPosition);
          yPosition += companyHeight + 2;

          // Description
          if (exp.description) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(75, 85, 99);
            const descHeight = addText(exp.description, margin, yPosition);
            yPosition += descHeight + 8;
          } else {
            yPosition += 8;
          }
        });
      }

      // Projects Section
      if (profile.projects.length > 0) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('EXPÉRIENCE PROJETS', margin, yPosition);
        yPosition += 8;

        profile.projects.forEach((project, index) => {
          if (index > 0) checkPageBreak(25);

          // Project title
          const hasInvalidName = !project.name || project.name.toLowerCase() === 'unknown project';
          let displayTitle: string;
          if (!hasInvalidName) {
            displayTitle = project.name;
          } else if (project.generatedTitle) {
            displayTitle = project.generatedTitle;
          } else {
            const words = (project.description ?? '').trim().split(/\s+/);
            displayTitle = words.slice(0, 8).join(' ') + (words.length > 8 ? '...' : '') || 'Projet sans titre';
          }

          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(12);
          pdf.setTextColor(31, 41, 55);
          const titleHeight = addText(displayTitle, margin, yPosition);

          // Project date range (right aligned)
          const projectDateText = formatDateRange(project.startDate, project.endDate);
          if (projectDateText) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(107, 114, 128);
            const projectDateWidth = pdf.getTextWidth(projectDateText);
            pdf.text(projectDateText, pageWidth - margin - projectDateWidth, yPosition);
          }

          yPosition += titleHeight + 2;

          // Role and client
          if (project.role || project.client) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(11);
            pdf.setTextColor(59, 130, 246);
            const roleText = [project.role, project.client].filter(Boolean).join(' • ');
            const roleHeight = addText(roleText, margin, yPosition);
            yPosition += roleHeight + 2;
          }

          // Description
          if (project.description) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(75, 85, 99);
            const descHeight = addText(project.description, margin, yPosition);
            yPosition += descHeight + 4;
          }

          // Skills
          if (project.skills.length > 0) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9);
            pdf.setTextColor(107, 114, 128);
            const skillsText = 'Technologies : ' + project.skills.join(', ');
            const skillsHeight = addText(skillsText, margin, yPosition);
            yPosition += skillsHeight + 8;
          } else {
            yPosition += 8;
          }
        });
      }

      // Certifications Section
      if (profile.certifications.length > 0) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('CERTIFICATIONS', margin, yPosition);
        yPosition += 8;

        profile.certifications.forEach((cert, index) => {
          if (index > 0) checkPageBreak(15);

          // Certificate name
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(11);
          pdf.setTextColor(31, 41, 55);
          const certNameHeight = addText(cert.name, margin, yPosition);
          yPosition += certNameHeight + 1;

          // Organization and dates
          const certDetails = [];
          if (cert.issuingOrganization) certDetails.push(cert.issuingOrganization);
          if (cert.issueDate) certDetails.push(`Émis : ${fmtDate(cert.issueDate)}`);
          if (cert.expirationDate) certDetails.push(`Expire : ${fmtDate(cert.expirationDate)}`);

          if (certDetails.length > 0) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(75, 85, 99);
            pdf.text(certDetails.join(' • '), margin, yPosition);
            yPosition += 5;
          }

          // Status
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          const statusColor = cert.status === 'active' ? [34, 197, 94] : cert.status === 'expiring_soon' ? [251, 191, 36] : [239, 68, 68];
          pdf.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
          pdf.text(`Statut : ${cert.status.replace('_', ' ').toUpperCase()}`, margin, yPosition);
          yPosition += 10;
        });
      }

      // Education Section
      if (profile.educations.length > 0) {
        checkPageBreak(20);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.setTextColor(31, 41, 55);
        pdf.text('FORMATION', margin, yPosition);
        yPosition += 8;

        profile.educations.forEach((edu, index) => {
          if (index > 0) checkPageBreak(15);

          // Degree
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(11);
          pdf.setTextColor(31, 41, 55);
          const degreeText = edu.degree + (edu.fieldOfStudy ? ` - ${edu.fieldOfStudy}` : '');
          const degreeHeight = addText(degreeText, margin, yPosition);
          yPosition += degreeHeight + 1;

          // Institution and graduation date
          const eduDetails = [];
          if (edu.institution) eduDetails.push(edu.institution);
          if (edu.endDate) eduDetails.push(`Diplômé : ${fmtDate(edu.endDate)}`);

          if (eduDetails.length > 0) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(75, 85, 99);
            pdf.text(eduDetails.join(' • '), margin, yPosition);
            yPosition += 10;
          }
        });
      }

      // Generate filename and save
      const filename = `${profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_Resume.pdf`;
      pdf.save(filename);

      // Reset button state
      if (button) {
        button.disabled = false;
        button.innerHTML = '<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v10a2 2 0 01-2-2z"></path></svg>Télécharger le PDF';
      }

    } catch (error) {
      console.error('Error generating PDF:', error);

      // Reset button state on error
      const button = document.querySelector('button:has(.lucide-download)') as HTMLButtonElement;
      if (button) {
        button.disabled = false;
        button.innerHTML = '<svg class="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v10a2 2 0 01-2-2z"></path></svg>Télécharger le PDF';
      }

      alert('Échec de la génération du PDF. Veuillez réessayer.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isEmpty =
    !profile ||
    (profile.workExperiences.length === 0 &&
      profile.educations.length === 0 &&
      profile.certifications.length === 0 &&
      profile.projects.length === 0 &&
      profile.skills.length === 0 &&
      !profile.professionalSummary);

  const isManagerView = Boolean(targetUserId);
  const managerErrorTitle = 'Impossible de charger ce profil CV.';
  const managerErrorBody = 'Veuillez actualiser la page et réessayer.';
  const managerEmptyTitle = 'Cet employé n\'a pas encore importé de CV.';
  const managerEmptyBody = 'Demandez-lui d\'importer son CV pour afficher le profil.';
  const employeeErrorTitle = 'Impossible de charger le profil CV. Veuillez réessayer.';
  const employeeErrorBody = 'Veuillez actualiser la page ou réimporter votre CV.';
  const employeeEmptyTitle = 'Vous n\'avez pas encore importé de CV.';
  const employeeEmptyBody = 'Importez votre CV pour générer votre profil ici.';

  if (error || isEmpty) {
    const title = error
      ? (isManagerView ? managerErrorTitle : employeeErrorTitle)
      : (isManagerView ? managerEmptyTitle : employeeEmptyTitle);
    const body = error
      ? (isManagerView ? managerErrorBody : employeeErrorBody)
      : (isManagerView ? managerEmptyBody : employeeEmptyBody);

    return (
      <Card>
        <CardContent className="py-16 text-center space-y-4">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/50" />
          <h3 className="font-medium text-lg">
            {title}
          </h3>
          <p className="text-muted-foreground text-base">
            {body}
          </p>
          {!error && !targetUserId && (
            <Button size="sm" onClick={() => navigate('/employee/cv-upload')}>
              Importer le CV
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const backPath = user?.role === 'bid_manager' ? '/bid/directory' : '/manager/team';

  return (
    <div className="space-y-6">
      {targetUserId && (
        <Button variant="ghost" size="sm" className="gap-1 -ml-2 text-muted-foreground" onClick={() => navigate(backPath)}>
          <ChevronLeft className="h-4 w-4" />
          Retour
        </Button>
      )}
      {/* Page header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Aperçu du CV</h1>
          <div className="flex flex-wrap items-center gap-4 text-muted-foreground text-sm mt-2">
            {profile.lastUpdate && (
              <span>Dernière mise à jour : {fmtDate(profile.lastUpdate)}</span>
            )}
            {profile.cvFilename && (
              <span className="flex items-center gap-2">
                <FileUp className="h-4 w-4" />
                {profile.cvFilename}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4 mr-2" />
            Imprimer
          </Button>
          <Button size="sm" onClick={handleDownloadPDF}>
            <Download className="h-4 w-4 mr-2" />
            Télécharger le PDF
          </Button>
        </div>
      </div>

      {/* CV Document */}
      <Card className="max-w-4xl mx-auto shadow-lg print:shadow-none">
        <CardContent className="cv-document p-8 space-y-8" style={{
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          lineHeight: '1.6',
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
                <button
                  type="button"
                  className="no-print ml-1 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    navigator.clipboard.writeText(profile.email).then(() => {
                      setCopiedEmail(true);
                      toast.success('Email copié');
                      setTimeout(() => setCopiedEmail(false), 2000);
                    });
                  }}
                  aria-label="Copier l'email"
                >
                  {copiedEmail ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </button>
              </span>
              {profile.phone && (
                <span className="flex items-center gap-2">
                  <Phone className="h-5 w-5" />
                  {profile.phone}
                </span>
              )}
              {profile.totalExperienceYears != null && (
                <span className="flex items-center gap-2">
                  <Briefcase className="h-5 w-5" />
                  {profile.totalExperienceYears} an{profile.totalExperienceYears !== 1 ? 's' : ''} d'expérience
                </span>
              )}
            </div>
            {profile.address && (
              <p className="mt-2 text-sm text-muted-foreground flex items-center justify-center gap-1.5">
                <MapPin className="h-4 w-4 shrink-0" />
                {profile.address}
              </p>
            )}
          </div>

          {/* â€”â€” Summary â€”â€” */}
          {profile.professionalSummary && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-3">
                <FileText className="h-5 w-5 text-primary" />
                Résumé professionnel
              </h2>
              <p className="text-muted-foreground leading-relaxed">{profile.professionalSummary}</p>
            </section>
          )}

          {/* â€”â€” Skills â€”â€” */}
          {profile.skills.length > 0 && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-3">
                <Code className="h-5 w-5 text-primary" />
                Compétences techniques
              </h2>
              <div className="skills-container flex flex-wrap gap-2">
                {profile.skills.map((s) => (
                  <Badge key={s} variant="secondary" className="skill-badge">{s}</Badge>
                ))}
              </div>
            </section>
          )}

          {/* â€”â€” Work Experience â€”â€” */}
          {profile.workExperiences.length > 0 && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-4">
                <Building2 className="h-5 w-5 text-primary" />
                Expérience professionnelle
              </h2>
              <div className="space-y-6">
                {profile.workExperiences.map((exp) => (
                  <div key={exp.id} className="experience-item border-l-2 border-primary/30 pl-4">
                    <div className="item-header flex flex-col md:flex-row md:items-start md:justify-between gap-1">
                      <div>
                        <h3 className="item-title font-semibold text-foreground">{exp.jobTitle}</h3>
                        <p className="item-company text-sm text-primary">{exp.companyName}</p>
                      </div>
                      {formatDateRange(exp.startDate, exp.endDate) && (
                        <span className="item-date text-sm text-muted-foreground flex items-center gap-1.5 shrink-0">
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

          {/* â€”â€” Projects â€”â€” */}
          {profile.projects.length > 0 && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-4">
                <Briefcase className="h-5 w-5 text-primary" />
                Expérience projets
              </h2>
              <div className="space-y-6">
                {profile.projects.map((p) => (
                  <ProjectItem key={p.id} project={p} />
                ))}
              </div>
            </section>
          )}

          {/* â€”â€” Certifications â€”â€” */}
          {profile.certifications.length > 0 && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-4">
                <Award className="h-5 w-5 text-primary" />
                Certifications
              </h2>
              <div className="space-y-4">
                {profile.certifications.map((cert) => (
                  <div key={cert.id} className="cert-item border-l-4 border-primary/40 pl-4 py-2">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <h3 className="cert-name font-semibold text-base text-foreground mb-1">{cert.name}</h3>
                        {cert.issuingOrganization && (
                          <p className="cert-org text-sm text-primary font-medium mb-2">{cert.issuingOrganization}</p>
                        )}
                        <div className="cert-dates flex flex-wrap gap-4 text-base text-muted-foreground">
                          {cert.issueDate && <span>Émis : {fmtDate(cert.issueDate)}</span>}
                          {cert.expirationDate && <span>Expire : {fmtDate(cert.expirationDate)}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* â€”â€” Education â€”â€” */}
          {profile.educations.length > 0 && (
            <section className="section">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-4">
                <GraduationCap className="h-5 w-5 text-primary" />
                Formation
              </h2>
              <div className="space-y-4">
                {profile.educations.map((edu) => (
                  <div key={edu.id} className="education-item border-l-4 border-primary/40 pl-4 py-2">
                    <div>
                      <h3 className="font-semibold text-base text-foreground mb-1">
                        {edu.degree}{edu.fieldOfStudy ? ` - ${edu.fieldOfStudy}` : ''}
                      </h3>
                      {edu.institution && (
                        <p className="text-sm text-primary font-medium mb-1">{edu.institution}</p>
                      )}
                      {edu.endDate && (
                        <p className="text-base text-muted-foreground mt-1">Diplômé : {fmtDate(edu.endDate)}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

        </CardContent>
      </Card>
    </div>
  );
};

const ProjectItem: React.FC<{ project: CvProfile['projects'][0] }> = ({
  project,
}) => {
  const hasInvalidName = !project.name || project.name.toLowerCase() === 'unknown project';

  // Display order: valid name > AI-generated title > truncated description fallback
  let displayTitle: string;
  if (!hasInvalidName) {
    displayTitle = project.name;
  } else if (project.generatedTitle) {
    displayTitle = project.generatedTitle;
  } else {
    const words = (project.description ?? '').trim().split(/\s+/);
    displayTitle = words.slice(0, 8).join(' ') + (words.length > 8 ? '...' : '') || 'Projet sans titre';
  }

  return (
    <div className="border-l-2 border-primary/30 pl-4">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-1">
        <div>
          <h3 className="font-semibold text-foreground">{displayTitle}</h3>
          {project.role && <p className="text-sm text-primary">{project.role}</p>}
          {project.client && <p className="text-sm text-muted-foreground">{project.client}</p>}
        </div>
        {formatDateRange(project.startDate, project.endDate) && (
          <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatDateRange(project.startDate, project.endDate)}
          </span>
        )}
      </div>
      {project.description && (
        <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
      )}
      {project.skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {project.skills.map((s) => (
            <Badge key={s} variant="outline" className="text-xs">{s}</Badge>
          ))}
        </div>
      )}
    </div>
  );
};

export default CVPreviewPage;
