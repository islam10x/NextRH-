import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  FileWarning, X, Info, AlertTriangle, FileText, Clock, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import api from '@/services/api';
import { bidService, type CvWarning, type MyTemplateHistoryItem } from '@/services/bid.service';

interface DBUser {
  user_id: string;
  email: string;
  role: string;
  status: string;
  firstName?: string;
  lastName?: string;
}

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
  if (!iso) return 'Never used';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never used';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)} wk ago`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)} mo ago`;
  return `${Math.floor(diffDay / 365)} yr ago`;
};

const CVGenerationPage: React.FC = () => {
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [employees, setEmployees] = useState<DBUser[]>([]);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<Language>('original');
  const [engine, setEngine] = useState<Engine>('fallback');
  const [isGenerating, setIsGenerating] = useState(false);

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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedHistoryItem =
    historyTemplates.find((t) => t.id === selectedHistoryId) || null;
  const isPdfTemplate =
    (templateFile && templateFile.name.toLowerCase().endsWith('.pdf')) ||
    (!!selectedHistoryItem && selectedHistoryItem.extension === 'pdf');
  const hasTemplateSelection = !!templateFile || !!selectedHistoryItem;


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
        const response = await api.get<DBUser[]>('/users');
        if (cancelled) return;
        const active = response.data.filter(
          (u) => u.status === 'active' && u.role === 'employee',
        );
        setEmployees(active);
      } catch {
        if (!cancelled) toast.error('Failed to load employees');
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
    console.log("File change triggered", file?.name);
    // Reset the input so re-uploading the same file fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    if (!ALLOWED_MIMES.has(file.type)) {
      toast.error('Please upload a .docx or .pdf file.');
      return;
    }
    if (file.size > MAX_TEMPLATE_BYTES) {
      toast.error(
        `Template is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB.`,
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

  const handleDeleteHistory = async (
    e: React.MouseEvent<HTMLButtonElement>,
    templateId: string,
  ) => {
    e.stopPropagation();
    if (deletingHistoryId) return;
    setDeletingHistoryId(templateId);
    try {
      await bidService.deleteMyTemplate(templateId);
      setHistoryTemplates((prev) => prev.filter((t) => t.id !== templateId));
      if (selectedHistoryId === templateId) {
        setSelectedHistoryId(null);
        resetGeneration();
      }
      toast.success('Template removed from your history');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to remove template');
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleGenerate = async () => {
    if (!selectedEmployee || !hasTemplateSelection) {
      toast.error('Please select an employee and choose or upload a template.');
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
      toast.success('CV generated successfully');
      // Reflect the new last-used timestamp / usage count + surface any
      // newly-auto-saved upload in the recent-templates row.
      refreshHistory();
    } catch (err: any) {
      if (controller.signal.aborted) {
        toast.info('Generation cancelled');
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
    toast.success('CV downloaded');
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
    toast.success('PDF downloaded');
  };

  const generationProgressLabel = 'Processing CV generation...';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />
      <div>
        <h1 className="text-2xl font-bold">Generate CV</h1>
        <p className="text-muted-foreground">
          Upload a CV template and select an employee to generate a formatted CV.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>CV Configuration</CardTitle>
          <CardDescription>Select an employee and upload a template (.docx or .pdf).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Employee selector */}
          <div className="space-y-2">
            <Label htmlFor="employee-select">Employee</Label>
            {isLoadingEmployees ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4" /> Loading employees…
              </div>
            ) : employees.length === 0 ? (
              <div className="flex items-center gap-2 text-amber-600 text-sm">
                <AlertCircle className="h-4 w-4" />
                No active employees found. Ensure employees have uploaded their CV.
              </div>
            ) : (
              <Select
                value={selectedEmployee}
                onValueChange={(v) => {
                  setSelectedEmployee(v);
                  resetGeneration();
                }}
                disabled={isGenerating}
              >
                <SelectTrigger id="employee-select">
                  <SelectValue placeholder="Choose an employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((emp) => (
                    <SelectItem key={emp.user_id} value={emp.user_id}>
                      {[emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Engine selector */}
          <div className="space-y-2">
            <Label htmlFor="engine-select">Generation Engine</Label>
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
                  Advanced AI — intelligent field mapping
                </SelectItem>
                <SelectItem value="primary">
                  Standard — Jinja2 / placeholder rendering
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {engine === 'fallback'
                ? isPdfTemplate
                  ? 'Advanced AI converts the PDF to DOCX, rewrites personal data in-place using Groq + lxml, then exports to PDF.'
                  : 'Advanced AI rewrites the template in-place using Groq + lxml. Best for free-form DOCX templates without explicit placeholders.'
                : isPdfTemplate
                  ? 'Standard overlays text directly onto the PDF, preserving the original layout exactly.'
                  : 'Standard renders Jinja2 placeholders ({{name}}, {{email}}, …) in DOCX templates.'}
            </p>
          </div>

          {/* Output language */}
          <div className="space-y-2">
            <Label htmlFor="language-select">Output Language</Label>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as Language)}
              disabled={isGenerating}
            >
              <SelectTrigger id="language-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">Original — no translation</SelectItem>
                <SelectItem value="en">English — translate to English</SelectItem>
                <SelectItem value="fr">French — translate to French</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {language === 'original'
                ? 'Content will be kept as-is from the employee profile.'
                : `All CV content will be translated to ${language === 'fr' ? 'French' : 'English'}.`}
            </p>
          </div>

          {/* Recently used templates — bid manager's personal history. Picking
              a card here re-uses the stored file so they don't need to upload
              the same template every time. Empty on first use. */}
          {(historyLoading || historyTemplates.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Recently used templates
                </Label>
                {!historyLoading && historyTemplates.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {historyTemplates.length} saved
                  </span>
                )}
              </div>
              {historyLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4" /> Loading your templates…
                </div>
              ) : (
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                  {historyTemplates.map((t) => {
                    const selected = selectedHistoryId === t.id;
                    const ext = (t.extension || 'docx').toUpperCase();
                    const langBadge = (t.language || 'orig').toUpperCase();
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={t.id}
                        onClick={() => handleSelectHistory(t.id)}
                        onKeyDown={(e) => {
                          if (!isGenerating && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            handleSelectHistory(t.id);
                          }
                        }}
                        aria-pressed={selected}
                        className={cn(
                          'group relative flex-shrink-0 w-56 text-left rounded-lg border p-3 transition-all',
                          'hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/40',
                          selected
                            ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                            : 'border-muted bg-background',
                          isGenerating ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
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
                                  · {t.usageCount}× used
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
                            aria-label={`Remove ${t.templateName} from history`}
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
                              <Loader2 className="h-3.5 w-3.5" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Pick a template you've used before, or upload a new one below.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              {historyTemplates.length > 0 ? 'Or upload a new template' : 'CV Template'}
            </p>
            <div
              className={cn(
                'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
                templateFile ? 'border-primary bg-primary/5' : 'border-muted',
              )}
            >
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
                      onClick={clearTemplate}
                      aria-label="Remove template"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Select a .docx or .pdf template</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isGenerating}
                  >
                    Choose File
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Generate / Cancel button */}
          {isGenerating ? (
            <div className="space-y-2">
              <Button disabled className="w-full">
                <Loader2 className="h-4 w-4 mr-2" />
                Generating…
              </Button>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{generationProgressLabel}</span>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="underline hover:text-foreground"
                >
                  Cancel
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
                ? `Generate CV from "${selectedHistoryItem.templateName}"`
                : 'Generate CV'}
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
                <span>Generation completed with {warnings.length} note{warnings.length === 1 ? '' : 's'}</span>
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
                  CV generated successfully
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                {pdfUrl && (
                  <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                    <Eye className="h-4 w-4 mr-1" />
                    Preview PDF
                  </Button>
                )}
                <Button size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Download {docxBlob ? 'DOCX' : 'PDF'}
                </Button>
                {pdfBlob && docxBlob && (
                  <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
                    <Download className="h-4 w-4 mr-1" />
                    Download PDF
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Info note */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-400">
              The template's visual structure (fonts, colors, layout) is always preserved.
              Both engines support <strong>.docx</strong> and <strong>.pdf</strong> templates.{' '}
              <strong>Advanced AI</strong> works on any free-form template without placeholders —
              it detects and replaces personal data automatically.{' '}
              <strong>Standard</strong> requires explicit Jinja2 placeholders like{' '}
              <code>{'{{name}}'}</code>, <code>{'{{email}}'}</code> in DOCX templates, or renders
              directly onto PDF form fields.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* PDF Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle>CV Preview</DialogTitle>
            <DialogDescription>Review the generated CV before downloading.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 px-6 pb-2 overflow-hidden">
            {pdfUrl && !pdfError ? (
              <object
                data={pdfUrl}
                type="application/pdf"
                className="w-full h-full rounded-lg border"
                onError={() => setPdfError(true)}
              >
                <iframe src={pdfUrl} className="w-full h-full rounded-lg border" title="CV Preview" />
              </object>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <FileWarning className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">PDF Preview Not Available</h3>
                <p className="text-muted-foreground mb-4 max-w-md">
                  PDF preview requires LibreOffice on the AI service host. The DOCX file is ready
                  to download.
                </p>
                <Button onClick={handleDownload} disabled={!docxBlob && !pdfBlob}>
                  <Download className="h-4 w-4 mr-2" />
                  Download {docxBlob ? 'DOCX' : 'PDF'}
                </Button>
              </div>
            )}
          </div>

          <DialogFooter className="p-6 pt-2 border-t">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
            {pdfBlob && docxBlob && (
              <Button variant="outline" onClick={handleDownloadPdf}>
                <Download className="h-4 w-4 mr-2" />
                Download PDF
              </Button>
            )}
            <Button onClick={handleDownload} disabled={!docxBlob && !pdfBlob}>
              <Download className="h-4 w-4 mr-2" />
              Download {docxBlob ? 'DOCX' : 'PDF'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CVGenerationPage;
