import React, { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UploadProgress } from '@/components/common';
import { UploadStatus } from '@/types';
import { Upload, FileText, CheckCircle, File, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import api from '@/services/api';
import { useAuth } from '@/contexts/AuthContext';
import { ParsedEmployeeMetadata } from '@/types';
import axios from 'axios';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';

interface UploadedFileInfo {
  name: string;
  size: number;
  type: string;
}

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
];

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (keep in sync with backend)

const CVUploadPage: React.FC = () => {
  const navigate = useNavigate();
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

  const { updateUser } = useAuth();

  const validateFile = useCallback((uploadedFile: File): string | null => {
    if (!ALLOWED_TYPES.includes(uploadedFile.type)) {
      return 'Type de fichier non supporté. Veuillez importer un PDF, DOCX, PNG ou JPG.';
    }
    if (uploadedFile.size > MAX_UPLOAD_BYTES) {
      return 'Fichier trop volumineux. La taille maximale autorisée est 10 Mo.';
    }
    return null;
  }, []);

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

      const response = await api.post('/cv/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => {
          if (event.total) {
            const pct = Math.round((event.loaded / event.total) * 100);
            setProgress(pct);
          }
        },
      });

      // Update user name in frontend session if returned from backend
      if (response.data && response.data.user) {
        updateUser(response.data.user);
      }

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
        const friendly =
          message?.includes('malware') || message?.includes('virus')
            ? 'Importation bloquée : logiciel malveillant détecté dans le fichier.'
            : message;
        setError(friendly || 'Échec de l\'importation. Veuillez réessayer.');
        toast.error(friendly || 'Échec de l\'importation. Veuillez réessayer.');
      } else {
        setError('Échec de l\'importation. Veuillez réessayer.');
        toast.error('Échec de l\'importation. Veuillez réessayer.');
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
        const validationError = validateFile(droppedFile);
        if (validationError) {
          setError(validationError);
          toast.error(validationError);
          return;
        }
        uploadFile(droppedFile);
      }
    },
    [uploadFile, validateFile]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
        const selectedFile = e.target.files[0];
        const validationError = validateFile(selectedFile);
        if (validationError) {
          setError(validationError);
          toast.error(validationError);
          return;
        }
        uploadFile(selectedFile);
      }
    },
    [uploadFile, validateFile]
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
        return 'Importation du CV en cours...';
      case 'parsing':
        return 'Analyse du document par l\'IA...';
      case 'completed':
        return 'CV importé avec succès !';
      case 'error':
        return 'Échec de l\'importation. Veuillez réessayer.';
      default:
        return '';
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Importer le CV</h1>
        <p className="text-muted-foreground">Importez votre CV pour maintenir votre profil à jour</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Document CV</CardTitle>
          <CardDescription>
            Importez votre CV au format PDF, DOCX, PNG ou JPG. Le système analysera et extraira automatiquement les informations.
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
                    {dragActive ? 'Déposez votre fichier ici' : 'Glissez-déposez votre CV'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    ou cliquez pour parcourir (PDF, DOCX, PNG, JPG jusqu'à 10 Mo)
                  </p>
                </div>
                <Button variant="outline" className="mt-2">
                  <FileText className="h-4 w-4 mr-2" />
                  Sélectionner un fichier
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
                    <span className="text-sm text-muted-foreground">Analyse de la structure du document...</span>
                  </div>
                )}

                {uploadStatus === 'completed' && (
                  <div className="p-4 rounded-lg bg-success/10 border border-success/20">
                    <div className="flex items-center gap-3">
                      <CheckCircle className="h-5 w-5 text-success" />
                      <div>
                        <p className="font-medium text-success">Importation terminée</p>
                        <p className="text-sm text-muted-foreground">
                          Votre CV a été importé et analysé avec succès.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Status Steps */}
                <div className="flex items-center justify-center gap-2 py-4">
                  {['Importation', 'Analyse', 'Terminé'].map((step, index) => {
                    const statusKey = ['uploading', 'parsing', 'completed'][index];
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
                      Importer un autre
                    </Button>
                    <Button onClick={() => navigate('/employee/cv-preview')}>
                      <FileText className="h-4 w-4 mr-2" />
                      Voir le CV
                    </Button>
                  </>
                )}
                {(uploadStatus === 'uploading' || uploadStatus === 'parsing') && (
                  <Button variant="outline" onClick={handleReset}>
                    Annuler
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
            <CardTitle>Aperçu du profil extrait</CardTitle>
            <CardDescription>Données extraites de vos documents importés</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="font-medium">Nom :</span> {metadata.name}</p>
            <p><span className="font-medium">Expérience :</span> {metadata.experience_years} ans</p>
            <p><span className="font-medium">Dernière mise à jour :</span> {metadata.last_update}</p>
            <p><span className="font-medium">Compétences :</span> {metadata.skills.length ? metadata.skills.join(', ') : 'Aucune détectée'}</p>
          </CardContent>
        </Card>
      )}

      {/* Tips Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Conseils pour de meilleurs résultats</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Utilisez un CV propre et bien formaté avec des titres de section clairs
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Incluez vos certifications avec les dates et identifiants d'accréditation
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Listez les technologies et compétences utilisées dans chaque projet
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
              Le format PDF est recommandé pour une meilleure précision d'analyse
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

export default CVUploadPage;
