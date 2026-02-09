import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Search, Eye, Award, UserPlus, Mail, Shield, Loader2, RotateCcw, Trash2, Users as UsersIcon, Clock, Briefcase } from 'lucide-react';
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
import api from '@/services/api';

interface DBUser {
  user_id: string;
  email: string;
  role: string;
  status: 'active' | 'pending_invitation' | 'deactivated';
  firstName?: string;
  lastName?: string;
  invitedAt?: string;
}

const EmployeeDirectoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<DBUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('employee');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<DBUser[]>('/users');
      setUsers(response.data);
    } catch (err: any) {
      toast.error('Failed to fetch employee directory');
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
      toast.error('Please enter an email address');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post('/auth/invite', { email: inviteEmail, role: inviteRole });
      toast.success(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
      setInviteRole('employee');
      setIsInviteDialogOpen(false);
      fetchUsers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to send invitation');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async (userId: string, email: string) => {
    try {
      await api.post(`/auth/invite/resend/${userId}`);
      toast.success(`Invitation resent to ${email}`);
    } catch (err: any) {
      toast.error('Failed to resend invitation');
    }
  };

  const handleCancel = async (userId: string) => {
    if (!window.confirm('Are you sure you want to cancel this invitation? The user record will be deleted.')) {
      return;
    }

    try {
      await api.delete(`/auth/invite/${userId}`);
      toast.success('Invitation cancelled');
      fetchUsers();
    } catch (err: any) {
      toast.error('Failed to cancel invitation');
    }
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

  const activeUsers = filteredUsers.filter(u => u.status === 'active');
  const pendingUsers = filteredUsers.filter(u => u.status === 'pending_invitation');

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Employee Directory</h1>
          <p className="text-muted-foreground text-sm">Search and filter employees for bids</p>
        </div>
        <Button onClick={() => setIsInviteDialogOpen(true)} className="gap-2">
          <UserPlus className="h-4 w-4" />
          Invite Resource
        </Button>
      </div>

      {/* Invitation Dialog */}
      <Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <UserPlus className="h-6 w-6 text-primary" />
            </div>
            <DialogTitle className="text-xl">Invite New Member</DialogTitle>
            <DialogDescription>
              A professional onboarding link will be sent via email.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleInviteSubmit}>
            <div className="space-y-6 py-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-semibold">Business Email</Label>
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
              <div className="space-y-2">
                <Label htmlFor="role" className="text-sm font-semibold">Assign Permissions</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="h-12 border-muted focus-visible:ring-primary">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="manager">Team Manager</SelectItem>
                    <SelectItem value="bid_manager">BID Manager</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="pt-6 border-t mt-4 gap-2">
              <Button type="button" variant="ghost" onClick={() => setIsInviteDialogOpen(false)} className="h-11">
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting} className="h-11 min-w-[140px]">
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <UserPlus className="h-4 w-4 mr-2" />
                )}
                {isSubmitting ? 'Sending...' : 'Send Invitation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="py-4">
          <div className="relative max-w-lg">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-10 shadow-sm"
            />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="active" className="space-y-6">
        <TabsList className="bg-muted w-full md:w-auto p-1 h-auto grid grid-cols-2 md:inline-flex">
          <TabsTrigger value="active" className="gap-2 px-8 h-10 data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <UsersIcon className="h-4 w-4" />
            Active ({activeUsers.length})
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-2 px-8 h-10 data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <Clock className="h-4 w-4" />
            Pending ({pendingUsers.length})
          </TabsTrigger>
        </TabsList>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary/30" />
            <p className="text-muted-foreground font-medium italic">Restoring directory...</p>
          </div>
        ) : (
          <>
            <TabsContent value="active" className="animate-in fade-in duration-300 outline-none">
              {activeUsers.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {activeUsers.map((u) => {
                    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim();
                    const displayName = fullName || u.email;

                    return (
                      <Card key={u.user_id} className="hover:shadow-md transition-shadow animate-fade-in">
                        <CardContent className="p-5">
                          <div className="flex items-start gap-4">
                            <Avatar className="h-12 w-12">
                              <AvatarFallback className="bg-primary/10 text-primary">
                                {displayName.substring(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-semibold truncate">{displayName}</h3>
                              <p className="text-sm text-muted-foreground capitalize">{u.role.replace('_', ' ')}</p>
                              <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                            </div>
                          </div>

                          <Button variant="outline" size="sm" className="w-full mt-4" onClick={() => navigate(`/bid/employee/${u.user_id}`)}>
                            <Eye className="h-4 w-4 mr-1" /> View Profile
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
                    <h3 className="text-lg font-semibold">No active employees found</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Try adjusting your search or invite a new resource to get started.
                    </p>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="pending" className="animate-in fade-in duration-300 outline-none">
              {pendingUsers.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {pendingUsers.map((u) => (
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
                              <Badge variant="secondary" className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-[10px] h-4">Pending</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground capitalize">{u.role.replace('_', ' ')}</p>
                            <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                          </div>
                        </div>

                        <div className="flex gap-2 mt-4">
                          <Button variant="outline" size="sm" className="flex-1 text-xs gap-1" onClick={() => handleResend(u.user_id, u.email)}>
                            <RotateCcw className="h-3 w-3" /> Resend
                          </Button>
                          <Button variant="outline" size="sm" className="flex-1 text-xs gap-1 text-destructive hover:text-destructive" onClick={() => handleCancel(u.user_id)}>
                            <Trash2 className="h-3 w-3" /> Cancel
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
                    <h3 className="text-lg font-semibold">No pending invitations</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      All invited resources have activated their accounts.
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

export default EmployeeDirectoryPage;
