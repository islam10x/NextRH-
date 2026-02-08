import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/common';
import { getEmployeeById } from '@/data/mockData';
import { ArrowLeft, Mail, Building2, Calendar, Award, Briefcase, GraduationCap, Code } from 'lucide-react';
import { format } from 'date-fns';

const MemberProfilePage: React.FC = () => {
  const { memberId } = useParams();
  const navigate = useNavigate();

  const member = memberId ? getEmployeeById(memberId) : undefined;

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM yyyy');
    } catch {
      return dateString;
    }
  };

  if (!member) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground">Member not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back Button */}
      <Button variant="ghost" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Team
      </Button>

      {/* Profile Header */}
      <Card className="animate-fade-in">
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row gap-6">
            <Avatar className="h-24 w-24">
              <AvatarFallback className="bg-primary text-primary-foreground text-2xl">
                {member.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-foreground">{member.name}</h1>
              <p className="text-lg text-primary font-medium">{member.title}</p>
              <div className="flex flex-wrap gap-4 mt-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Mail className="h-4 w-4" />
                  {member.email}
                </span>
                <span className="flex items-center gap-1.5">
                  <Building2 className="h-4 w-4" />
                  {member.department}
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-4 w-4" />
                  {member.yearsOfExperience} years experience
                </span>
              </div>
              {member.summary && (
                <p className="mt-4 text-muted-foreground">{member.summary}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Skills */}
        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Code className="h-5 w-5 text-primary" />
              Skills
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {member.skills.map((skill) => (
                <Badge key={skill} variant="secondary" className="text-sm">
                  {skill}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Certifications */}
        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Award className="h-5 w-5 text-primary" />
              Certifications ({member.certifications.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {member.certifications.length > 0 ? (
              <div className="space-y-3">
                {member.certifications.map((cert) => (
                  <div
                    key={cert.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <div>
                      <p className="font-medium text-sm">{cert.name}</p>
                      <p className="text-xs text-muted-foreground">{cert.issuer}</p>
                    </div>
                    <StatusBadge status={cert.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-4">
                No certifications recorded
              </p>
            )}
          </CardContent>
        </Card>

        {/* Training */}
        <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <GraduationCap className="h-5 w-5 text-primary" />
              Training ({member.trainings.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {member.trainings.length > 0 ? (
              <div className="space-y-3">
                {member.trainings.map((training) => (
                  <div key={training.id} className="p-3 rounded-lg bg-muted/50">
                    <p className="font-medium text-sm">{training.name}</p>
                    <p className="text-xs text-muted-foreground">{training.provider}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDate(training.completionDate)} • {training.duration}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-4">
                No training records
              </p>
            )}
          </CardContent>
        </Card>

        {/* Projects */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-primary" />
              Projects ({member.projects.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {member.projects.length > 0 ? (
              <div className="space-y-3">
                {member.projects.map((project) => (
                  <div key={project.id} className="p-3 rounded-lg bg-muted/50">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm">{project.name}</p>
                        <p className="text-xs text-muted-foreground">{project.client}</p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {project.role}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                      {project.description}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {project.technologies.slice(0, 4).map((tech) => (
                        <Badge key={tech} variant="secondary" className="text-xs">
                          {tech}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-4">
                No project records
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default MemberProfilePage;
