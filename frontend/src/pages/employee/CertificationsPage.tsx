import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/services/api';
import { CvCertification, CvProfile, UploadStatus } from '@/types';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Award,
  Plus,
  Upload,
  Search,
  Calendar,
  Loader2,
  CheckCircle,
  File,
  ShieldCheck,
  Clock,
  FileUp,
  Lightbulb,
  UserCheck,
  Tag,
  ScanLine,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useAuth } from '@/contexts/AuthContext';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { UploadProgress } from '@/components/common';
import { cn } from '@/lib/utils';

interface UploadedFileInfo {
  name: string;
  size: number;
  type: string;
}

const parseDateOnly = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
};

const getDynamicStatus = (cert: CvCertification): CvCertification['status'] => {
  const expDate = parseDateOnly(cert.expirationDate);
  if (!expDate) return cert.status || 'active';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysUntilExpiration = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntilExpiration < 0) return 'expired';
  if (daysUntilExpiration <= 30) return 'expiring_soon';
  return 'active';
};

const formatCertName = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

const CertificationsPage: React.FC = () => {
  const ALLOWED_TYPES = useMemo(
    () => [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
    ],
    []
  );
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (align with backend)

  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFileInfo | null>(null);
  const [profile, setProfile] = useState<CvProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Per-card proof upload state ("À confirmer" cards).
  const [uploadingCertId, setUploadingCertId] = useState<string | null>(null);
  const [dragOverCertId, setDragOverCertId] = useState<string | null>(null);
  const cardInputRef = useRef<HTMLInputElement | null>(null);
  const cardTargetRef = useRef<CvCertification | null>(null);
  const { user } = useAuth();

  // If the user's name equals their email, they haven't uploaded a CV yet
  const hasConfiguredName = user && user.name !== user.email;

  const loadData = useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await api.get<CvProfile>('/cv/profile/me');
      setProfile(response.data);
    } catch {
      setProfile(null);
    }

    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const validateFile = useCallback(
    (file: File): string | null => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        return 'Type de fichier non supporté. Veuillez importer un PDF, DOCX, PNG ou JPG.';
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return 'Fichier trop volumineux. La taille maximale autorisée est 10 Mo.';
      }
      return null;
    },
    [ALLOWED_TYPES, MAX_UPLOAD_BYTES]
  );

  const uploadCertificate = useCallback(
    async (file: File) => {
      setUploadedFile({
        name: file.name,
        size: file.size,
        type: file.type,
      });
      setUploadStatus('uploading');
      setProgress(0);
      setUploadError(null);
      let markedParsing = false;

      try {
        const formData = new FormData();
        formData.append('file', file);

        await api.post('/certifications/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (event) => {
            if (event.total) {
              const pct = Math.round((event.loaded / event.total) * 100);
              setProgress(pct);
              if (pct >= 100 && !markedParsing) {
                markedParsing = true;
                setUploadStatus('parsing');
              }
            }
          },
        });

        setProgress(100);
        setUploadStatus('completed');
        await loadData();
      } catch (err) {
        console.error('Certificate upload failed', err);
        setUploadStatus('error');
        if (axios.isAxiosError(err)) {
          const message = (err.response?.data as { message?: string } | undefined)?.message;
          const friendly =
            message?.includes('malware') || message?.includes('virus')
              ? 'Importation bloquée : logiciel malveillant détecté dans le fichier.'
              : message;
          setUploadError(friendly || 'Échec de l\'importation. Veuillez réessayer.');
          toast.error(friendly || 'Échec de l\'importation. Veuillez réessayer.');
        } else {
          setUploadError('Échec de l\'importation. Veuillez réessayer.');
          toast.error('Échec de l\'importation. Veuillez réessayer.');
        }
      }
    },
    [loadData]
  );

  // Proof upload tied to a specific "À confirmer" card. Reuses the same backend
  // endpoint: the OCR'd name is matched against the existing certification, which
  // flips it to verified. We surface a clear toast and a mismatch warning.
  const uploadProofForCert = useCallback(
    async (file: File, target: CvCertification) => {
      const validationError = validateFile(file);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      setUploadingCertId(target.id);
      try {
        const formData = new FormData();
        formData.append('file', file);
        // Bind the proof to the targeted card: the backend rejects the upload if
        // the OCR'd certification name does not match this certification.
        formData.append('expected_certification_name', target.name);
        await api.post('/certifications/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        toast.success(`« ${formatCertName(target.name)} » vérifiée et désormais prise en considération.`);
        await loadData();
      } catch (err) {
        console.error('Proof upload failed', err);
        if (axios.isAxiosError(err)) {
          const message = (err.response?.data as { message?: string } | undefined)?.message;
          const friendly =
            message?.includes('malware') || message?.includes('virus')
              ? 'Importation bloquée : logiciel malveillant détecté dans le fichier.'
              : message;
          toast.error(friendly || 'Échec de la vérification. Veuillez réessayer.');
        } else {
          toast.error('Échec de la vérification. Veuillez réessayer.');
        }
      } finally {
        setUploadingCertId(null);
      }
    },
    [loadData, validateFile]
  );

  const triggerCardUpload = useCallback((cert: CvCertification) => {
    cardTargetRef.current = cert;
    cardInputRef.current?.click();
  }, []);

  const certifications = useMemo(() => profile?.certifications || [], [profile]);
  const normalizeText = useCallback(
    (value: string) => value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
    []
  );

  const filteredCertifications = useMemo(() => {
    const q = normalizeText(searchQuery.trim());
    const filtered = q
      ? certifications.filter((cert) => {
          const nameMatch = normalizeText(cert.name).includes(q);
          const issuerMatch = normalizeText(cert.issuingOrganization || '').includes(q);
          return nameMatch || issuerMatch;
        })
      : certifications;

    const statusPriority: Record<string, number> = { expiring_soon: 0, active: 1, expired: 2 };
    return [...filtered].sort((a, b) => {
      const sa = getDynamicStatus(a);
      const sb = getDynamicStatus(b);
      const pa = statusPriority[sa] ?? 1;
      const pb = statusPriority[sb] ?? 1;
      if (pa !== pb) return pa - pb;
      const da = parseDateOnly(a.expirationDate)?.getTime() ?? Infinity;
      const db = parseDateOnly(b.expirationDate)?.getTime() ?? Infinity;
      return da - db;
    });
  }, [certifications, searchQuery, normalizeText]);

  const verifiedCertifications = useMemo(
    () => filteredCertifications.filter((c) => c.isUploaded),
    [filteredCertifications]
  );
  const pendingCertifications = useMemo(
    () => filteredCertifications.filter((c) => !c.isUploaded),
    [filteredCertifications]
  );

  // Progress is computed over the full set (not the search-filtered one).
  const verifiedCount = useMemo(() => certifications.filter((c) => c.isUploaded).length, [certifications]);
  const totalCount = certifications.length;
  const pendingCount = totalCount - verifiedCount;
  const verifiedPct = totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;

  const daysUntilExpiry = (cert: CvCertification): number | null => {
    const expDate = parseDateOnly(cert.expirationDate);
    if (!expDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'Non spécifié';
    return dateString;
  };

  const statusClass = (status?: CvCertification['status']) => {
    if (status === 'active') return 'bg-success/10 text-success';
    if (status === 'expiring_soon') return 'bg-warning/10 text-warning';
    if (status === 'expired') return 'bg-destructive/10 text-destructive';
    return 'bg-muted text-muted-foreground';
  };

  const formatStatus = (status?: CvCertification['status']) => {
    if (status === 'active') return 'Active';
    if (status === 'expiring_soon') return 'Expire bientôt';
    if (status === 'expired') return 'Expirée';
    return 'Inconnue';
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusMessage = (): string => {
    switch (uploadStatus) {
      case 'uploading':
        return 'Importation de la certification...';
      case 'parsing':
        return 'Analyse du document par l\'IA...';
      case 'completed':
        return 'Certification importée avec succès !';
      case 'error':
        return 'Échec de l\'importation. Veuillez réessayer.';
      default:
        return '';
    }
  };

  const resetUploadState = () => {
    setUploadStatus('idle');
    setProgress(0);
    setUploadError(null);
    setUploadedFile(null);
  };

  return (
    <div className="space-y-6">
      {/* Hidden input shared by all per-card proof uploads */}
      <input
        ref={cardInputRef}
        type="file"
        accept=".pdf,.docx,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = cardTargetRef.current;
          e.target.value = '';
          cardTargetRef.current = null;
          if (file && target) {
            uploadProofForCert(file, target);
          }
        }}
      />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Certifications</h1>
          <p className="text-muted-foreground">Importez et consultez vos certifications extraites</p>
        </div>
        <Dialog
          open={isAddDialogOpen}
          onOpenChange={(open) => {
            if (open && !hasConfiguredName) {
              // Do not open the dialog if they don't have a name configured
              return;
            }
            if (!open) {
              resetUploadState();
            }
            setIsAddDialogOpen(open);
          }}
        >
          <DialogTrigger asChild>
            <Button disabled={!hasConfiguredName}>
              <Plus className="h-4 w-4 mr-2" />
              Ajouter une certification
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Importer une certification</DialogTitle>
              <DialogDescription>
                Importez un fichier PDF, DOCX ou image. Les métadonnées sont extraites automatiquement.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {uploadStatus === 'idle' ? (
                <div className="relative border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors cursor-pointer">
                  <input
                    type="file"
                    accept=".pdf,.docx,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const validationError = validateFile(file);
                      if (validationError) {
                        setUploadError(validationError);
                        toast.error(validationError);
                        return;
                      }
                      uploadCertificate(file);
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">Importer le certificat</p>
                  <p className="text-xs text-muted-foreground">PDF, DOCX, PNG, JPG (max 10 Mo)</p>
                  {uploadError && (
                    <p className="text-xs text-destructive mt-2">{uploadError}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {uploadedFile && (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <File className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{uploadedFile.name}</p>
                        <p className="text-xs text-muted-foreground">{formatFileSize(uploadedFile.size)}</p>
                      </div>
                      {uploadStatus === 'completed' && (
                        <CheckCircle className="h-5 w-5 text-success" />
                      )}
                    </div>
                  )}

                  {(uploadStatus === 'uploading' || uploadStatus === 'parsing') && (
                    <UploadProgress
                      progress={uploadStatus === 'parsing' ? 100 : progress}
                      status={getStatusMessage()}
                    />
                  )}

                  {uploadStatus === 'parsing' && (
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      Analyse des détails de la certification...
                    </div>
                  )}

                  {/* Status Steps */}
                  {uploadStatus !== 'idle' && (
                    <div className="flex items-center justify-center gap-2 py-2">
                      {['Importation', 'Analyse', 'Terminé'].map((step, index) => {
                        const isActive =
                          (index === 0 && uploadStatus === 'uploading') ||
                          (index === 1 && uploadStatus === 'parsing') ||
                          (index === 2 && uploadStatus === 'completed');
                        const isCompleted =
                          (index === 0 && ['parsing', 'completed'].includes(uploadStatus)) ||
                          (index === 1 && uploadStatus === 'completed') ||
                          (index === 2 && uploadStatus === 'completed');

                        return (
                          <React.Fragment key={step}>
                            <div
                              className={cn(
                                'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition-colors',
                                isActive && 'bg-primary text-primary-foreground',
                                isCompleted && 'bg-success/10 text-success',
                                !isActive && !isCompleted && 'bg-muted text-muted-foreground'
                              )}
                            >
                              {isCompleted ? (
                                <CheckCircle className="h-3.5 w-3.5" />
                              ) : isActive ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <span className="h-3.5 w-3.5 flex items-center justify-center text-[10px]">
                                  {index + 1}
                                </span>
                              )}
                              {step}
                            </div>
                            {index < 2 && (
                              <div
                                className={cn(
                                  'w-6 h-0.5 rounded-full',
                                  isCompleted ? 'bg-success' : 'bg-muted'
                                )}
                              />
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}

                  {uploadStatus === 'completed' && (
                    <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-sm">
                      <div className="flex items-center gap-2 text-success">
                        <CheckCircle className="h-4 w-4" />
                        Certification importée avec succès.
                      </div>
                    </div>
                  )}

                  {uploadStatus === 'error' && uploadError && (
                    <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                      {uploadError}
                    </div>
                  )}

                  <div className="flex justify-center gap-2 pt-2">
                    {uploadStatus === 'completed' && (
                      <Button variant="outline" onClick={resetUploadState}>
                        Importer une autre
                      </Button>
                    )}
                    {(uploadStatus === 'uploading' || uploadStatus === 'parsing') && (
                      <Button variant="outline" onClick={resetUploadState}>
                        Annuler
                      </Button>
                    )}
                    {uploadStatus === 'error' && (
                      <Button variant="outline" onClick={resetUploadState}>
                        Réessayer
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                Fermer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {!hasConfiguredName && (
        <Alert variant="destructive">
          <AlertTitle>Action requise</AlertTitle>
          <AlertDescription>
            Veuillez d'abord importer votre CV dans la section Profil. Nous avons besoin de votre nom pour vérifier que les certifications importées vous appartiennent.
          </AlertDescription>
        </Alert>
      )}

      {/* Verification progress */}
      {totalCount > 0 && (
        <Card>
          <CardContent className="py-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-success" />
                <span className="font-medium">
                  {verifiedCount}/{totalCount} certifications vérifiées
                </span>
              </div>
              <span className="text-sm text-muted-foreground">{verifiedPct}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-success transition-all duration-500"
                style={{ width: `${verifiedPct}%` }}
              />
            </div>
            {pendingCount > 0 ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-warning">{pendingCount}</span> certification(s) en attente de
                justificatif. Elles ne sont pas encore prises en considération — ajoutez la preuve pour les valider.
              </p>
            ) : (
              <p className="text-sm text-success">
                Toutes vos certifications sont vérifiées. 🎉
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Rechercher des certifications..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Card>
          <CardContent className="py-12">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Chargement des certifications...
            </div>
          </CardContent>
        </Card>
      ) : filteredCertifications.length > 0 ? (
        <div className="space-y-8">
          {/* Pending section first — it's the actionable one */}
          {pendingCertifications.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-warning" />
                <h2 className="text-lg font-semibold">À confirmer — extraites de votre CV</h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning">
                  {pendingCertifications.length}
                </span>
                <ProofTips />
              </div>
              <p className="text-sm text-muted-foreground">
                Déposez le justificatif sur une carte (ou cliquez sur « Ajouter la preuve ») pour la valider.
              </p>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {pendingCertifications.map((cert, index) => (
                  <PendingCertCard
                    key={`pending-${cert.id}-${index}`}
                    cert={cert}
                    isUploading={uploadingCertId === cert.id}
                    isDragOver={dragOverCertId === cert.id}
                    onTriggerUpload={() => triggerCardUpload(cert)}
                    onDragOver={() => setDragOverCertId(cert.id)}
                    onDragLeave={() => setDragOverCertId((prev) => (prev === cert.id ? null : prev))}
                    onDropFile={(file) => {
                      setDragOverCertId(null);
                      uploadProofForCert(file, cert);
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Verified section */}
          {verifiedCertifications.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-success" />
                <h2 className="text-lg font-semibold">Vérifiées</h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                  {verifiedCertifications.length}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Justificatif fourni — elles sont prises en considération.
              </p>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {verifiedCertifications.map((cert, index) => {
                  const displayStatus = getDynamicStatus(cert);
                  const days = daysUntilExpiry(cert);
                  return (
                    <Card key={`verified-${cert.id}-${index}`} className="hover:shadow-md transition-all duration-200">
                      <CardContent className="p-5">
                        <div className="flex items-start justify-between gap-3 mb-4">
                          <div className="p-2 rounded-lg bg-success/10">
                            <ShieldCheck className="h-5 w-5 text-success" />
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusClass(displayStatus)}`}>
                              {formatStatus(displayStatus)}
                            </span>
                            {days !== null && days >= 0 && days <= 60 && (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning border border-warning/20">
                                {days === 0 ? 'Expire aujourd\'hui' : `Expire dans ${days}j`}
                              </span>
                            )}
                            <span className="px-2 py-1 rounded-full text-xs font-medium bg-success/10 text-success">
                              Vérifiée
                            </span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <h3
                            className="font-semibold text-foreground leading-tight break-words whitespace-normal"
                            title={formatCertName(cert.name)}
                          >
                            {formatCertName(cert.name)}
                          </h3>
                          {cert.issuingOrganization && (
                            <p className="text-sm text-muted-foreground">{cert.issuingOrganization}</p>
                          )}
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>Émis : {formatDate(cert.issueDate)}</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>Expire : {formatDate(cert.expirationDate)}</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <Award className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="font-medium text-lg mb-1">Aucune certification trouvée</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Importez un certificat pour analyser et remplir votre liste.
            </p>
            <Button disabled={!hasConfiguredName} onClick={() => setIsAddDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Ajouter une certification
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

// Discreet, contextual tips so users upload a proof that actually passes the
// verification (name match, certification match, readability).
const ProofTips: React.FC = () => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
      >
        <Lightbulb className="h-3.5 w-3.5" />
        Conseils
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-72 text-sm">
      <p className="font-medium mb-2">Pour que la validation réussisse</p>
      <ul className="space-y-2 text-muted-foreground">
        <li className="flex gap-2">
          <UserCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <span>Le document doit afficher <strong>votre nom</strong> (prénom et nom), comme sur votre profil.</span>
        </li>
        <li className="flex gap-2">
          <Tag className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <span>Le <strong>nom de la certification</strong> doit correspondre à la carte que vous validez.</span>
        </li>
        <li className="flex gap-2">
          <ScanLine className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <span>Importez un fichier <strong>net et lisible</strong> — PDF de préférence, ou photo/scan bien cadré.</span>
        </li>
      </ul>
    </PopoverContent>
  </Popover>
);

interface PendingCertCardProps {
  cert: CvCertification;
  isUploading: boolean;
  isDragOver: boolean;
  onTriggerUpload: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDropFile: (file: File) => void;
}

const PendingCertCard: React.FC<PendingCertCardProps> = ({
  cert,
  isUploading,
  isDragOver,
  onTriggerUpload,
  onDragOver,
  onDragLeave,
  onDropFile,
}) => {
  return (
    <Card
      className={cn(
        'border-dashed transition-all duration-200',
        isDragOver ? 'border-primary ring-2 ring-primary/30 bg-primary/5' : 'hover:shadow-md',
        isUploading && 'opacity-70'
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isUploading) onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        if (isUploading) return;
        const file = e.dataTransfer.files?.[0];
        if (file) onDropFile(file);
      }}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="p-2 rounded-lg bg-warning/10">
            <Clock className="h-5 w-5 text-warning" />
          </div>
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning border border-warning/20">
            À confirmer
          </span>
        </div>
        <div className="space-y-2">
          <h3
            className="font-semibold text-foreground leading-tight break-words whitespace-normal"
            title={formatCertName(cert.name)}
          >
            {formatCertName(cert.name)}
          </h3>
          {cert.issuingOrganization && (
            <p className="text-sm text-muted-foreground">{cert.issuingOrganization}</p>
          )}
          {cert.issueDate && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>Émis : {cert.issueDate}</span>
            </div>
          )}
        </div>
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isUploading}
            onClick={onTriggerUpload}
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Vérification...
              </>
            ) : (
              <>
                <FileUp className="h-4 w-4 mr-2" />
                Ajouter la preuve
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default CertificationsPage;
