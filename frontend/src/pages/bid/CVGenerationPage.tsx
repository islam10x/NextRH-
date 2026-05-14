import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FileOutput, Download, Loader2, Check, Upload, AlertCircle, Eye,
  FileWarning, X, Info, AlertTriangle, FileText, Clock, Trash2, ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { bidService, type CvWarning, type MyTemplateHistoryItem } from '@/services/bid.service';
import { userService } from '@/services/user.service';
import { DBUser } from '@/types';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

type Engine = 'primary' | 'fallback';
type Language = 'en' | 'fr' | 'original';

const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
]);

const safeFilenamePart = (value: string) =>
  value.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '');

const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return 'Jamais utilisé';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Jamais utilisé';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'À l\'instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `il y a ${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Hier';
  if (diffDay < 7) return `il y a ${diffDay}j`;
  if (diffDay < 30) return `il y a ${Math.floor(diffDay / 7)} sem.`;
  if (diffDay < 365) return `il y a ${Math.floor(diffDay / 30)} mois`;
  return `il y a ${Math.floor(diffDay / 365)} an(s)`;
};

const CVGenerationPage: React.FC = () => {
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [employees, setEmployees] = useState<DBUser[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeePopoverOpen, setEmployeePopoverOpen] = useState(false);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<Language>('original');
  const [engine, setEngine] = useState<Engine>('fallback');
  const [isGenerating, setIsGenerating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [docxBlob, setDocxBlob] = useState<Blob | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [generatedFilename, setGeneratedFilename] = useState('');
  const [warnings, setWarnings] = useState<CvWarning[]>([]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfError, setPdfError] = useState(false);

  // Template history (per-bid-manager). One template is "selected" at a time:
  // either an uploaded file OR a history entry, never both.
  const [historyTemplates, setHistoryTemplates] = useState<MyTemplateHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedHistoryItem =
    historyTemplates.find((t) => t.id === selectedHistoryId) || null;
  const isPdfTemplate =
    (templateFile && templateFile.name.toLowerCase().endsWith('.pdf')) ||
    (!!selectedHistoryItem && selectedHistoryItem.extension === 'pdf');
  const hasTemplateSelection = !!templateFile || !!selectedHistoryItem;

  // Revoke the preview URL only when the URL itself changes or component unmounts.
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // Elapsed-time counter while generating. Generation can take 30-60s on
  // the first run (LibreOffice cold start + Groq); a counter reassures
  // the user that the request is still alive.
  useEffect(() => {
    if (!isGenerating) {
      setElapsedSeconds(0);
      return;
    }
    const start = Date.now();
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  // Cancel any in-flight request when the page unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchEmployees = async () => {
      try {
        const active = await userService.listActiveEmployees();
        if (cancelled) return;
        setEmployees(active);
      } catch {
        if (!cancelled) toast.error('Impossible de charger la liste des employés — vérifiez votre connexion et réessayez.');
      } finally {
        if (!cancelled) setIsLoadingEmployees(false);
      }
    };
    fetchEmployees();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the template history. Called once on mount and again after each
  // successful generation so the list and "last used" timestamps stay current.
  const refreshHistory = async () => {
    setHistoryLoading(true);
    try {
      const list = await bidService.listMyTemplates();
      setHistoryTemplates(list);
    } catch {
      // Non-fatal: the user can still upload a fresh template.
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    refreshHistory();
  }, []);

  const resetGeneration = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setDocxBlob(null);
    setPdfBlob(null);
    setPdfUrl(null);
    setPdfError(false);
    setGeneratedFilename('');
    setWarnings([]);
  };

  // Merge warnings from multiple parallel calls (DOCX + PDF) by code so the
  // user doesn't see the same advice twice.
  const mergeWarnings = (lists: CvWarning[][]): CvWarning[] => {
    const seen = new Set<string>();
    const merged: CvWarning[] = [];
    for (const list of lists) {
      for (const w of list) {
        if (seen.has(w.code)) continue;
        seen.add(w.code);
        merged.push(w);
      }
    }
    return merged;
  };

  const clearTemplate = () => {
    setTemplateFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    resetGeneration();
  };

  const clearHistorySelection = () => {
    setSelectedHistoryId(null);
    resetGeneration();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-uploading the same file fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    const validByMime = ALLOWED_MIMES.has(file.type);
    const validByExt = ext === 'docx' || ext === 'pdf';
    if (!validByMime && !validByExt) {
      toast.error('Veuillez importer un fichier .docx ou .pdf.');
      return;
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      toast.error(
        `Le modèle est trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo). Maximum : ${MAX_TEMPLATE_BYTES / 1024 / 1024} Mo.`,
      );
      return;
    }

    // Mutex: uploading a new file clears any history selection so generation
    // routes through the upload path instead of the stored-template path.
    setSelectedHistoryId(null);
    setTemplateFile(file);
    resetGeneration();
  };

  const handleSelectHistory = (templateId: string) => {
    if (isGenerating) return;
    if (selectedHistoryId === templateId) {
      // Clicking the already-selected card deselects it.
      clearHistorySelection();
      return;
    }
    // Mutex: selecting a card clears any in-progress upload.
    setTemplateFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSelectedHistoryId(templateId);
    resetGeneration();
  };

  const handleDeleteHistory = (
    e: React.MouseEvent<HTMLButtonElement>,
    templateId: string,
  ) => {
    e.stopPropagation();
    if (deletingHistoryId) return;
    setDeleteConfirmId(templateId);
  };

  const handleDeleteHistoryConfirmed = async () => {
    if (!deleteConfirmId) return;
    const templateId = deleteConfirmId;
    setDeleteConfirmId(null);
    setDeletingHistoryId(templateId);
    try {
      await bidService.deleteMyTemplate(templateId);
      setHistoryTemplates((prev) => prev.filter((t) => t.id !== templateId));
      if (selectedHistoryId === templateId) {
        setSelectedHistoryId(null);
        resetGeneration();
      }
      toast.success('Modèle supprimé de l\'historique');
    } catch (err: any) {
      toast.error(err?.message || 'Impossible de supprimer le modèle');
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleGenerate = async () => {
    if (!selectedEmployee || !hasTemplateSelection) {
      toast.error('Sélectionnez un employé et choisissez ou importez un modèle.');
      return;
    }

    setIsGenerating(true);
    resetGeneration();

    const controller = new AbortController();
    abortRef.current = controller;

    // Single dispatcher used for both flows so the rest of the handler stays
    // identical regardless of whether we're uploading or re-using.
    const generateOnce = (
      format: 'docx' | 'pdf',
    ): Promise<{ blob: Blob; warnings: CvWarning[] }> => {
      if (selectedHistoryItem) {
        return bidService.generateCvFromHistory(
          selectedEmployee,
          selectedHistoryItem.id,
          format,
          language,
          engine,
          { signal: controller.signal },
        );
      }
      return bidService.generateCv(
        selectedEmployee,
        templateFile as File,
        format,
        language,
        engine,
        { signal: controller.signal },
      );
    };

    try {
      const emp = employees.find((e) => e.user_id === selectedEmployee);
      const empName = emp
        ? safeFilenamePart([emp.firstName, emp.lastName].filter(Boolean).join('_')) || 'Employee'
        : 'Employee';

      // PDF templates via primary engine return a PDF directly (overlay path).
      // PDF templates via fallback engine convert to DOCX first, then output DOCX+PDF.
      if (isPdfTemplate && engine === 'primary') {
        const { blob: generatedPdf, warnings: ws } = await generateOnce('pdf');
        setPdfBlob(generatedPdf);
        setPdfUrl(URL.createObjectURL(generatedPdf));
        setPdfError(false);
        setGeneratedFilename(`${empName}_CV.pdf`);
        setWarnings(mergeWarnings([ws]));
      } else {
        // DOCX templates (any engine) or PDF template + fallback engine:
        // fetch DOCX (download) + PDF (preview) concurrently.
        const [docxResult, pdfResult] = await Promise.allSettled([
          generateOnce('docx'),
          generateOnce('pdf'),
        ]);

        const collectedWarnings: CvWarning[][] = [];

        if (docxResult.status === 'fulfilled') {
          setDocxBlob(docxResult.value.blob);
          setGeneratedFilename(`${empName}_CV.docx`);
          collectedWarnings.push(docxResult.value.warnings);
        } else {
          // DOCX is the primary deliverable — if it failed, surface a real error.
          const message = await bidService.extractBlobErrorMessage(docxResult.reason);
          throw new Error(message);
        }

        if (pdfResult.status === 'fulfilled' && pdfResult.value.blob.type === 'application/pdf') {
          setPdfBlob(pdfResult.value.blob);
          setPdfUrl(URL.createObjectURL(pdfResult.value.blob));
          setPdfError(false);
          collectedWarnings.push(pdfResult.value.warnings);
        } else {
          // PDF preview is best-effort — log but don't fail the whole flow.
          setPdfError(true);
          if (pdfResult.status === 'rejected') {
            // eslint-disable-next-line no-console
            console.warn('PDF preview unavailable:', pdfResult.reason);
          }
        }

        setWarnings(mergeWarnings(collectedWarnings));
      }

      setPreviewOpen(true);
      toast.success('CV généré avec succès');
      // Reflect the new last-used timestamp / usage count + surface any
      // newly-auto-saved upload in the recent-templates row.
      refreshHistory();
    } catch (err: any) {
      if (controller.signal.aborted) {
        toast.info('Génération annulée');
        return;
      }
      const message = await bidService.extractBlobErrorMessage(err);
      toast.error(message);
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const handleDownload = () => {
    const blob = docxBlob || pdfBlob;
    if (!blob) return;
    const ext = docxBlob ? 'docx' : 'pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generatedFilename || `Generated_CV.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('CV téléchargé');
  };

  const handleDownloadPdf = () => {
    if (!pdfBlob) return;
    const filename = generatedFilename
      ? generatedFilename.replace(/\.docx$/, '.pdf')
      : 'Generated_CV.pdf';
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('PDF téléchargé');
  };

  const generationProgressLabel =
    elapsedSeconds < 5
      ? 'Préparation du modèle…'
      : elapsedSeconds < 20
        ? 'Remplissage des données employé…'
        : elapsedSeconds < 40
          ? 'Rendu du document…'
          : 'Finalisation — cela peut prendre jusqu\'à une minute au premier lancement…';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <ConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
        title="Supprimer le modèle"
        description="Ce modèle sera définitivement supprimé de votre historique. Les CV déjà générés avec ce modèle ne seront pas affectés."
        confirmLabel="Supprimer"
        onConfirm={handleDeleteHistoryConfirmed}
      />
      <div>
        <h1 className="text-2xl font-bold">Générer un CV</h1>
        <p className="text-muted-foreground">
          Importez un modèle de CV et sélectionnez un employé pour générer un CV formaté.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration du CV</CardTitle>
          <CardDescription>Sélectionnez un employé et importez un modèle (.docx ou .pdf).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Employee selector */}
          <div className="space-y-2">
            <Label htmlFor="employee-select">Employé</Label>
            {isLoadingEmployees ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Chargement des employés…
              </div>
            ) : employees.length === 0 ? (
              <div className="flex items-center gap-2 text-amber-600 text-sm">
                <AlertCircle className="h-4 w-4" />
                Aucun employé actif trouvé. Assurez-vous que les employés ont importé leur CV.
              </div>
            ) : (
              <Popover open={employeePopoverOpen} onOpenChange={setEmployeePopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={isGenerating}
                    className={cn(
                      'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
                      'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      !selectedEmployee && 'text-muted-foreground'
                    )}
                  >
                    {selectedEmployee
                      ? (() => {
                          const emp = employees.find(e => e.user_id === selectedEmployee);
                          return emp ? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.email) : 'Sélectionner un employé';
                        })()
                      : 'Sélectionner un employé'}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0" align="start">
                  <div className="p-2 border-b">
                    <Input
                      placeholder="Rechercher un employé..."
                      value={employeeSearch}
                      onChange={e => setEmployeeSearch(e.target.value)}
                      className="h-8"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    {employees
                      .filter(emp => {
                        const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').toLowerCase();
                        const email = (emp.email || '').toLowerCase();
                        const q = employeeSearch.toLowerCase();
                        return name.includes(q) || email.includes(q);
                      })
                      .map(emp => {
                        const label = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.email;
                        return (
                          <button
                            key={emp.user_id}
                            type="button"
                            className={cn(
                              'flex w-full items-center px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer',
                              selectedEmployee === emp.user_id && 'bg-accent font-medium'
                            )}
                            onClick={() => {
                              setSelectedEmployee(emp.user_id);
                              setEmployeeSearch('');
                              setEmployeePopoverOpen(false);
                              resetGeneration();
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    {employees.filter(emp => {
                      const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').toLowerCase();
                      const email = (emp.email || '').toLowerCase();
                      const q = employeeSearch.toLowerCase();
                      return name.includes(q) || email.includes(q);
                    }).length === 0 && (
                      <p className="px-3 py-4 text-sm text-muted-foreground text-center">Aucun résultat</p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* Engine selector */}
          <div className="space-y-2">
            <Label htmlFor="engine-select">Moteur de génération</Label>
            <Select
              value={engine}
              onValueChange={(v) => setEngine(v as Engine)}
              disabled={isGenerating}
            >
              <SelectTrigger id="engine-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fallback">
                  IA avancée — mappage intelligent des champs
                </SelectItem>
                <SelectItem value="primary">
                  Standard — rendu Jinja2 / placeholders
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {engine === 'fallback'
                ? isPdfTemplate
                  ? 'L\'IA avancée convertit le PDF en DOCX, réécrit les données personnelles via Groq + lxml, puis exporte en PDF.'
                  : 'L\'IA avancée réécrit le modèle en place via Groq + lxml. Idéal pour les modèles DOCX libres sans placeholders explicites.'
                : isPdfTemplate
                  ? 'Le mode standard superpose le texte directement sur le PDF en préservant la mise en page exacte.'
                  : 'Le mode standard rend les placeholders Jinja2 ({{name}}, {{email}}, …) dans les modèles DOCX.'}
            </p>
          </div>

          {/* Output language */}
          <div className="space-y-2">
            <Label htmlFor="language-select">Langue de sortie</Label>
            <Select value={language} onValueChange={(v) => setLanguage(v as Language)} disabled={isGenerating}>
              <SelectTrigger id="language-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="original">Original — pas de traduction</SelectItem>
                <SelectItem value="fr">Français — traduit en français</SelectItem>
                <SelectItem value="en">English — translated to English</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Recently used templates — bid manager's personal history. Picking
              a card here re-uses the stored file so they don't need to upload
              the same template every time. Empty on first use. */}
          {(historyLoading || historyTemplates.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Modèles récemment utilisés
                </Label>
                {!historyLoading && historyTemplates.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {historyTemplates.length} enregistré(s)
                  </span>
                )}
              </div>
              {historyLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" /> Chargement de vos modèles…
                </div>
              ) : (
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                  {historyTemplates.map((t) => {
                    const selected = selectedHistoryId === t.id;
                    const ext = (t.extension || 'docx').toUpperCase();
                    const langBadge = (t.language || 'orig').toUpperCase();
                    return (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => handleSelectHistory(t.id)}
                        disabled={isGenerating}
                        aria-pressed={selected}
                        className={cn(
                          'group relative flex-shrink-0 w-56 text-left rounded-lg border p-3 transition-all',
                          'hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/40',
                          selected
                            ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                            : 'border-muted bg-background',
                          isGenerating && 'opacity-60 cursor-not-allowed',
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <FileText
                            className={cn(
                              'h-7 w-7 shrink-0 mt-0.5',
                              ext === 'PDF' ? 'text-red-500' : 'text-blue-500',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm truncate" title={t.templateName}>
                              {t.templateName}
                            </div>
                            <div
                              className="text-[11px] text-muted-foreground truncate"
                              title={t.originalFilename || ''}
                            >
                              {t.originalFilename || '—'}
                            </div>
                            <div className="mt-1 flex items-center gap-1 flex-wrap">
                              <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                {ext}
                              </span>
                              <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                {langBadge}
                              </span>
                              {t.usageCount > 0 && (
                                <span className="text-[10px] text-muted-foreground">
                                  · {t.usageCount}× utilisé
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {formatRelativeTime(t.lastUsedAt)}
                            </div>
                          </div>
                        </div>
                        {selected && (
                          <Check className="absolute top-2 right-2 h-4 w-4 text-primary" />
                        )}
                        {!isGenerating && !selected && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Supprimer ${t.templateName} de l'historique`}
                            onClick={(e) => handleDeleteHistory(e as any, t.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.stopPropagation();
                                e.preventDefault();
                                handleDeleteHistory(e as any, t.id);
                              }
                            }}
                            className={cn(
                              'absolute top-1.5 right-1.5 inline-flex items-center justify-center h-6 w-6 rounded-md',
                              'opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity cursor-pointer',
                              deletingHistoryId === t.id && 'opacity-100',
                            )}
                          >
                            {deletingHistoryId === t.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Choisissez un modèle déjà utilisé, ou importez-en un nouveau ci-dessous.
              </p>
            </div>
          )}

          {/* Template upload */}
          <div className="space-y-2">
            <Label>{historyTemplates.length > 0 ? 'Ou importer un nouveau modèle' : 'Modèle de CV'}</Label>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload CV template"
              className={cn(
                'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
                isGenerating ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                templateFile ? 'border-primary bg-primary/5' : 'border-muted hover:border-primary/50',
              )}
              onClick={() => !isGenerating && fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (!isGenerating && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx,.pdf"
                className="hidden"
                onChange={handleFileChange}
                disabled={isGenerating}
              />
              {templateFile ? (
                <div className="flex items-center justify-center gap-3">
                  <Check className="h-5 w-5 text-primary shrink-0" />
                  <span className="font-medium truncate max-w-[280px]">{templateFile.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {(templateFile.size / 1024).toFixed(0)} KB
                  </span>
                  {!isGenerating && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearTemplate();
                      }}
                      aria-label="Remove template"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Cliquez pour importer un modèle de CV</p>
                  <p className="text-xs text-muted-foreground">
                    Formats acceptés : .docx et .pdf · Max 20 Mo
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Generate / Cancel button */}
          {isGenerating ? (
            <div className="space-y-2">
              <Button disabled className="w-full">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Génération… {elapsedSeconds}s
              </Button>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{generationProgressLabel}</span>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="underline hover:text-foreground"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <Button
              onClick={handleGenerate}
              disabled={!selectedEmployee || !hasTemplateSelection}
              className="w-full"
            >
              <FileOutput className="h-4 w-4 mr-2" />
              {selectedHistoryItem
                ? `Générer le CV avec "${selectedHistoryItem.templateName}"`
                : 'Générer le CV'}
            </Button>
          )}

          {/* Warnings banner — surfaces non-fatal issues from template
              analysis or from the engine (missing fields, undetected
              sections, unmapped placeholders). Only shown after a
              successful generation so it doesn't compete with errors. */}
          {warnings.length > 0 && !isGenerating && (docxBlob || pdfBlob) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-medium text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>Génération terminée avec {warnings.length} remarque{warnings.length === 1 ? '' : 's'}</span>
              </div>
              <ul className="space-y-1.5 text-xs text-amber-900 dark:text-amber-200">
                {warnings.map((w, idx) => (
                  <li key={`${w.code}-${idx}`} className="flex items-start gap-2">
                    {w.severity === 'warning' || w.severity === 'error' ? (
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                    ) : (
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
                    )}
                    <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Success state (when dialog is closed) */}
          {(docxBlob || pdfBlob) && !previewOpen && !isGenerating && (
            <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
              <div className="flex items-center gap-3 mb-3">
                <Check className="h-5 w-5 text-green-600" />
                <p className="font-medium text-green-700 dark:text-green-400">
                  CV généré avec succès
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                {pdfUrl && (
                  <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                    <Eye className="h-4 w-4 mr-1" />
                    Aperçu PDF
                  </Button>
                )}
                <Button size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Télécharger {docxBlob ? 'DOCX' : 'PDF'}
                </Button>
                {pdfBlob && docxBlob && (
                  <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
                    <Download className="h-4 w-4 mr-1" />
                    Télécharger PDF
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Info note */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-400">
              La structure visuelle du modèle (polices, couleurs, mise en page) est toujours préservée.
              Les deux moteurs supportent les modèles <strong>.docx</strong> et <strong>.pdf</strong>.{' '}
              <strong>L'IA avancée</strong> fonctionne sur tout modèle libre sans placeholders —
              elle détecte et remplace automatiquement les données personnelles.{' '}
              Le mode <strong>Standard</strong> nécessite des placeholders Jinja2 explicites comme{' '}
              <code>{'{{name}}'}</code>, <code>{'{{email}}'}</code> dans les modèles DOCX.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* PDF Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle>Aperçu du CV</DialogTitle>
            <DialogDescription>Vérifiez le CV généré avant de le télécharger.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 px-6 pb-2 overflow-hidden">
            {pdfUrl && !pdfError ? (
              <object
                data={pdfUrl}
                type="application/pdf"
                className="w-full h-full rounded-lg border"
                onError={() => setPdfError(true)}
              >
                <iframe src={pdfUrl} className="w-full h-full rounded-lg border" title="Aperçu du CV" />
              </object>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <FileWarning className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">Aperçu PDF non disponible</h3>
                <p className="text-muted-foreground mb-4 max-w-md">
                  L'aperçu PDF nécessite LibreOffice sur le serveur IA. Le fichier DOCX est prêt à télécharger.
                </p>
                <Button onClick={handleDownload} disabled={!docxBlob && !pdfBlob}>
                  <Download className="h-4 w-4 mr-2" />
                  Télécharger {docxBlob ? 'DOCX' : 'PDF'}
                </Button>
              </div>
            )}
          </div>

          <DialogFooter className="p-6 pt-2 border-t">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Fermer
            </Button>
            {pdfBlob && docxBlob && (
              <Button variant="outline" onClick={handleDownloadPdf}>
                <Download className="h-4 w-4 mr-2" />
                Télécharger PDF
              </Button>
            )}
            <Button onClick={handleDownload} disabled={!docxBlob && !pdfBlob}>
              <Download className="h-4 w-4 mr-2" />
              Télécharger {docxBlob ? 'DOCX' : 'PDF'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CVGenerationPage;
