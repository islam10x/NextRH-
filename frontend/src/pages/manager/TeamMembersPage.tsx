import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Search,
  Eye,
  UserPlus,
  Mail,
  Loader2,
  Trash2,
  Users as UsersIcon,
  Clock,
  Download
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import api from '@/services/api';
import { userService } from '@/services/user.service';
import { DBUser } from '@/types';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

const TeamMembersPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<DBUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      setUsers(await userService.listAll());
    } catch {
      toast.error("Impossible de charger les membres — vérifiez votre connexion et réessayez.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) {
      toast.error('Veuillez saisir une adresse e-mail');
      return;
    }

    // Basic email regex validation to ensure it has a TLD
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(inviteEmail)) {
      toast.error('Veuillez saisir une adresse e-mail professionnelle valide (ex. : nom@entreprise.com)');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post('/auth/invite', { email: inviteEmail, role: 'employee' });
      toast.success(`${inviteEmail} ajouté à votre équipe`);
      setInviteEmail('');
      setIsInviteDialogOpen(false);
      fetchUsers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Échec de l\'envoi de l\'invitation');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelConfirmed = async () => {
    if (!cancelTarget) return;
    try {
      await api.delete(`/auth/invite/${cancelTarget}`);
      toast.success('Membre en attente retiré.');
      fetchUsers();
    } catch {
      toast.error("Impossible d'annuler l'invitation. Réessayez.");
    } finally {
      setCancelTarget(null);
    }
  };

  const exportToCSV = () => {
    const SEP = ';';
    const rows = [
      ['Prénom', 'Nom', 'E-mail', 'Rôle', 'Statut', 'Invité le'],
      ...users.map((u) => [
        u.firstName || '',
        u.lastName || '',
        u.email,
        u.role.replace(/_/g, ' '),
        u.status.replace(/_/g, ' '),
        u.invitedAt ? new Date(u.invitedAt).toISOString().slice(0, 10) : '',
      ]),
    ];
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(SEP)).join('\r\n');
    const BOM = '﻿';
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team-members-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredUsers = users.filter((u) => {
    const searchLower = searchQuery.toLowerCase();
    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.toLowerCase();
    return (
      u.email.toLowerCase().includes(searchLower) ||
      fullName.includes(searchLower) ||
      u.role.toLowerCase().includes(searchLower)
    );
  });

  const activeMembers = filteredUsers.filter(u => u.status === 'active');
  const pendingInvitations = filteredUsers.filter(u => u.status === 'pending_invitation');

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(open) => { if (!open) setCancelTarget(null); }}
        title="Annuler l'invitation"
        description="Cela annulera définitivement l'invitation. L'utilisateur ne pourra plus configurer son compte via ce lien."
        confirmLabel="Annuler l'invitation"
        onConfirm={handleCancelConfirmed}
      />
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Gestion de l'équipe</h1>
          <p className="text-muted-foreground text-sm">Gérez les membres de votre équipe et les invitations</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2" onClick={exportToCSV} disabled={users.length === 0}>
            <Download className="h-4 w-4" />
            Exporter la liste
          </Button>
          <Button onClick={() => setIsInviteDialogOpen(true)} className="gap-2">
            <UserPlus className="h-4 w-4" />
            Inviter une ressource
          </Button>
        </div>
      </div>

      {/* Invitation Dialog */}
      <Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <UserPlus className="h-6 w-6 text-primary" />
            </div>
            <DialogTitle className="text-xl">Inviter un nouveau membre</DialogTitle>
            <DialogDescription>
              Un lien d'intégration professionnel sera envoyé par e-mail.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleInviteSubmit}>
            <div className="space-y-6 py-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-semibold">E-mail professionnel</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@company.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="pl-10 h-12 focus-visible:ring-primary shadow-sm"
                    required
                  />
                </div>
              </div>
            </div>
            <DialogFooter className="pt-6 border-t mt-4 gap-2">
              <Button type="button" variant="ghost" onClick={() => setIsInviteDialogOpen(false)} className="h-11">
                Annuler
              </Button>
              <Button type="submit" disabled={isSubmitting} className="h-11 min-w-[140px]">
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <UserPlus className="h-4 w-4 mr-2" />
                )}
                {isSubmitting ? 'Envoi en cours...' : 'Envoyer l\'invitation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Search */}
      <Card>
        <CardContent className="py-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Rechercher par nom, titre ou e-mail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="active" className="space-y-6">
        <TabsList className="bg-muted w-full md:w-auto p-1 h-auto grid grid-cols-2 md:inline-flex">
          <TabsTrigger value="active" className="gap-2 px-8 h-10 data-[state=active]:bg-background dark:data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <UsersIcon className="h-4 w-4" />
            Actifs ({activeMembers.length})
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-2 px-8 h-10 data-[state=active]:bg-background dark:data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Clock className="h-4 w-4" />
            En attente ({pendingInvitations.length})
          </TabsTrigger>
        </TabsList>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary/30" />
            <p className="text-muted-foreground font-medium italic">Chargement de l'équipe...</p>
          </div>
        ) : (
          <>
            <TabsContent value="active" className="animate-in fade-in duration-300 outline-none">
              {activeMembers.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {activeMembers.map((u) => {
                    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim();
                    const displayName = fullName || u.email;

                    return (
                      <Card key={u.user_id} className="hover:shadow-md transition-shadow animate-fade-in group">
                        <CardContent className="p-5">
                          <div className="flex items-start gap-4">
                            <Avatar className="h-12 w-12 ring-2 ring-primary/5 group-hover:ring-primary/10 transition-all">
                              <AvatarImage src={u.avatarUrl || undefined} alt={displayName} />
                              <AvatarFallback className="bg-primary/5 text-primary">
                                {displayName.substring(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-semibold truncate group-hover:text-primary transition-colors">{displayName}</h3>
                              <p className="text-sm text-muted-foreground capitalize">{u.role.replace('_', ' ')}</p>
                              <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                            </div>
                          </div>

                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full mt-4 text-xs font-medium gap-1.5"
                            onClick={() => navigate(`/manager/member/${u.user_id}`)}
                          >
                            <Eye className="h-4 w-4" /> Voir le CV
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <Card className="border-dashed py-20 bg-muted/20">
                  <CardContent className="flex flex-col items-center text-center">
                    <UsersIcon className="h-12 w-12 text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold">Aucun membre actif trouvé</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Ajustez votre recherche ou invitez une nouvelle ressource dans votre équipe.
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="pending" className="animate-in fade-in duration-300 outline-none">
              {pendingInvitations.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {pendingInvitations.map((u) => (
                    <Card key={u.user_id} className="hover:shadow-md transition-shadow animate-fade-in">
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <Avatar className="h-12 w-12">
                            <AvatarFallback className="bg-amber-100 text-amber-700">
                              <Mail className="h-5 w-5" />
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold truncate">{u.email}</h3>
                              <Badge variant="secondary" className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-[10px] h-4">En attente</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground capitalize">{u.role.replace('_', ' ')}</p>
                          </div>
                        </div>

                        <div className="flex gap-2 mt-4">
                          <Button variant="outline" size="sm" className="flex-1 text-xs gap-1 text-destructive hover:text-destructive" onClick={() => setCancelTarget(u.user_id)}>
                            <Trash2 className="h-3 w-3" /> Retirer
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="border-dashed py-20 bg-muted/20">
                  <CardContent className="flex flex-col items-center text-center">
                    <Mail className="h-12 w-12 text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-semibold">Aucune invitation en attente</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Votre file d'invitations est vide.
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
};

export default TeamMembersPage;
