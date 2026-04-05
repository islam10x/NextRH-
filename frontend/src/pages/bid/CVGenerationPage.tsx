import React, { useEffect, useMemo, useState, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { FileOutput, Download, Loader2, Check, Search, Eye } from 'lucide-react';
import api from '@/services/api';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type TemplateType = 'standard' | 'canadian' | 'eu' | 'client_specific';

interface CvTemplate {
  id: string;
  templateName: string;
  templateType: TemplateType;
  language?: string | null;
  createdAt?: string;
}

interface UserListItem {
  user_id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  role: string;
}

interface GenerateResponse {
  id: string;
  downloadDocxUrl: string;
  downloadPdfUrl?: string | null;
}

const templateTypeLabels: Record<TemplateType, string> = {
  standard: 'Standard',
  canadian: 'Canadian',
  eu: 'EU Europass',
  client_specific: 'Client Specific',
};

const templateTypeOptions: { value: TemplateType; label: string; desc: string }[] = [
  { value: 'standard', label: 'Standard', desc: 'Default professional format' },
  { value: 'canadian', label: 'Canadian', desc: 'Canadian government format' },
  { value: 'eu', label: 'EU Europass', desc: 'European standard format' },
  { value: 'client_specific', label: 'Client Specific', desc: 'Custom client template' },
];

const CVGenerationPage: React.FC = () => {
  const [employees, setEmployees] = useState<UserListItem[]>([]);
  const [templates, setTemplates] = useState<CvTemplate[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [selectedTemplateType, setSelectedTemplateType] = useState<TemplateType>('standard');
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [translateEnabled, setTranslateEnabled] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);
  const [downloadLinks, setDownloadLinks] = useState<{ docx?: string; pdf?: string }>({});
  const [generationPurpose, setGenerationPurpose] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [uploading, setUploading] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previewOpen && downloadLinks.docx) {
      setPreviewLoading(true);
      setTimeout(() => {
        api
          .get(downloadLinks.docx!, { responseType: 'blob' })
          .then((res) => {
            import('docx-preview')
              .then(({ renderAsync }) => {
                if (previewContainerRef.current) {
                  previewContainerRef.current.innerHTML = '';
                  renderAsync(res.data, previewContainerRef.current).finally(() => setPreviewLoading(false));
                } else {
                  setPreviewLoading(false);
                }
              })
              .catch(() => setPreviewLoading(false));
          })
          .catch(() => {
            toast.error('Preview failed to load');
            setPreviewLoading(false);
          });
      }, 50);
    }
  }, [previewOpen, downloadLinks.docx]);

  useEffect(() => {
    const load = async () => {
      try {
        const [usersRes, templatesRes] = await Promise.all([api.get('/users'), api.get('/cv-templates')]);
        const users = (usersRes.data as UserListItem[]).filter((u) => u.role === 'employee');
        setEmployees(users);
        setTemplates(templatesRes.data as CvTemplate[]);
      } catch (err) {
        toast.error('Failed to load templates or employees');
      }
    };
    load();
  }, []);

  useEffect(() => {
    const template = templates.find((t) => t.id === selectedTemplate);
    if (template?.language) {
      setSelectedLanguage(template.language);
    }
  }, [selectedTemplate, templates]);

  const filteredTemplates = useMemo(() => {
    const byType = templates.filter((t) => t.templateType === selectedTemplateType);
    if (byType.length > 0) {
      return { list: byType, showingAll: false };
    }
    return { list: templates, showingAll: true };
  }, [templates, selectedTemplateType]);

  useEffect(() => {
    if (!selectedTemplate) return;
    const template = templates.find((t) => t.id === selectedTemplate);
    if (!template) return;
    const typeTemplates = templates.filter((t) => t.templateType === selectedTemplateType);
    if (typeTemplates.length > 0 && template.templateType !== selectedTemplateType) {
      setSelectedTemplate('');
    }
  }, [selectedTemplateType, selectedTemplate, templates]);

  const selectedTemplateLabel = useMemo(() => {
    const template = templates.find((t) => t.id === selectedTemplate);
    if (!template) return '';
    return `${template.templateName} - ${templateTypeLabels[template.templateType]}`;
  }, [selectedTemplate, templates]);

  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('templateName', file.name.replace(/\.(docx|pdf)$/i, ''));
      formData.append('templateType', selectedTemplateType);
      if (selectedLanguage) {
        formData.append('language', selectedLanguage);
      }
      const res = await api.post('/cv-templates', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setTemplates((prev) => [res.data as CvTemplate, ...prev]);
      toast.success('Template uploaded');
    } catch {
      toast.error('Template upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDownload = async (url: string, fallbackFilename: string) => {
    try {
      const res = await api.get(url, { responseType: 'blob' });
      const disposition = res.headers['content-disposition'];
      let filename = fallbackFilename;
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match?.[1]) filename = match[1];
      }
      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast.error('Download failed');
    }
  };

  const handleGenerate = async () => {
    if (!selectedEmployee || !selectedTemplate) return;
    setIsGenerating(true);
    setIsGenerated(false);
    setDownloadLinks({});
    try {
      const res = await api.post<GenerateResponse>('/cv-generation', {
        employeeId: selectedEmployee,
        templateId: selectedTemplate,
        language: selectedLanguage || undefined,
        translate: translateEnabled,
        outputFormats: ['docx', 'pdf'],
        generationPurpose: generationPurpose || undefined,
      });
      const data = res.data;
      setDownloadLinks({
        docx: data.downloadDocxUrl || undefined,
        pdf: data.downloadPdfUrl || undefined,
      });
      setIsGenerated(true);
      toast.success('CV generated successfully');
    } catch {
      toast.error('CV generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAnalyzeTemplate = async () => {
    if (!selectedTemplate) return;
    setAnalyzing(true);
    setAnalysisResult(null);
    try {
      const res = await api.post(`/cv-templates/${selectedTemplate}/analyze`);
      setAnalysisResult(res.data);
      toast.success(`Template analyzed: ${res.data.total_count} fields found, ${res.data.unmapped_count} unmapped`);
    } catch {
      toast.error('Template analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleReplicateTemplate = async () => {
    if (!selectedTemplate) return;
    const template = templates.find((t) => t.id === selectedTemplate);
    if (!template) return;
    try {
      const res = await api.post(`/cv-templates/${template.id}/replicate`, {
        templateName: `${template.templateName} Copy`,
        templateType: template.templateType,
        language: template.language || undefined,
      });
      setTemplates((prev) => [res.data as CvTemplate, ...prev]);
      toast.success('Template replicated');
    } catch {
      toast.error('Template replication failed');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Generate CV</h1>
        <p className="text-muted-foreground">Create formatted CVs for bids and proposals</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>CV Configuration</CardTitle>
          <CardDescription>Select employee, template, and generation options</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Select Employee</Label>
            <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an employee" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((emp) => (
                  <SelectItem key={emp.user_id} value={emp.user_id}>
                    {`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Template Type</Label>
            <div className="grid grid-cols-2 gap-3">
              {templateTypeOptions.map((option) => (
                <div
                  key={option.value}
                  className={cn(
                    'p-4 rounded-lg border-2 cursor-pointer transition-all',
                    selectedTemplateType === option.value
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-primary/50'
                  )}
                  onClick={() => setSelectedTemplateType(option.value)}
                >
                  <p className="font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">{option.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Template</Label>
            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {filteredTemplates.list.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id}>
                    {tpl.templateName} - {templateTypeLabels[tpl.templateType]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplateLabel && (
              <p className="text-xs text-muted-foreground">Selected: {selectedTemplateLabel}</p>
            )}
            {filteredTemplates.showingAll && (
              <p className="text-xs text-muted-foreground">
                No templates found for {templateTypeLabels[selectedTemplateType]}; showing all templates.
              </p>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!selectedTemplate} onClick={handleReplicateTemplate}>
                Duplicate Template
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!selectedTemplate || analyzing}
                onClick={handleAnalyzeTemplate}
              >
                {analyzing ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />Analyzing...
                  </>
                ) : (
                  <>
                    <Search className="h-3 w-3 mr-1" />Analyze Fields
                  </>
                )}
              </Button>
            </div>
          </div>

          {analysisResult && (
            <div className="p-3 rounded-lg bg-muted border text-sm">
              <p className="font-medium mb-2">Template Analysis: {analysisResult.total_count} fields found</p>
              <div className="grid grid-cols-1 gap-1 max-h-40 overflow-y-auto">
                {analysisResult.fields?.map((f: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${f.mapped_to ? 'bg-green-500' : 'bg-red-400'}`}
                    />
                    <span className="font-mono">{f.name}</span>
                    <span className="text-muted-foreground">-&gt; {f.mapped_to || 'unmapped'}</span>
                    <span className="text-muted-foreground/60">({f.source})</span>
                  </div>
                ))}
              </div>
              {analysisResult.unmapped_count > 0 && (
                <p className="text-xs text-amber-500 mt-2">
                  {analysisResult.unmapped_count} fields could not be mapped automatically
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Template Upload (DOCX or Fillable PDF)</Label>
            <Input type="file" accept=".docx,.pdf" onChange={handleTemplateUpload} disabled={uploading} />
            <p className="text-xs text-muted-foreground">
              DOCX templates support rich layouts. PDF templates must include form fields.
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Generation Purpose (optional)</Label>
              <Input
                placeholder="e.g., Bid proposal, Client submission"
                value={generationPurpose}
                onChange={(e) => setGenerationPurpose(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Target Language</Label>
              <Select value={selectedLanguage || 'none'} onValueChange={(val) => setSelectedLanguage(val === 'none' ? '' : val)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Keep Original Language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Keep Original Language</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="de">German</SelectItem>
                  <SelectItem value="nl">Dutch</SelectItem>
                  <SelectItem value="it">Italian</SelectItem>
                  <SelectItem value="ar">Arabic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label>Translate content</Label>
              <Switch checked={translateEnabled} onCheckedChange={setTranslateEnabled} />
            </div>
          </div>

          {isGenerated && (
            <div className="p-4 rounded-lg bg-success/10 border border-success/20">
              <div className="flex items-center gap-3 mb-3">
                <Check className="h-5 w-5 text-success" />
                <p className="font-medium text-success">CV Generated Successfully</p>
              </div>
              <div className="flex gap-2 mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!downloadLinks.docx}
                  onClick={() => setPreviewOpen(true)}
                  className="mr-auto border border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary"
                >
                  <Eye className="h-4 w-4 mr-1" /> Live Preview
                </Button>
                <Button size="sm" disabled={!downloadLinks.pdf} onClick={() => downloadLinks.pdf && handleDownload(downloadLinks.pdf, 'cv.pdf')}>
                  <Download className="h-4 w-4 mr-1" />Download PDF
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!downloadLinks.docx}
                  onClick={() => downloadLinks.docx && handleDownload(downloadLinks.docx, 'cv.docx')}
                >
                  <Download className="h-4 w-4 mr-1" />Download DOCX
                </Button>
              </div>
            </div>
          )}

          <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
            <DialogContent className="max-w-4xl w-[95vw] h-[85vh] flex flex-col p-4 sm:p-6 pb-2">
              <DialogHeader className="mb-2">
                <DialogTitle>CV Preview Document</DialogTitle>
                <DialogDescription className="sr-only">Interactive CV viewer</DialogDescription>
              </DialogHeader>
              <div className="relative flex-1 overflow-auto bg-[#e5e5e5] rounded-md border p-4 sm:p-8 flex justify-center custom-scrollbar">
                {previewLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10 rounded-md">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                )}
                <div
                  ref={previewContainerRef}
                  className="w-full max-w-[850px] min-h-full shadow-lg bg-white select-text"
                  style={{ pointerEvents: previewLoading ? 'none' : 'auto' }}
                />
              </div>
            </DialogContent>
          </Dialog>

          <Button onClick={handleGenerate} disabled={!selectedEmployee || !selectedTemplate || isGenerating} className="w-full">
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...
              </>
            ) : (
              <>
                <FileOutput className="h-4 w-4 mr-2" />Generate CV
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default CVGenerationPage;
