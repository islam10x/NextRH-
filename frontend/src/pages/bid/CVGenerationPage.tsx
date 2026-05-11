import React, { useEffect, useState, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { FileOutput, Download, Loader2, Check, Eye, Settings2 } from 'lucide-react';
import api from '@/services/api';
import { bidService } from '@/services/bid.service';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CVTemplateSelector, CvTemplate, TemplateType, EngineMode } from '@/components/cv/CVTemplateSelector';

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
  const [employees, setEmployees] = useState<any[]>([]);
  const [templates, setTemplates] = useState<CvTemplate[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  
  // Selector states
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [selectedType, setSelectedType] = useState<TemplateType>('standard');
  const [language, setLanguage] = useState('');
  const [translateEnabled, setTranslateEnabled] = useState(true);
  const [engine, setEngine] = useState<EngineMode>('primary');
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);
  const [downloadLinks, setDownloadLinks] = useState<{ docx?: string; pdf?: string }>({});
  
  const [uploading, setUploading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [usersRes, templatesRes] = await Promise.all([api.get('/users'), api.get('/cv-templates')]);
        setEmployees(usersRes.data.filter((u: any) => u.role === 'employee'));
        setTemplates(templatesRes.data);
      } catch (err) {
        toast.error('Failed to load initial data');
      }
    };
    loadData();
  }, []);

  const handleGenerate = async () => {
    if (!selectedEmployee || !selectedTemplate) return;
    setIsGenerating(true);
    setIsGenerated(false);
    try {
      if (engine === 'primary') {
        const res = await api.post('/cv-generation', {
          employeeId: selectedEmployee,
          templateId: selectedTemplate,
          language: language || undefined,
          translate: translateEnabled,
          outputFormats: ['docx', 'pdf'],
        });
        setDownloadLinks({
          docx: res.data.downloadDocxUrl,
          pdf: res.data.downloadPdfUrl,
        });
      } else {
        // Fallback engine path (returns blobs)
        const [docxBlob, pdfBlob] = await Promise.all([
          bidService.generateCvFromStored(selectedTemplate, selectedEmployee, 'docx', 'fallback'),
          bidService.generateCvFromStored(selectedTemplate, selectedEmployee, 'pdf', 'fallback'),
        ]);
        
        // Convert blobs to local URLs for this session
        const docxUrl = URL.createObjectURL(docxBlob);
        const pdfUrl = URL.createObjectURL(pdfBlob);
        
        setDownloadLinks({
          docx: docxUrl,
          pdf: pdfUrl,
        });
      }
      
      setIsGenerated(true);
      toast.success(engine === 'primary' ? 'Standard engine generated CV' : 'Advanced AI engine generated CV successfully');
    } catch {
      toast.error('Generation failed');
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('templateName', file.name.replace(/\.(docx|pdf)$/i, ''));
      formData.append('templateType', selectedType);
      
      const res = await api.post('/cv-templates', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setTemplates((prev) => [res.data as CvTemplate, ...prev]);
      toast.success('Template added to system');
    } catch {
      toast.error('Failed to upload template');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDownload = (type: 'docx' | 'pdf') => {
    const url = type === 'pdf' ? downloadLinks.pdf : downloadLinks.docx;
    if (!url) return;
    
    if (engine === 'fallback') {
      // Fallback URLs are local blobs
      const a = document.createElement('a');
      a.href = url;
      a.download = `cv_${selectedEmployee}.${type}`;
      a.click();
    } else {
      // Primary URLs are backend endpoints
      window.open(`${api.defaults.baseURL}${url}`);
    }
  };

  useEffect(() => {
    if (previewOpen && downloadLinks.docx) {
      setPreviewLoading(true);
      const url = engine === 'primary' ? `${api.defaults.baseURL}${downloadLinks.docx}` : downloadLinks.docx;
      
      const fetchBlob = engine === 'primary' 
        ? api.get(downloadLinks.docx, { responseType: 'blob' }).then(res => res.data)
        : fetch(downloadLinks.docx).then(res => res.blob());

      fetchBlob.then(blob => {
        import('docx-preview').then(({ renderAsync }) => {
          if (previewContainerRef.current) {
            previewContainerRef.current.innerHTML = '';
            renderAsync(blob, previewContainerRef.current).finally(() => setPreviewLoading(false));
          }
        });
      });
    }
  }, [previewOpen, downloadLinks.docx, engine]);

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-20">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">CV Generation Center</h1>
          <p className="text-muted-foreground mt-1 text-sm">Select an employee and a template to generate a professional resume.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-8 space-y-6">
          <Card className="shadow-lg border-primary/10">
            <CardHeader className="bg-muted/30 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-primary" />
                Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-3">
                <Label className="text-base font-bold">Target Employee</Label>
                <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                  <SelectTrigger className="h-12 border-primary/20 bg-background transition-all hover:border-primary/40 text-sm">
                    <SelectValue placeholder="Select a team member" />
                  </SelectTrigger>
                  <SelectContent>
                    {employees.map((emp) => (
                      <SelectItem key={emp.user_id} value={emp.user_id} className="text-sm">
                        {`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <CVTemplateSelector 
                templates={templates}
                selectedTemplate={selectedTemplate}
                onTemplateChange={setSelectedTemplate}
                selectedType={selectedType}
                onTypeChange={setSelectedType}
                language={language}
                onLanguageChange={setLanguage}
                translateEnabled={translateEnabled}
                onTranslateChange={setTranslateEnabled}
                engine={engine}
                onEngineChange={setEngine}
                onGenerate={handleGenerate}
                isGenerating={isGenerating}
              />
            </CardContent>
          </Card>

          {isGenerated && (
            <Card className="border-success/30 bg-success/5 animate-in slide-in-from-top-4 duration-500">
               <CardContent className="pt-6 space-y-4">
                  <div className="flex items-center gap-3 text-success">
                    <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
                      <Check className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-bold text-base">Document Ready</p>
                      <p className="text-[10px] text-success/80">
                        Generated using {engine === 'fallback' ? 'Advanced AI Engine (Fallback)' : 'Standard Engine'}.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)} className="bg-background shadow-sm h-10 px-4">
                      <Eye className="h-4 w-4 mr-2" /> Live Preview
                    </Button>
                    {downloadLinks.pdf && (
                      <Button size="sm" onClick={() => handleDownload('pdf')} className="h-10 px-4 shadow-lg shadow-primary/20">
                        <Download className="h-4 w-4 mr-2" /> Download PDF
                      </Button>
                    )}
                    {downloadLinks.docx && (
                      <Button variant="secondary" size="sm" onClick={() => handleDownload('docx')} className="h-10 px-4">
                        <Download className="h-4 w-4 mr-2" /> Download DOCX
                      </Button>
                    )}
                  </div>
               </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-8">
          <Card className="border-dashed border-2 bg-muted/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Admin Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase">Upload Template (.docx, .pdf)</Label>
                <Input type="file" accept=".docx,.pdf" onChange={handleTemplateUpload} disabled={uploading} className="h-10 text-sm border-primary/10 file:text-xs file:font-bold" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  New DOCX or PDF templates will appear in the "Specific Design" dropdown.
                </p>
              </div>
              <div className="pt-4 border-t space-y-3">
                 <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Quick Guidelines</h4>
                 <ul className="space-y-2">
                   <li className="flex gap-2 text-sm text-muted-foreground items-start">
                     <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                     Verify employee data in Directory before generating.
                   </li>
                   <li className="flex gap-2 text-sm text-muted-foreground items-start">
                     <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                     Fallback engine (AI) is optimized for RPF compliance.
                   </li>
                 </ul>
              </div>
            </CardContent>
          </Card>

          <div className="p-5 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 space-y-2">
            <h4 className="font-bold text-sm text-primary flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              Batch Production
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              For mass production of CVs for a specific bid, ensure you have verified the "Format Style" requirements first.
            </p>
          </div>
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl w-[95vw] h-[85vh] flex flex-col p-4 sm:p-6 pb-2">
          <DialogHeader className="mb-2">
            <DialogTitle>Live CV Preview</DialogTitle>
            <DialogDescription className="sr-only">Interactive CV previewer</DialogDescription>
          </DialogHeader>
          <div className="relative flex-1 overflow-auto bg-[#e5e5e5] rounded-md border p-6 flex justify-center custom-scrollbar">
            {previewLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10 rounded-md">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            )}
            <div
              ref={previewContainerRef}
              className="w-full max-w-[850px] min-h-full shadow-2xl bg-white select-text h-fit"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CVGenerationPage;
