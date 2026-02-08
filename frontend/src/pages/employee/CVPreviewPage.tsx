import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { StatusBadge } from '@/components/common';
import { mockEmployees } from '@/data/mockData';
import { Employee } from '@/types';
import {
  FileText,
  Download,
  Printer,
  Mail,
  MapPin,
  Phone,
  Award,
  Briefcase,
  GraduationCap,
  Code,
  Building2,
  Calendar,
} from 'lucide-react';
import { format } from 'date-fns';

const CVPreviewPage: React.FC = () => {
  const { user } = useAuth();

  const employeeData = mockEmployees.find((emp) => emp.id === user?.id) as Employee | undefined;

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM yyyy');
    } catch {
      return dateString;
    }
  };

  if (!employeeData) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <h3 className="font-medium text-lg mb-1">No CV data available</h3>
          <p className="text-muted-foreground text-sm">
            Please upload your CV to view it here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">CV Preview</h1>
          <p className="text-muted-foreground">Your professional CV</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
          <Button size="sm">
            <Download className="h-4 w-4 mr-2" />
            Download PDF
          </Button>
        </div>
      </div>

      {/* CV Document */}
      <Card className="max-w-4xl mx-auto shadow-lg">
        <CardContent className="p-8 space-y-8">
          {/* Header Section */}
          <div className="text-center pb-6 border-b">
            <h1 className="text-3xl font-bold text-foreground mb-2">{employeeData.name}</h1>
            <p className="text-xl text-primary font-medium mb-4">{employeeData.title}</p>
            <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Mail className="h-4 w-4" />
                {employeeData.email}
              </span>
              <span className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4" />
                {employeeData.department}
              </span>
            </div>
          </div>

          {/* Summary Section */}
          {employeeData.summary && (
            <section>
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-3">
                <FileText className="h-5 w-5 text-primary" />
                Professional Summary
              </h2>
              <p className="text-muted-foreground leading-relaxed">{employeeData.summary}</p>
            </section>
          )}

          {/* Skills Section */}
          <section>
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-3">
              <Code className="h-5 w-5 text-primary" />
              Technical Skills
            </h2>
            <div className="flex flex-wrap gap-2">
              {employeeData.skills.map((skill) => (
                <Badge key={skill} variant="secondary" className="text-sm">
                  {skill}
                </Badge>
              ))}
            </div>
          </section>

          {/* Experience Section */}
          {employeeData.projects.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
                <Briefcase className="h-5 w-5 text-primary" />
                Project Experience
              </h2>
              <div className="space-y-6">
                {employeeData.projects.map((project) => (
                  <div key={project.id} className="border-l-2 border-primary/30 pl-4">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2">
                      <div>
                        <h3 className="font-semibold text-foreground">{project.name}</h3>
                        <p className="text-sm text-primary">{project.role}</p>
                        <p className="text-sm text-muted-foreground">{project.client}</p>
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        {formatDate(project.startDate)} - {project.endDate ? formatDate(project.endDate) : 'Present'}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {project.technologies.map((tech) => (
                        <Badge key={tech} variant="outline" className="text-xs">
                          {tech}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Certifications Section */}
          {employeeData.certifications.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
                <Award className="h-5 w-5 text-primary" />
                Certifications
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {employeeData.certifications.map((cert) => (
                  <div
                    key={cert.id}
                    className="flex items-start gap-3 p-3 rounded-lg bg-muted/30"
                  >
                    <Award className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{cert.name}</p>
                      <p className="text-xs text-muted-foreground">{cert.issuer}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">
                          Expires: {formatDate(cert.expirationDate)}
                        </span>
                        <StatusBadge status={cert.status} className="text-xs py-0" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Education Section */}
          {employeeData.education && employeeData.education.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
                <GraduationCap className="h-5 w-5 text-primary" />
                Education
              </h2>
              <div className="space-y-4">
                {employeeData.education.map((edu) => (
                  <div key={edu.id} className="flex items-start gap-3">
                    <GraduationCap className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">{edu.degree} in {edu.field}</p>
                      <p className="text-sm text-muted-foreground">{edu.institution}</p>
                      <p className="text-xs text-muted-foreground">Graduated: {edu.graduationYear}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Training Section */}
          {employeeData.trainings.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-4">
                <GraduationCap className="h-5 w-5 text-primary" />
                Professional Development
              </h2>
              <div className="space-y-2">
                {employeeData.trainings.map((training) => (
                  <div key={training.id} className="flex items-center justify-between py-2 border-b border-muted last:border-0">
                    <div>
                      <p className="font-medium text-sm">{training.name}</p>
                      <p className="text-xs text-muted-foreground">{training.provider}</p>
                    </div>
                    <div className="text-xs text-muted-foreground text-right">
                      <p>{formatDate(training.completionDate)}</p>
                      <p>{training.duration}</p>
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

export default CVPreviewPage;
