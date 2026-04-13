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
  FileOutput, Download, Loader2, Check, Upload, AlertCircle, Eye, X,
  FileWarning,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import api from '@/services/api';
import { bidService } from '@/services/bid.service';

interface DBUser {
  user_id: string;
  email: string;
  role: string;
  status: string;
  firstName?: string;
  lastName?: string;
}

const CVGenerationPage: React.FC = () => {
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [employees, setEmployees] = useState<DBUser[]>([]);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Generated files
  const [docxBlob, setDocxBlob] = useState<Blob | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [generatedFilename, setGeneratedFilename] = useState('');
  
  // Preview dialog
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // Load employees
  useEffect(() => {
    const fetchEmployees = async () => {
      try {
        const response = await api.get<DBUser[]>('/users');
        const active = response.data.filter(
          (u) => u.status === 'active' && u.role === 'employee',
        );
        setEmployees(active);
      } catch {
        toast.error('Failed to load employees');
      } finally {
        setIsLoadingEmployees(false);
      }
    };
    fetchEmployees();
  }, []);

  const resetGeneration = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setDocxBlob(null);
    setPdfBlob(null);
    setPdfUrl(null);
    setPdfError(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Only allow .docx for reliable processing
    const allowed = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.type)) {
      toast.error('Please upload a .docx file. PDF templates are not supported.');
      return;
    }

    // Warn on large files (>20 MB)
    const MAX_SIZE = 20 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      toast.error(`Template is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`);
      return;
    }

    setTemplateFile(file);
    resetGeneration();
  };

  const handleGenerate = async () => {
    if (!selectedEmployee || !templateFile) {
      toast.error('Please select an employee and upload a template.');
      return;
    }
    setIsGenerating(true);
    resetGeneration();

    try {
      const emp = employees.find((e) => e.user_id === selectedEmployee);
      const empName = emp
        ? [emp.firstName, emp.lastName].filter(Boolean).join('_') || 'Employee'
        : 'Employee';

      // Generate DOCX for download and try PDF for preview in parallel
      const [docx, pdf] = await Promise.allSettled([
        bidService.generateCv(selectedEmployee, templateFile, 'docx'),
        bidService.generateCv(selectedEmployee, templateFile, 'pdf'),
      ]);

      // Handle DOCX result
      if (docx.status === 'fulfilled') {
        setDocxBlob(docx.value);
        setGeneratedFilename(`${empName}_CV.docx`);
      } else {
        const reason = docx.reason?.response?.data
          ? await docx.reason.response.data.text?.() || docx.reason.message
          : docx.reason?.message || 'Generation failed';
        throw new Error(reason);
      }

      // Handle PDF result (for preview — not critical)
      if (pdf.status === 'fulfilled' && pdf.value.type === 'application/pdf') {
        setPdfBlob(pdf.value);
        const url = URL.createObjectURL(pdf.value);
        setPdfUrl(url);
        setPdfError(false);
      } else {
        // PDF conversion not available - will show DOCX download only
        setPdfError(true);
      }

      setPreviewOpen(true);
      toast.success('CV generated successfully');
    } catch (err: any) {
      const message = err?.response?.data?.message || err?.message || 'Generation failed';
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!docxBlob) return;
    const url = URL.createObjectURL(docxBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generatedFilename || 'Generated_CV.docx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('CV downloaded');
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Generate CV</h1>
        <p className="text-muted-foreground">
          Upload a CV template and select an employee to generate a formatted CV
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>CV Configuration</CardTitle>
          <CardDescription>Select employee and upload a template CV (.docx format)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Employee selector */}
          <div className="space-y-2">
            <Label>Select Employee</Label>
            {isLoadingEmployees ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading employees...
              </div>
            ) : employees.length === 0 ? (
              <div className="flex items-center gap-2 text-amber-600 text-sm">
                <AlertCircle className="h-4 w-4" /> No active employees found. Ensure employees have uploaded their CV.
              </div>
            ) : (
              <Select
                value={selectedEmployee}
                onValueChange={(v) => {
                  setSelectedEmployee(v);
                  resetGeneration();
                }}
              >
                <SelectTrigger>
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

          {/* Template upload */}
          <div className="space-y-2">
            <Label>CV Template (.docx only)</Label>
            <div
              className={cn(
                'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors',
                templateFile ? 'border-primary bg-primary/5' : 'border-muted hover:border-primary/50',
              )}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={handleFileChange}
              />
              {templateFile ? (
                <div className="flex items-center justify-center gap-2">
                  <Check className="h-5 w-5 text-primary" />
                  <span className="font-medium">{templateFile.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ({(templateFile.size / 1024).toFixed(0)} KB)
                  </span>
                </div>
              ) : (
                <div className="space-y-1">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Click to upload a CV template</p>
                  <p className="text-xs text-muted-foreground">
                    Supports .docx format for reliable template processing
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Generate button */}
          <Button
            onClick={handleGenerate}
            disabled={!selectedEmployee || !templateFile || isGenerating}
            className="w-full"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <FileOutput className="h-4 w-4 mr-2" />
                Generate CV
              </>
            )}
          </Button>

          {/* Success state (when dialog is closed) */}
          {docxBlob && !previewOpen && (
            <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
              <div className="flex items-center gap-3 mb-3">
                <Check className="h-5 w-5 text-green-600" />
                <p className="font-medium text-green-700 dark:text-green-400">
                  CV Generated Successfully
                </p>
              </div>
              <div className="flex gap-2">
                {pdfUrl && (
                  <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                    <Eye className="h-4 w-4 mr-1" />
                    Preview PDF
                  </Button>
                )}
                <Button size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Download DOCX
                </Button>
              </div>
            </div>
          )}

          {/* Info note */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-400">
              The template's visual structure (fonts, colors, layout) will be preserved.
              Personal data (name, email, phone, experience, etc.) will be replaced with
              the selected employee's information. Use placeholders like {'{{name}}'}, {'{{email}}'} 
              in your template for best results.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* PDF Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle>CV Preview</DialogTitle>
            <DialogDescription>
              Review the generated CV before downloading
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 px-6 pb-2 overflow-hidden">
            {pdfUrl && !pdfError ? (
              <object
                data={pdfUrl}
                type="application/pdf"
                className="w-full h-full rounded-lg border"
                onError={() => setPdfError(true)}
              >
                {/* Fallback for browsers that don't support object */}
                <iframe
                  src={pdfUrl}
                  className="w-full h-full rounded-lg border"
                  title="CV Preview"
                />
              </object>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <FileWarning className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">PDF Preview Not Available</h3>
                <p className="text-muted-foreground mb-4 max-w-md">
                  PDF preview requires LibreOffice installed on the server.
                  You can still download the DOCX file directly.
                </p>
                <Button onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-2" />
                  Download DOCX
                </Button>
              </div>
            )}
          </div>

          <DialogFooter className="p-6 pt-2 border-t">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
            <Button onClick={handleDownload} disabled={!docxBlob}>
              <Download className="h-4 w-4 mr-2" />
              Download DOCX
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CVGenerationPage;
