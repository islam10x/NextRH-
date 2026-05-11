import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { trainingService } from '@/services/training.service';
import { teamService } from '@/services/team.service';
import { Training } from '@/types';
import {
  GraduationCap, Link as LinkIcon, Plus, Calendar, Search,
  Loader2, FileWarning, Download, Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/EmptyState';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { format } from 'date-fns';

const statusColor = (status?: string) => {
  if (status === 'completed') return 'bg-success/15 text-success';
  if (status === 'in_progress') return 'bg-primary/15 text-primary';
  return 'bg-secondary text-secondary-foreground';
};

const statusLabel = (status?: string) => {
  if (status === 'completed') return 'Terminée';
  if (status === 'in_progress') return 'En cours';
  return 'Assignée';
};

const ManagerTrainingsPage: React.FC = () => {
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [members, setMembers] = useState<{ userId: string; profileId: string | null; name: string; email: string }[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Filters (#46)
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterEmployee, setFilterEmployee] = useState('');

  // Proof viewer dialog (#47)
  const [proofDialog, setProofDialog] = useState<{
    open: boolean;
    url: string | null;
    mimeType: string;
    trainingName: string;
    loading: boolean;
  }>({ open: false, url: null, mimeType: '', trainingName: '', loading: false });

  const openProof = async (training: Training) => {
    setProofDialog({ open: true, url: null, mimeType: '', trainingName: training.name, loading: true });
    try {
      const blob = await trainingService.downloadProof(training.id);
      const objectUrl = URL.createObjectURL(blob);
      setProofDialog((prev) => ({ ...prev, url: objectUrl, mimeType: blob.type, loading: false }));
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Impossible de charger la preuve');
      setProofDialog({ open: false, url: null, mimeType: '', trainingName: '', loading: false });
    }
  };

  const closeProof = () => {
    if (proofDialog.url) URL.revokeObjectURL(proofDialog.url);
    setProofDialog({ open: false, url: null, mimeType: '', trainingName: '', loading: false });
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await trainingService.listAssignedByMe();
      setTrainings(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Impossible de charger les formations — veuillez actualiser.");
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async () => {
    setLoadingMembers(true);
    try {
      const data = await teamService.listMyMembers();
      const mapped = data.map((m) => ({
        userId: m.userId,
        profileId: m.profileId,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
        email: m.email,
      }));
      setMembers(mapped);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Impossible de charger les membres — veuillez actualiser.");
    } finally {
      setLoadingMembers(false);
    }
  };

  useEffect(() => {
    load();
    loadMembers();
  }, []);

  const toggleSelection = (profileId: string | null) => {
    if (!profileId) {
      toast.error('Ce membre n\'a pas encore de profil');
      return;
    }
    setSelectedProfiles((prev) =>
      prev.includes(profileId) ? prev.filter((id) => id !== profileId) : [...prev, profileId]
    );
  };

  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter((m) => {
      const name = (m.name || '').toLowerCase();
      const email = (m.email || '').toLowerCase();
      return name.includes(query) || email.includes(query);
    });
  }, [memberSearch, members]);

  // Apply status + employee filters (#46)
  const filteredTrainings = useMemo(() => {
    return trainings.filter((t) => {
      const effectiveStatus = t.status || 'assigned';
      const matchesStatus = filterStatus === 'all' || effectiveStatus === filterStatus;
      const matchesEmployee =
        !filterEmployee.trim() ||
        (t.assigneeName || '').toLowerCase().includes(filterEmployee.trim().toLowerCase());
      return matchesStatus && matchesEmployee;
    });
  }, [trainings, filterStatus, filterEmployee]);

  const handleAssign = async () => {
    if (!title.trim()) return toast.error('Le titre de la formation est requis');
    if (selectedProfiles.length === 0) return toast.error('Sélectionnez au moins un employé');
    setSubmitting(true);
    setAssignError(null);
    try {
      await trainingService.assign({
        trainingTitle: title.trim(),
        trainingUrl: url || undefined,
        dueDate: dueDate || undefined,
        description: description || undefined,
        provider: provider || undefined,
        assigneeProfileIds: selectedProfiles,
      });
      toast.success('Formation assignée');
      setIsAssignOpen(false);
      setSelectedProfiles([]);
      setTitle('');
      setUrl('');
      setDueDate('');
      setDescription('');
      setProvider('');
      load();
    } catch (error: any) {
      const backendMessage =
        error?.response?.data?.message ||
        error?.response?.statusText ||
        (typeof error?.message === 'string' ? error.message : null);
      const friendly = backendMessage ? `Erreur serveur : ${backendMessage}` : 'Échec de l\'assignation de la formation';
      setAssignError(friendly);
      toast.error(friendly);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Formations</h1>
          <p className="text-muted-foreground">Historique des formations assignées et leur progression.</p>
        </div>
        <Dialog
          open={isAssignOpen}
          onOpenChange={(open) => {
            if (!open) setMemberSearch('');
            setIsAssignOpen(open);
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Assigner une formation
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Assigner une formation</DialogTitle>
              <DialogDescription>
                Choisissez un titre, une date limite et les membres concernés.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="title">Titre</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kubernetes Fundamentals" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider">Prestataire (optionnel)</Label>
                <Input id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Linux Foundation" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="url">URL de la formation (optionnel)</Label>
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-4 w-4 text-muted-foreground" />
                  <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="dueDate">Date limite</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="dueDate"
                      type="button"
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      {dueDate ? format(new Date(dueDate), 'yyyy-MM-dd') : 'Choisir une date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarPicker
                      mode="single"
                      selected={dueDate ? new Date(dueDate) : undefined}
                      onSelect={(date) => {
                        if (!date) { setDueDate(''); return; }
                        setDueDate(format(date, 'yyyy-MM-dd'));
                      }}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        return date < today;
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Contexte, objectifs..." />
              </div>
              <div className="space-y-2">
                <Label>Membres de l'équipe</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Rechercher des membres..."
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <div className="max-h-48 overflow-auto rounded-md border p-2 space-y-2">
                  {loadingMembers ? (
                    <p className="text-sm text-muted-foreground">Chargement des membres...</p>
                  ) : members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Aucun membre trouvé</p>
                  ) : filteredMembers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Aucun membre correspondant</p>
                  ) : (
                    filteredMembers.map((m) => {
                      const disabled = !m.profileId;
                      const checked = m.profileId ? selectedProfiles.includes(m.profileId) : false;
                      return (
                        <label key={m.userId} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={checked}
                            onChange={() => toggleSelection(m.profileId)}
                          />
                          <span className={disabled ? 'text-muted-foreground' : ''}>
                            {m.name} ({m.email}) {disabled && '(pas encore de profil)'}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
              {assignError && (
                <p className="text-sm text-destructive">{assignError}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAssignOpen(false)}>
                Annuler
              </Button>
              <Button onClick={handleAssign} disabled={submitting}>
                Assigner
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters (#46) */}
      {trainings.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filtrer par employé..."
                  value={filterEmployee}
                  onChange={(e) => setFilterEmployee(e.target.value)}
                  className="pl-10 h-10"
                />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-10 w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les statuts</SelectItem>
                  <SelectItem value="assigned">Assignée</SelectItem>
                  <SelectItem value="in_progress">En cours</SelectItem>
                  <SelectItem value="completed">Terminée</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Formations assignées</CardTitle>
          <CardDescription>
            {filteredTrainings.length} formation{filteredTrainings.length !== 1 ? 's' : ''}{' '}
            {filterStatus !== 'all' || filterEmployee ? 'filtrée' + (filteredTrainings.length !== 1 ? 's' : '') : 'au total'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Chargement...</p>
          ) : trainings.length === 0 ? (
            <EmptyState
              icon={<GraduationCap />}
              title="Aucune formation assignée"
              description="Assignez une formation à un membre pour suivre sa progression ici."
              action={{ label: 'Assigner une formation', onClick: () => setIsAssignOpen(true) }}
            />
          ) : filteredTrainings.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Aucune formation ne correspond aux filtres sélectionnés.
            </div>
          ) : (
            filteredTrainings.map((t) => (
              <div key={t.id} className="border rounded-lg p-4 flex flex-col gap-1.5 hover:shadow-sm transition-shadow">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GraduationCap className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-medium">{t.name}</span>
                  </div>
                  <Badge className={statusColor(t.status)}>{statusLabel(t.status)}</Badge>
                </div>
                {t.assigneeName && (
                  <p className="text-xs text-muted-foreground">Assigné à : <span className="font-medium text-foreground">{t.assigneeName}</span></p>
                )}
                {t.provider && <p className="text-xs text-muted-foreground">{t.provider}</p>}
                <div className="flex gap-4 text-xs text-muted-foreground flex-wrap items-center">
                  <span>Assigné le : {t.assignedAt ? new Date(t.assignedAt).toISOString().slice(0, 10) : 'n/a'}</span>
                  <span>Échéance : {t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : 'n/a'}</span>
                  {t.completionDate && <span>Terminé le : {new Date(t.completionDate).toISOString().slice(0, 10)}</span>}
                  {t.trainingUrl && (
                    <a href={t.trainingUrl} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                      <LinkIcon className="h-3 w-3" /> Lien
                    </a>
                  )}
                  {t.certificationName && (
                    <span>
                      Certification : {t.certificationName}
                      {t.certificationIssueDate ? ` · Émise le ${new Date(t.certificationIssueDate).toISOString().slice(0, 10)}` : ''}
                    </span>
                  )}
                  {t.description && <span>Commentaire : {t.description}</span>}
                  {t.proofFilePath && t.proofUrl && (
                    <button
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      onClick={() => openProof(t)}
                    >
                      <Eye className="h-3 w-3" />
                      Voir la preuve
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Proof viewer dialog (#47) */}
      <Dialog open={proofDialog.open} onOpenChange={(open) => { if (!open) closeProof(); }}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0">
          <DialogHeader className="p-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5 text-primary" />
              Preuve — {proofDialog.trainingName}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 px-6 py-4 overflow-hidden">
            {proofDialog.loading ? (
              <div className="flex h-full items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
                <span className="text-sm">Chargement de la preuve…</span>
              </div>
            ) : proofDialog.url ? (
              proofDialog.mimeType === 'application/pdf' ? (
                <object
                  data={proofDialog.url}
                  type="application/pdf"
                  className="w-full h-full rounded-lg border"
                >
                  <iframe src={proofDialog.url} className="w-full h-full rounded-lg border" title="Preuve" />
                </object>
              ) : proofDialog.mimeType.startsWith('image/') ? (
                <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 rounded-lg border">
                  <img
                    src={proofDialog.url}
                    alt="Preuve"
                    className="max-w-full max-h-full object-contain rounded"
                  />
                </div>
              ) : (
                <div className="flex flex-col h-full items-center justify-center gap-4 text-center">
                  <FileWarning className="h-12 w-12 text-muted-foreground/50" />
                  <p className="text-muted-foreground text-sm">Aperçu non disponible pour ce type de fichier.</p>
                  <Button asChild variant="outline">
                    <a href={proofDialog.url} download>
                      <Download className="h-4 w-4 mr-2" />
                      Télécharger le fichier
                    </a>
                  </Button>
                </div>
              )
            ) : null}
          </div>

          <DialogFooter className="p-6 pt-3 border-t">
            {proofDialog.url && (
              <Button variant="outline" asChild>
                <a href={proofDialog.url} download={`preuve_${proofDialog.trainingName}`}>
                  <Download className="h-4 w-4 mr-2" />
                  Télécharger
                </a>
              </Button>
            )}
            <Button onClick={closeProof}>Fermer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManagerTrainingsPage;
