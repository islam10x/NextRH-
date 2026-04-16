import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { FileUp, FileText, CheckCircle2, AlertCircle, Loader2, X } from 'lucide-react';
import api from '@/services/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface CVUploadZoneProps {
  onUploadComplete?: (data: any) => void;
  className?: string;
}

export const CVUploadZone: React.FC<CVUploadZoneProps> = ({ onUploadComplete, className }) => {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setStatus('idle');
      setProgress(0);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    multiple: false,
    disabled: uploading,
  });

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setStatus('uploading');
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await api.post('/cv/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 100));
          setProgress(percentCompleted);
        },
      });

      setStatus('success');
      toast.success('CV uploaded and parsed successfully');
      if (onUploadComplete) {
        onUploadComplete(response.data);
      }
    } catch (err) {
      setStatus('error');
      toast.error('Failed to upload CV. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const clearFile = () => {
    setFile(null);
    setStatus('idle');
    setProgress(0);
  };

  return (
    <div className={cn("space-y-4", className)}>
      {!file ? (
        <div
          {...getRootProps()}
          className={cn(
            "border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer",
            isDragActive ? "border-primary bg-primary/5 scale-[0.99]" : "border-muted-foreground/20 hover:border-primary/50 hover:bg-muted/50",
            uploading && "opacity-50 cursor-not-allowed"
          )}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <FileUp className="h-8 w-8 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-lg font-semibold">
                {isDragActive ? "Drop your CV here" : "Click or drag your CV to upload"}
              </p>
              <p className="text-sm text-muted-foreground">
                Supports PDF and DOCX (Max 10MB)
              </p>
            </div>
          </div>
        </div>
      ) : (
        <Card className="border-primary/20 bg-primary/5 relative overflow-hidden">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                <FileText className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate text-base">{file.name}</p>
                <p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
              {status === 'idle' && (
                <Button variant="ghost" size="icon" onClick={clearFile} className="shrink-0 rounded-full">
                  <X className="h-4 w-4" />
                </Button>
              )}
              {status === 'success' && <CheckCircle2 className="h-6 w-6 text-success shrink-0" />}
              {status === 'error' && <AlertCircle className="h-6 w-6 text-destructive shrink-0" />}
            </div>

            {status === 'uploading' && (
              <div className="mt-4 space-y-2">
                <div className="flex justify-between text-sm font-medium">
                  <span>Uploading & Parsing...</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
            )}

            {status === 'idle' && (
              <Button onClick={handleUpload} className="w-full mt-4 h-10 shadow-lg shadow-primary/20">
                Start Analysis
              </Button>
            )}

            {status === 'success' && (
              <p className="text-sm text-success font-medium mt-3 flex items-center gap-1.5 justify-center">
                Processing complete. Refreshing profile view...
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
