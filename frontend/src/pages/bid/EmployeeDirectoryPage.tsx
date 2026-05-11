import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Search, Eye, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { userService } from '@/services/user.service';
import { teamService } from '@/services/team.service';
import { DBUser } from '@/types';

const EmployeeDirectoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<DBUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [teams, setTeams] = useState<{ teamId: string; teamName: string; memberUserIds: string[] }[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('all');

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const [activeUsers, allTeams] = await Promise.all([
        userService.listActive(),
        teamService.listAllForBid().catch(() => []),
      ]);
      setUsers(activeUsers);
      setTeams(allTeams);
    } catch {
      toast.error("Impossible de charger le vivier de talents — vérifiez votre connexion et réessayez.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const filteredUsers = users.filter((u) => {
    const searchLower = searchQuery.toLowerCase();
    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.toLowerCase();
    const matchesSearch =
      u.email.toLowerCase().includes(searchLower) ||
      fullName.includes(searchLower) ||
      u.role.toLowerCase().includes(searchLower);
    const matchesTeam =
      selectedTeamId === 'all' ||
      (teams.find((t) => t.teamId === selectedTeamId)?.memberUserIds.includes(u.user_id) ?? false);
    return matchesSearch && matchesTeam;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Vivier de talents</h1>
          <p className="text-muted-foreground text-sm">Consulter et explorer tout le personnel actif</p>
        </div>
      </div>

      <Card>
        <CardContent className="py-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Rechercher par nom, e-mail ou rôle..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 h-10 shadow-sm"
              />
            </div>
            {teams.length > 0 && (
              <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
                <SelectTrigger className="h-10 w-full sm:w-52">
                  <SelectValue placeholder="Toutes les équipes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes les équipes</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t.teamId} value={t.teamId}>{t.teamName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary/30" />
          <p className="text-muted-foreground font-medium italic">Chargement du vivier de talents...</p>
        </div>
      ) : (
        <div className="animate-in fade-in duration-300">
          {filteredUsers.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredUsers.map((u) => {
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
                          <p className="text-sm text-muted-foreground">
                            {u.role === 'employee' ? 'Employé' : u.role === 'team_manager' ? 'Manager d\'équipe' : u.role === 'bid_manager' ? 'Manager BID' : u.role}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                        </div>
                      </div>

                      <div className="mt-4 pt-4 border-t border-muted/40">
                        <Button variant="outline" size="sm" className="w-full text-xs font-medium gap-1.5" onClick={() => navigate(`/bid/employee/${u.user_id}`)}>
                          <Eye className="h-3.5 w-3.5" /> Voir le profil
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="border-dashed py-20 bg-muted/20">
              <CardContent className="flex flex-col items-center text-center">
                <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-semibold">Aucun personnel trouvé</h3>
                <p className="text-muted-foreground text-sm max-w-sm">
                  Aucun employé actif ne correspond à votre recherche.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default EmployeeDirectoryPage;
