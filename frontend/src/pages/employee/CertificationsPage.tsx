import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/services/api';
import { CvCertification, CvProfile } from '@/types';
import axios from 'axios';
import { toast } from 'sonner';
import { Award, Plus, Upload, Search, Calendar, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [profile, setProfile] = useState<CvProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
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
        return 'File type not supported. Please upload PDF, DOCX, PNG or JPG.';
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return 'File is too large. Maximum allowed size is 10MB.';
      }
      return null;
    },
    [ALLOWED_TYPES, MAX_UPLOAD_BYTES]
  );

  const uploadCertificate = useCallback(
    async (file: File) => {
      setIsUploading(true);
      setUploadError(null);
      setUploadedFileName(null);

      try {
        const formData = new FormData();
        formData.append('file', file);

        await api.post('/certifications/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        setUploadedFileName(file.name);
        await loadData();
      } catch (err) {
        console.error('Certificate upload failed', err);
        if (axios.isAxiosError(err)) {
          const message = (err.response?.data as { message?: string } | undefined)?.message;
          const friendly =
            message?.includes('malware') || message?.includes('virus')
              ? 'Upload blocked: malware detected in the file.'
              : message;
          setUploadError(friendly || 'Upload failed. Please try again.');
          toast.error(friendly || 'Upload failed. Please try again.');
        } else {
          setUploadError('Upload failed. Please try again.');
          toast.error('Upload failed. Please try again.');
        }
      } finally {
        setIsUploading(false);
      }
    },
    [loadData]
  );

  const certifications = useMemo(() => profile?.certifications || [], [profile]);
  const normalizeText = useCallback(
    (value: string) => value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
    []
  );

  const filteredCertifications = useMemo(() => {
    const q = normalizeText(searchQuery.trim());
    if (!q) return certifications;
    return certifications.filter((cert) => {
      const nameMatch = normalizeText(cert.name).includes(q);
      const issuerMatch = normalizeText(cert.issuingOrganization || '').includes(q);
      return nameMatch || issuerMatch;
    });
  }, [certifications, searchQuery, normalizeText]);

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'Not specified';
    return dateString;
  };

  const statusClass = (status?: CvCertification['status']) => {
    if (status === 'active') return 'bg-success/10 text-success';
    if (status === 'expiring_soon') return 'bg-warning/10 text-warning';
    if (status === 'expired') return 'bg-destructive/10 text-destructive';
    return 'bg-muted text-muted-foreground';
  };

  const uploadClass = (isUploaded?: boolean) => {
    if (isUploaded) return 'bg-success/10 text-success';
    return 'bg-muted text-muted-foreground';
  };

  const formatStatus = (status?: CvCertification['status']) => {
    if (!status) return 'unknown';
    return status.replace('_', ' ');
  };

  const formatCertName = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  const parseDateOnly = (value?: string | null) => {
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Certifications</h1>
          <p className="text-muted-foreground">Upload and review extracted certifications</p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
          if (open && !hasConfiguredName) {
            // Do not open the dialog if they don't have a name configured
            return;
          }
          setIsAddDialogOpen(open);
        }}>
          <DialogTrigger asChild>
            <Button disabled={!hasConfiguredName}>
              <Plus className="h-4 w-4 mr-2" />
              Add Certification
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Upload Certification</DialogTitle>
              <DialogDescription>
                Upload a PDF, DOCX or image file. Metadata is parsed automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
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
                <p className="text-sm font-medium">Upload Certificate</p>
                <p className="text-xs text-muted-foreground">PDF, DOCX, PNG, JPG (max 10MB)</p>
                {isUploading && (
                  <p className="text-xs text-muted-foreground mt-2">Uploading...</p>
                )}
                {uploadedFileName && (
                  <p className="text-xs text-success mt-2">Uploaded: {uploadedFileName}</p>
                )}
                {uploadError && (
                  <p className="text-xs text-destructive mt-2">{uploadError}</p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {!hasConfiguredName && (
        <Alert variant="destructive">
          <AlertTitle>Action Required</AlertTitle>
          <AlertDescription>
            Please upload your CV in the Profile section first. We need your name to verify that the uploaded certifications belong to you.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="py-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search certifications..."
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
              Loading certifications...
            </div>
          </CardContent>
        </Card>
      ) : filteredCertifications.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCertifications.map((cert, index) => {
            const displayStatus = getDynamicStatus(cert);
            return (
            <Card key={`${cert.name}-${index}`} className="hover:shadow-md transition-all duration-200">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Award className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusClass(displayStatus)}`}>
                      {formatStatus(displayStatus)}
                    </span>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${uploadClass(cert.isUploaded)}`}>
                      {cert.isUploaded ? 'Uploaded' : 'From CV'}
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
                    <span>Issued: {formatDate(cert.issueDate)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>Expires: {formatDate(cert.expirationDate)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <Award className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="font-medium text-lg mb-1">No certifications found</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Upload a certificate to parse and populate your list.
            </p>
            <Button disabled={!hasConfiguredName} onClick={() => setIsAddDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Certification
            </Button>
          </CardContent>
        </Card>
      )}

    </div>
  );
};

export default CertificationsPage;
