import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import api from '@/services/api';
import { CvProfile } from '@/types';
import { cvService } from '@/services/cv.service';
import { certificationService } from '@/services/certification.service';
import { projectService } from '@/services/project.service';
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
  ShieldAlert,
  Pencil,
  Plus,
  Trash2,
  X,
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
  const [editMode, setEditMode] = useState(false);
  const [addingExp, setAddingExp] = useState(false);
  const [editingExpId, setEditingExpId] = useState<string | null>(null);
  const [addingEdu, setAddingEdu] = useState(false);
  const [editingEduId, setEditingEduId] = useState<string | null>(null);
  const [uploadingCert, setUploadingCert] = useState(false);
  const certFileInputRef = useRef<HTMLInputElement>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);

  // Only the owner can edit their own CV preview — managers/BID viewing a
  // colleague's profile (targetUserId set) never get edit controls.
  const canEdit = !targetUserId;

  const fetchProfile = async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const url = targetUserId ? `/cv/profile/${targetUserId}` : '/cv/profile/me';
      const response = await api.get<CvProfile>(url);
      setProfile(response.data);
      setError(null);
    } catch (err) {
      setError('Impossible de charger le profil CV. Veuillez réessayer.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfile();
  }, [user, targetUserId]);

  const reloadProfile = async () => {
    try {
      const updated = await cvService.getMyProfile();
      setProfile(updated);
    } catch {
      toast.error('Impossible de rafraîchir le profil.');
    }
  };

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

          const projectDescription = (project.description ?? '').trim();
          const hasInvalidName = !project.name || project.name.toLowerCase() === 'unknown project';
          const fallbackTitle = !hasInvalidName
            ? project.name
            : project.generatedTitle || 'Projet sans description';
          const mainProjectText = projectDescription || fallbackTitle;

          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(12);
          pdf.setTextColor(31, 41, 55);
          const titleHeight = addText(mainProjectText, margin, yPosition);

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

          // Keep client info, but remove role from project preview/export.
          if (project.client) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(11);
            pdf.setTextColor(59, 130, 246);
            const clientHeight = addText(project.client, margin, yPosition);
            yPosition += clientHeight + 4;
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
          yPosition += 5;

          // Unverified flag — no proof uploaded yet
          if (!cert.isUploaded) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9);
            pdf.setTextColor(217, 119, 6);
            pdf.text('Non vérifiée — justificatif non fourni', margin, yPosition);
            yPosition += 5;
          }

          yPosition += 5;
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
        <div className="no-print flex gap-2">
          {canEdit && (
            <Button
              variant={editMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => setEditMode((v) => !v)}
            >
              <Pencil className="h-4 w-4 mr-2" />
              {editMode ? 'Terminer la modification' : 'Modifier le CV'}
            </Button>
          )}
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
      {editMode && (
        <div className="no-print rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
          Mode édition : corrigez les erreurs d'extraction de votre CV. Chaque modification est enregistrée immédiatement.
        </div>
      )}

      {/* CV Document */}
      <Card className="max-w-4xl mx-auto shadow-lg print:shadow-none">
        <CardContent className="cv-document p-8 space-y-8" style={{
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          lineHeight: '1.6',
        }}>

          {/* Header */}
          <div className="print-header text-center pb-6 border-b">
            <h1 className="text-3xl font-bold text-foreground mb-1">{profile.name}</h1>
            {!editMode && profile.currentPosition && (
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

          {/* â€”â€” Profile basics (edit mode) â€”â€” */}
          {editMode && (
            <section className="section no-print">
              <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2 mb-3">
                <FileText className="h-5 w-5 text-primary" />
                Informations générales
              </h2>
              <ProfileBasicsEditor profile={profile} onSaved={setProfile} />
            </section>
          )}

          {/* â€”â€” Summary â€”â€” */}
          {!editMode && profile.professionalSummary && (
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
          {(profile.workExperiences.length > 0 || editMode) && (
            <section className="section">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  Expérience professionnelle
                </h2>
                {editMode && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="no-print"
                    onClick={() => setAddingExp(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Ajouter
                  </Button>
                )}
              </div>
              <div className="space-y-6">
                {addingExp && (
                  <WorkExperienceForm
                    onCancel={() => setAddingExp(false)}
                    onSave={async (values) => {
                      const updated = await cvService.createWorkExperience(values);
                      setProfile(updated);
                      setAddingExp(false);
                      toast.success('Expérience ajoutée');
                    }}
                  />
                )}
                {profile.workExperiences.map((exp) =>
                  editingExpId === exp.id ? (
                    <WorkExperienceForm
                      key={exp.id}
                      initial={exp}
                      onCancel={() => setEditingExpId(null)}
                      onSave={async (values) => {
                        const updated = await cvService.updateWorkExperience(exp.id, values);
                        setProfile(updated);
                        setEditingExpId(null);
                        toast.success('Expérience mise à jour');
                      }}
                    />
                  ) : (
                    <div key={exp.id} className="experience-item border-l-2 border-primary/30 pl-4 relative">
                      <div className="item-header flex flex-col md:flex-row md:items-start md:justify-between gap-1">
                        <div>
                          <h3 className="item-title font-semibold text-foreground">{exp.jobTitle}</h3>
                          <p className="item-company text-sm text-primary">{exp.companyName}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {formatDateRange(exp.startDate, exp.endDate) && (
                            <span className="item-date text-sm text-muted-foreground flex items-center gap-1.5">
                              <CalendarDays className="h-4 w-4" />
                              {formatDateRange(exp.startDate, exp.endDate)}
                            </span>
                          )}
                          {editMode && (
                            <div className="no-print flex gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setEditingExpId(exp.id)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive"
                                onClick={async () => {
                                  if (!window.confirm('Supprimer cette expérience ?')) return;
                                  try {
                                    const updated = await cvService.deleteWorkExperience(exp.id);
                                    setProfile(updated);
                                    toast.success('Expérience supprimée');
                                  } catch {
                                    toast.error('Échec de la suppression');
                                  }
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                      {exp.description && (
                        <p className="mt-3 text-base text-muted-foreground whitespace-pre-line leading-relaxed">{exp.description}</p>
                      )}
                    </div>
                  ),
                )}
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
                  <ProjectItem
                    key={p.id}
                    project={p}
                    editMode={editMode}
                    isEditing={editingProjectId === p.id}
                    onStartEdit={() => setEditingProjectId(p.id)}
                    onCancelEdit={() => setEditingProjectId(null)}
                    onSave={async (values) => {
                      await projectService.updateParticipation(p.id, values);
                      await reloadProfile();
                      setEditingProjectId(null);
                      toast.success('Projet mis à jour');
                    }}
                    onDelete={async () => {
                      if (!window.confirm('Retirer ce projet de votre CV ?')) return;
                      try {
                        await projectService.deleteParticipation(p.id);
                        await reloadProfile();
                        toast.success('Projet retiré');
                      } catch {
                        toast.error('Échec de la suppression');
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* â€”â€” Certifications â€”â€” */}
          {(profile.certifications.length > 0 || editMode) && (
            <section className="section">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2">
                  <Award className="h-5 w-5 text-primary" />
                  Certifications
                </h2>
                {editMode && (
                  <div className="no-print flex items-center gap-2">
                    <input
                      ref={certFileInputRef}
                      type="file"
                      accept=".pdf,.docx,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setUploadingCert(true);
                        try {
                          await certificationService.uploadCertification(file);
                          await reloadProfile();
                          toast.success('Certification vérifiée et ajoutée');
                        } catch (err: any) {
                          const msg =
                            err?.response?.data?.message ||
                            "Échec de l'import du justificatif";
                          toast.error(Array.isArray(msg) ? msg.join(' ') : msg);
                        } finally {
                          setUploadingCert(false);
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => certFileInputRef.current?.click()}
                      disabled={uploadingCert}
                    >
                      {uploadingCert ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <FileUp className="h-4 w-4 mr-1" />
                      )}
                      Importer un justificatif
                    </Button>
                  </div>
                )}
              </div>
              {editMode && (
                <p className="no-print -mt-2 mb-4 text-xs text-muted-foreground">
                  Pour ajouter une certification, importez son justificatif : il est
                  analysé puis enregistré comme vérifié.
                </p>
              )}
              <div className="space-y-4">
                {profile.certifications.map((cert) => (
                  <div key={cert.id} className="cert-item border-l-4 border-primary/40 pl-4 py-2">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h3 className="cert-name font-semibold text-base text-foreground">{cert.name}</h3>
                          {!cert.isUploaded && (
                            <Badge
                              variant="outline"
                              className="text-xs font-medium text-warning border-warning/40 bg-warning/10 gap-1"
                            >
                              <ShieldAlert className="h-3 w-3" />
                              Non vérifiée — justificatif non fourni
                            </Badge>
                          )}
                        </div>
                        {cert.issuingOrganization && (
                          <p className="cert-org text-sm text-primary font-medium mb-2">{cert.issuingOrganization}</p>
                        )}
                        <div className="cert-dates flex flex-wrap gap-4 text-base text-muted-foreground">
                          {cert.issueDate && <span>Émis : {fmtDate(cert.issueDate)}</span>}
                          {cert.expirationDate && <span>Expire : {fmtDate(cert.expirationDate)}</span>}
                        </div>
                      </div>
                      {editMode && (
                        <div className="no-print flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            onClick={async () => {
                              if (!window.confirm('Supprimer cette certification ?')) return;
                              try {
                                await certificationService.deleteCertification(cert.id);
                                await reloadProfile();
                                toast.success('Certification supprimée');
                              } catch {
                                toast.error('Échec de la suppression');
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {editMode && (
                      <p className="no-print mt-2 text-xs text-muted-foreground italic">
                        Les informations d'une certification proviennent du justificatif analysé et ne sont pas
                        modifiables. Pour corriger une erreur, supprimez la certification puis ré-importez le justificatif.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* â€”â€” Education â€”â€” */}
          {(profile.educations.length > 0 || editMode) && (
            <section className="section">
              <div className="flex items-center justify-between mb-4">
                <h2 className="section-title text-lg font-semibold text-primary flex items-center gap-2">
                  <GraduationCap className="h-5 w-5 text-primary" />
                  Formation
                </h2>
                {editMode && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="no-print"
                    onClick={() => setAddingEdu(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Ajouter
                  </Button>
                )}
              </div>
              <div className="space-y-4">
                {addingEdu && (
                  <EducationForm
                    onCancel={() => setAddingEdu(false)}
                    onSave={async (values) => {
                      const updated = await cvService.createEducation(values);
                      setProfile(updated);
                      setAddingEdu(false);
                      toast.success('Formation ajoutée');
                    }}
                  />
                )}
                {profile.educations.map((edu) =>
                  editingEduId === edu.id ? (
                    <EducationForm
                      key={edu.id}
                      initial={edu}
                      onCancel={() => setEditingEduId(null)}
                      onSave={async (values) => {
                        const updated = await cvService.updateEducation(edu.id, values);
                        setProfile(updated);
                        setEditingEduId(null);
                        toast.success('Formation mise à jour');
                      }}
                    />
                  ) : (
                    <div key={edu.id} className="education-item border-l-4 border-primary/40 pl-4 py-2">
                      <div className="flex justify-between items-start">
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
                        {editMode && (
                          <div className="no-print flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => setEditingEduId(edu.id)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive"
                              onClick={async () => {
                                if (!window.confirm('Supprimer cette formation ?')) return;
                                try {
                                  const updated = await cvService.deleteEducation(edu.id);
                                  setProfile(updated);
                                  toast.success('Formation supprimée');
                                } catch {
                                  toast.error('Échec de la suppression');
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>
          )}

        </CardContent>
      </Card>
    </div>
  );
};

// Date inputs need a strict YYYY-MM-DD value; flexible parser artifacts
// (e.g. "depuis 2020") simply leave the picker empty for the user to set.
const toDateInput = (d: string | null | undefined): string =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';

const ProjectItem: React.FC<{
  project: CvProfile['projects'][0];
  editMode: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (values: { description?: string; role?: string }) => Promise<void>;
  onDelete: () => void;
}> = ({ project, editMode, isEditing, onStartEdit, onCancelEdit, onSave, onDelete }) => {
  const projectDescription = (project.description ?? '').trim();
  const hasInvalidName = !project.name || project.name.toLowerCase() === 'unknown project';

  // Show description as the main project entry text in CV preview.
  const fallbackTitle = !hasInvalidName
    ? project.name
    : project.generatedTitle || 'Projet sans description';
  const mainProjectText = projectDescription || fallbackTitle;

  if (isEditing) {
    return <ProjectEditForm initial={project} onCancel={onCancelEdit} onSave={onSave} />;
  }

  return (
    <div className="border-l-2 border-primary/30 pl-4">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-1">
        <div>
          <h3 className="font-semibold text-foreground">{mainProjectText}</h3>
          {project.client && <p className="text-sm text-muted-foreground">{project.client}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {formatDateRange(project.startDate, project.endDate) && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" />
              {formatDateRange(project.startDate, project.endDate)}
            </span>
          )}
          {editMode && (
            <div className="no-print flex gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onStartEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>
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

// â€”â€” Edit forms â€”â€” //
// Each form persists immediately through cvService / certificationService /
// projectService so a parsing correction lands in the DB right away.

const ProfileBasicsEditor: React.FC<{
  profile: CvProfile;
  onSaved: (p: CvProfile) => void;
}> = ({ profile, onSaved }) => {
  const [currentPosition, setCurrentPosition] = useState(profile.currentPosition ?? '');
  const [professionalSummary, setProfessionalSummary] = useState(
    profile.professionalSummary ?? '',
  );
  const [totalExperienceYears, setTotalExperienceYears] = useState(
    profile.totalExperienceYears != null ? String(profile.totalExperienceYears) : '',
  );
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [address, setAddress] = useState(profile.address ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmedYears = totalExperienceYears.trim();
    let yearsNum: number | undefined;
    if (trimmedYears !== '') {
      yearsNum = Number(trimmedYears);
      if (!Number.isInteger(yearsNum) || yearsNum < 0) {
        toast.error("Le nombre d'années d'expérience doit être un entier positif.");
        return;
      }
    }
    setSaving(true);
    try {
      const updated = await cvService.updateProfileBasics({
        currentPosition: currentPosition.trim(),
        professionalSummary: professionalSummary.trim(),
        phone: phone.trim(),
        address: address.trim(),
        ...(yearsNum !== undefined ? { totalExperienceYears: yearsNum } : {}),
      });
      onSaved(updated);
      toast.success('Informations enregistrées');
    } catch {
      toast.error("Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cv-position">Poste actuel</Label>
          <Input
            id="cv-position"
            value={currentPosition}
            onChange={(e) => setCurrentPosition(e.target.value)}
            placeholder="Ex : Ingénieur DevOps"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cv-years">Années d'expérience</Label>
          <Input
            id="cv-years"
            type="number"
            min={0}
            value={totalExperienceYears}
            onChange={(e) => setTotalExperienceYears(e.target.value)}
            placeholder="Ex : 5"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cv-email">Email (connexion)</Label>
          <Input id="cv-email" value={profile.email} disabled readOnly />
          <p className="text-xs text-muted-foreground">
            L'email de connexion ne peut pas être modifié ici.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cv-phone">Téléphone</Label>
          <Input
            id="cv-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Ex : +216 12 345 678"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cv-address">Adresse</Label>
        <Input
          id="cv-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Ex : 12 rue des Jasmins, Tunis"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cv-summary">Résumé professionnel</Label>
        <Textarea
          id="cv-summary"
          rows={4}
          value={professionalSummary}
          onChange={(e) => setProfessionalSummary(e.target.value)}
          placeholder="Bref résumé de votre profil"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-2" />
          )}
          Enregistrer
        </Button>
      </div>
    </div>
  );
};

const WorkExperienceForm: React.FC<{
  initial?: CvProfile['workExperiences'][0];
  onCancel: () => void;
  onSave: (values: {
    jobTitle: string;
    companyName: string;
    startDate?: string;
    endDate?: string;
    isCurrent?: boolean;
    description?: string;
  }) => Promise<void>;
}> = ({ initial, onCancel, onSave }) => {
  const [jobTitle, setJobTitle] = useState(initial?.jobTitle ?? '');
  const [companyName, setCompanyName] = useState(initial?.companyName ?? '');
  const [startDate, setStartDate] = useState(toDateInput(initial?.startDate));
  const [endDate, setEndDate] = useState(toDateInput(initial?.endDate));
  const [isCurrent, setIsCurrent] = useState(Boolean(initial?.isCurrent));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!jobTitle.trim() || !companyName.trim()) {
      toast.error("Le poste et l'entreprise sont obligatoires.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        jobTitle: jobTitle.trim(),
        companyName: companyName.trim(),
        startDate: startDate || '',
        endDate: isCurrent ? '' : endDate || '',
        isCurrent,
        description: description.trim(),
      });
    } catch {
      toast.error("Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3 no-print">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Poste *</Label>
          <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Entreprise *</Label>
          <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Date de début</Label>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Date de fin</Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={isCurrent}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="exp-current" checked={isCurrent} onCheckedChange={setIsCurrent} />
        <Label htmlFor="exp-current" className="cursor-pointer">
          Poste actuel
        </Label>
      </div>
      <div className="space-y-1.5">
        <Label>Description</Label>
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="h-4 w-4 mr-1" /> Annuler
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-1" />
          )}
          Enregistrer
        </Button>
      </div>
    </div>
  );
};

const EducationForm: React.FC<{
  initial?: CvProfile['educations'][0];
  onCancel: () => void;
  onSave: (values: {
    degree: string;
    fieldOfStudy?: string;
    institution?: string;
    endDate?: string;
  }) => Promise<void>;
}> = ({ initial, onCancel, onSave }) => {
  const [degree, setDegree] = useState(initial?.degree ?? '');
  const [fieldOfStudy, setFieldOfStudy] = useState(initial?.fieldOfStudy ?? '');
  const [institution, setInstitution] = useState(initial?.institution ?? '');
  const [endDate, setEndDate] = useState(toDateInput(initial?.endDate));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!degree.trim()) {
      toast.error('Le diplôme est obligatoire.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        degree: degree.trim(),
        fieldOfStudy: fieldOfStudy.trim(),
        institution: institution.trim(),
        endDate: endDate || '',
      });
    } catch {
      toast.error("Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3 no-print">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Diplôme *</Label>
          <Input value={degree} onChange={(e) => setDegree(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Domaine d'étude</Label>
          <Input value={fieldOfStudy} onChange={(e) => setFieldOfStudy(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Établissement</Label>
          <Input value={institution} onChange={(e) => setInstitution(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Date d'obtention</Label>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="h-4 w-4 mr-1" /> Annuler
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-1" />
          )}
          Enregistrer
        </Button>
      </div>
    </div>
  );
};

const ProjectEditForm: React.FC<{
  initial: CvProfile['projects'][0];
  onCancel: () => void;
  onSave: (values: { description?: string; role?: string }) => Promise<void>;
}> = ({ initial, onCancel, onSave }) => {
  const [description, setDescription] = useState(initial.description ?? '');
  const [role, setRole] = useState(initial.role ?? '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSave({ description: description.trim(), role: role.trim() });
    } catch {
      toast.error("Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3 no-print">
      <div className="space-y-1.5">
        <Label>Rôle</Label>
        <Input value={role} onChange={(e) => setRole(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Description</Label>
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          <X className="h-4 w-4 mr-1" /> Annuler
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-1" />
          )}
          Enregistrer
        </Button>
      </div>
    </div>
  );
};

export default CVPreviewPage;
