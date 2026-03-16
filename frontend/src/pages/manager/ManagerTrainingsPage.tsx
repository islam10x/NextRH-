import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { trainingService } from '@/services/training.service';
import { Training } from '@/types';
import { GraduationCap, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';

const statusColor = (status?: string) => {
  if (status === 'completed') return 'bg-success/15 text-success';
  if (status === 'in_progress') return 'bg-primary/15 text-primary';
  return 'bg-secondary text-secondary-foreground';
};

const ManagerTrainingsPage: React.FC = () => {
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await trainingService.listAssignedByMe();
      setTrainings(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to load trainings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Trainings</h1>
        <p className="text-muted-foreground">History of trainings you assigned and their progress.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Assigned Trainings</CardTitle>
          <CardDescription>Track status across your team</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : trainings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trainings assigned yet.</p>
          ) : (
            trainings.map((t) => (
              <div key={t.id} className="border rounded-lg p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-primary" />
                  <span className="font-medium">{t.name}</span>
                </div>
                <Badge className={statusColor(t.status)}>{t.status || 'assigned'}</Badge>
              </div>
              {t.assigneeName && <p className="text-xs text-muted-foreground">Assignee: {t.assigneeName}</p>}
              {t.provider && <p className="text-xs text-muted-foreground">{t.provider}</p>}
              <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                <span>Assigned: {t.assignedAt ? new Date(t.assignedAt).toISOString().slice(0, 10) : 'n/a'}</span>
                <span>Due: {t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : 'n/a'}</span>
                {t.completionDate && <span>Completed: {new Date(t.completionDate).toISOString().slice(0, 10)}</span>}
                {t.trainingUrl && (
                  <a href={t.trainingUrl} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                    <LinkIcon className="h-3 w-3" /> Link
                  </a>
                )}
                {t.certificationName && (
                  <span>
                    Certification: {t.certificationName}
                    {t.certificationIssueDate ? ` · Issued ${new Date(t.certificationIssueDate).toISOString().slice(0, 10)}` : ''}
                  </span>
                )}
                {!t.certificationName && t.proofFilePath && <span>Certification uploaded</span>}
                {t.proofUrl && (
                  <button
                    className="text-primary hover:underline"
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        const blob = await trainingService.downloadProof(t.id);
                        const url = URL.createObjectURL(blob);
                        window.open(url, '_blank');
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                      } catch (err: any) {
                        toast.error(err?.response?.data?.message || 'Cannot load proof');
                      }
                    }}
                  >
                    View proof (PDF/Image)
                  </button>
                )}
                {t.description && <span>Comment: {t.description}</span>}
              </div>
            </div>
          ))
        )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagerTrainingsPage;
