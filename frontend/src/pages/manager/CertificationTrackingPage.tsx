import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/common';
import { certificationService, TeamCertification, CertificationStats } from '@/services/certification.service';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Search, Filter, Download, CalendarIcon, Award, Loader2, FileText } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const CertificationTrackingPage: React.FC = () => {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [allCertifications, setAllCertifications] = useState<TeamCertification[]>([]);
  const [certificationStats, setCertificationStats] = useState<CertificationStats>({
    total: 0,
    active: 0,
    expiring_soon: 0,
    expired: 0,
  });
  const [loading, setLoading] = useState(true);

  // Load team certifications
  useEffect(() => {
    loadCertifications();
  }, []);

  const loadCertifications = async () => {
    if (!user) return;
    
    try {
      setLoading(true);
      const [certifications, stats] = await Promise.all([
        certificationService.getTeamCertifications(),
        certificationService.getTeamCertificationStats(),
      ]);
      
      setAllCertifications(certifications);
      setCertificationStats(stats);
    } catch (error) {
      console.error('Failed to load certifications:', error);
      toast.error('Impossible de charger les certifications de l\'équipe');
    } finally {
      setLoading(false);
    }
  };

  const filteredCertifications = allCertifications.filter((cert) => {
    const matchesSearch =
      cert.certificationName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (cert.issuingOrganization && cert.issuingOrganization.toLowerCase().includes(searchQuery.toLowerCase())) ||
      cert.employeeName.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || cert.status === statusFilter;
    
    let matchesDate = true;
    if (dateRange.from && cert.expirationDate) {
      const expDate = new Date(cert.expirationDate);
      if (dateRange.from && expDate < dateRange.from) matchesDate = false;
      if (dateRange.to && expDate > dateRange.to) matchesDate = false;
    }

    return matchesSearch && matchesStatus && matchesDate;
  });

  const handleViewProof = async (cert: TeamCertification) => {
    try {
      const url = await certificationService.getCertificationProofUrl(cert.certification_id);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Give the browser time to load the blob before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error('Justificatif indisponible.');
    }
  };

  const exportToCSV = () => {
    const headers = ['Certification', 'Employé', 'E-mail', 'Émetteur', 'Date d\'émission', 'Date d\'expiration', 'Statut'];
    const rows = filteredCertifications.map((cert) => [
      cert.certificationName,
      cert.employeeName,
      cert.employeeEmail || '',
      cert.issuingOrganization || '',
      cert.issueDate ? formatDate(cert.issueDate) : '',
      cert.expirationDate ? formatDate(cert.expirationDate) : '',
      cert.status.replace('_', ' '),
    ]);

    const escape = (val: string) => `"${String(val).replace(/"/g, '""')}"`;
    const csv =
      '﻿' +
      [headers, ...rows].map((row) => row.map(escape).join(';')).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `certifications_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatDate = (dateString: string | Date | null) => {
    if (!dateString) return 'N/A';
    try {
      return format(new Date(dateString), 'MMM d, yyyy');
    } catch {
      return 'Invalid date';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Suivi des certifications</h1>
          <p className="text-muted-foreground">Suivez les certifications et expirations de votre équipe</p>
        </div>
        <Button variant="outline" onClick={exportToCSV} disabled={filteredCertifications.length === 0}>
          <Download className="h-4 w-4 mr-2" />
          Exporter CSV
        </Button>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">Chargement des certifications...</span>
        </div>
      ) : (
        <>
          {/* Filters */}
          <Card>
        <CardContent className="py-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Rechercher par certification, émetteur ou employé..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Statut" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les statuts</SelectItem>
                  <SelectItem value="active">Actives</SelectItem>
                  <SelectItem value="expiring_soon">Expirant bientôt</SelectItem>
                  <SelectItem value="expired">Expirées</SelectItem>
                </SelectContent>
              </Select>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[180px] justify-start text-left">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dateRange.from ? (
                      dateRange.to ? (
                        <>
                          {format(dateRange.from, 'LLL dd')} - {format(dateRange.to, 'LLL dd')}
                        </>
                      ) : (
                        format(dateRange.from, 'LLL dd, y')
                      )
                    ) : (
                      <span>Plage d'expiration</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    initialFocus
                    mode="range"
                    selected={{ from: dateRange.from, to: dateRange.to }}
                    onSelect={(range) => setDateRange({ from: range?.from, to: range?.to })}
                    numberOfMonths={2}
                    className="pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>

              {(statusFilter !== 'all' || dateRange.from) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStatusFilter('all');
                    setDateRange({});
                  }}
                >
                  Réinitialiser
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              {filteredCertifications.length} Certification{filteredCertifications.length !== 1 ? 's' : ''} trouvée{filteredCertifications.length !== 1 ? 's' : ''}
            </CardTitle>
            <div className="flex gap-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="bg-success/10 text-success">
                {certificationStats.active} Actives
              </Badge>
              <Badge variant="outline" className="bg-warning/10 text-warning">
                {certificationStats.expiring_soon} Expirant bientôt
              </Badge>
              <Badge variant="outline" className="bg-destructive/10 text-destructive">
                {certificationStats.expired} Expirées
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Certification</TableHead>
                <TableHead>Employé</TableHead>
                <TableHead>Émetteur</TableHead>
                <TableHead>Date d'émission</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCertifications.map((cert) => (
                <TableRow key={cert.certification_id} className="animate-fade-in">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Award className="h-4 w-4 text-primary" />
                      <span className="font-medium">{cert.certificationName}</span>
                    </div>
                    {cert.hasProof && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 mt-1 text-xs text-muted-foreground hover:text-primary"
                        onClick={() => handleViewProof(cert)}
                      >
                        <FileText className="h-3 w-3 mr-1" />
                        Voir le justificatif
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="font-medium text-sm">{cert.employeeName}</p>
                      <p className="text-xs text-muted-foreground">{cert.employeeEmail}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {cert.issuingOrganization || 'N/A'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(cert.issueDate)}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'font-medium',
                        cert.status === 'expired' && 'text-destructive',
                        cert.status === 'expiring_soon' && 'text-warning'
                      )}
                    >
                      {formatDate(cert.expirationDate)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={cert.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filteredCertifications.length === 0 && !loading && (
            <div className="py-16 text-center">
              <Award className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-lg mb-1">Aucune certification trouvée</h3>
              <p className="text-muted-foreground text-sm">
                {allCertifications.length === 0
                  ? 'Aucun membre de l\'équipe n\'a encore importé de certification'
                  : 'Essayez d\'ajuster vos filtres'
                }
              </p>
            </div>
          )}
        </CardContent>
      </Card>
        </>
      )}
    </div>
  );
};

export default CertificationTrackingPage;
