import React, { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UploadProgress } from '@/components/common';
import { UploadStatus } from '@/types';
import { Upload, FileText, CheckCircle, File, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import api from '@/services/api';
import { ParsedEmployeeMetadata } from '@/types';
import axios from 'axios';

interface UploadedFileInfo {
  name: string;
  size: number;
  type: string;
}

const CVUploadPage: React.FC = () => {
  const [dragActive, setDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<UploadedFileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ParsedEmployeeMetadata | null>(null);

  const loadMetadata = useCallback(async () => {
    try {
      const response = await api.get<ParsedEmployeeMetadata>('/file-storage/metadata/me');
      setMetadata(response.data);
    } catch {
      // Keep UI usable even if metadata fetch fails
    }
  }, []);

  useEffect(() => {
    loadMetadata();
  }, [loadMetadata]);

  const uploadFile = useCallback(async (uploadedFile: File) => {
    setFile({
      name: uploadedFile.name,
      size: uploadedFile.size,
      type: uploadedFile.type,
    });
    setError(null);
    setUploadStatus('uploading');
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', uploadedFile);

      await api.post('/cv/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => {
          if (event.total) {
            const pct = Math.round((event.loaded / event.total) * 100);
            setProgress(pct);
          }
        },
      });

      setUploadStatus('parsing');
      setTimeout(() => {
        setUploadStatus('completed');
      }, 800);
      await loadMetadata();
    } catch (err) {
      console.error('CV upload failed', err);
      setUploadStatus('error');
      if (axios.isAxiosError(err)) {
        const message = (err.response?.data as { message?: string } | undefined)?.message;
        setError(message || 'Upload failed. Please try again.');
      } else {
        setError('Upload failed. Please try again.');
      }
    }
  }, [loadMetadata]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const droppedFile = e.dataTransfer.files[0];
        if (droppedFile.type === 'application/pdf' || 
            droppedFile.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            droppedFile.type === 'image/png' ||
            droppedFile.type === 'image/jpeg') {
          uploadFile(droppedFile);
        } else {
          setError('Please upload a PDF, DOCX, PNG or JPG file');
        }
      }
    },
    [uploadFile]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
        const selectedFile = e.target.files[0];
        if (selectedFile.type === 'application/pdf' || 
            selectedFile.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            selectedFile.type === 'image/png' ||
            selectedFile.type === 'image/jpeg') {
          uploadFile(selectedFile);
        } else {
          setError('Please upload a PDF, DOCX, PNG or JPG file');
        }
      }
    },
    [uploadFile]
  );

  const handleReset = () => {
    setFile(null);
    setUploadStatus('idle');
    setProgress(0);
    setError(null);
    setMetadata(null);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getStatusMessage = (): string => {
    switch (uploadStatus) {
      case 'uploading':
        return 'Uploading your CV...';
      case 'parsing':
        return 'Parsing document with AI...';
      case 'completed':
        return 'CV uploaded successfully!';
      case 'error':
        return 'Upload failed. Please try again.';
      default:
        return '';
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Upload CV</h1>
        <p className="text-muted-foreground">Upload your CV to keep your profile up to date</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>CV Document</CardTitle>
          <CardDescription>
            Upload your CV in PDF, DOCX, PNG or JPG format. The system will automatically parse and extract information.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {uploadStatus === 'idle' ? (
            <div
              className={cn(
                'relative border-2 border-dashed rounded-lg p-12 transition-all duration-200',
                dragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50',
                error && 'border-destructive'
              )}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept=".pdf,.docx,.png,.jpg,.jpeg"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <div className="flex flex-col items-center gap-4">
                <div
                  className={cn(
                    'p-4 rounded-full transition-colors',
                    dragActive ? 'bg-primary/10' : 'bg-muted'
                  )}
                >
                  <Upload
                    className={cn(
                      'h-8 w-8 transition-colors',
                      dragActive ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                </div>
                <div className="text-center">
                  <p className="text-lg font-medium">
                    {dragActive ? 'Drop your file here' : 'Drag and drop your CV'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    or click to browse (PDF, DOCX, PNG, JPG up to 10MB)
                  </p>
                </div>
                <Button variant="outline" className="mt-2">
                  <FileText className="h-4 w-4 mr-2" />
                  Select File
                </Button>
              </div>
              {error && (
                <p className="text-destructive text-sm text-center mt-4">{error}</p>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {/* File Info */}
              {file && (
                <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/50">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <File className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{file.name}</p>
                    <p className="text-sm text-muted-foreground">{formatFileSize(file.size)}</p>
                  </div>
                  {uploadStatus === 'completed' && (
                    <CheckCircle className="h-6 w-6 text-success" />
                  )}
                </div>
              )}

              {/* Progress/Status */}
              <div className="space-y-4">
                {(uploadStatus === 'uploading' || uploadStatus === 'parsing') && (
                  <UploadProgress 
                    progress={uploadStatus === 'parsing' ? 100 : progress} 
                    status={getStatusMessage()} 
                  />
                )}

                {uploadStatus === 'parsing' && (
                  <div className="flex items-center justify-center gap-2 py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">Analyzing document structure...</span>
                  </div>
                )}

                {uploadStatus === 'completed' && (
                  <div className="p-4 rounded-lg bg-success/10 border border-success/20">
                    <div className="flex items-center gap-3">
                      <CheckCircle className="h-5 w-5 text-success" />
                      <div>
                        <p className="font-medium text-success">Upload Complete</p>
                        <p className="text-sm text-muted-foreground">
                          Your CV has been successfully uploaded and parsed.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Status Steps */}
                <div className="flex items-center justify-center gap-2 py-4">
                  {['Uploading', 'Parsing', 'Completed'].map((step, index) => {
                    const isActive =
                      (step === 'Uploading' && uploadStatus === 'uploading') ||
                      (step === 'Parsing' && uploadStatus === 'parsing') ||
                      (step === 'Completed' && uploadStatus === 'completed');
                    const isCompleted =
                      (step === 'Uploading' && ['parsing', 'completed'].includes(uploadStatus)) ||
                      (step === 'Parsing' && uploadStatus === 'completed') ||
                      (step === 'Completed' && uploadStatus === 'completed');

                    return (
                      <React.Fragment key={step}>
                        <div
                          className={cn(
                            'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors',
                            isActive && 'bg-primary text-primary-foreground',
                            isCompleted && 'bg-success/10 text-success',
                            !isActive && !isCompleted && 'bg-muted text-muted-foreground'
                          )}
                        >
                          {isCompleted ? (
                            <CheckCircle className="h-4 w-4" />
                          ) : isActive ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <span className="h-4 w-4 flex items-center justify-center text-xs">
                              {index + 1}
                            </span>
                          )}
                          {step}
                        </div>
                        {index < 2 && (
                          <div
                            className={cn(
                              'w-8 h-0.5 rounded-full',
                              isCompleted ? 'bg-success' : 'bg-muted'
                            )}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-center gap-3">
                {uploadStatus === 'completed' && (
                  <>
                    <Button variant="outline" onClick={handleReset}>
                      Upload Another
                    </Button>
                    <Button>
                      <FileText className="h-4 w-4 mr-2" />
                      View CV
                    </Button>
                  </>
                )}
                {(uploadStatus === 'uploading' || uploadStatus === 'parsing') && (
                  <Button variant="outline" onClick={handleReset}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {metadata && (
        <Card>
          <CardHeader>
            <CardTitle>Parsed Profile Snapshot</CardTitle>
            <CardDescription>Data extracted from your uploaded documents</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="font-medium">Name:</span> {metadata.name}</p>
            <p><span className="font-medium">Experience:</span> {metadata.experience_years} years</p>
            <p><span className="font-medium">Last Update:</span> {metadata.last_update}</p>
            <p><span className="font-medium">Skills:</span> {metadata.skills.length ? metadata.skills.join(', ') : 'None detected yet'}</p>
          </CardContent>
        </Card>
      )}

      {/* Tips Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tips for Best Results</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Use a clean, well-formatted CV with clear section headings
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Include your certifications with dates and credential IDs
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              List technologies and skills used in each project
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              PDF format is recommended for best parsing accuracy
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

export default CVUploadPage;
