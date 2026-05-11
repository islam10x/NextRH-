import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { profileService } from '@/services/profile.service';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { toast } from 'sonner';
import { Camera, Loader2, Lock, Save, ShieldCheck, UserCircle2, Users } from 'lucide-react';
import { teamService } from '@/services/team.service';

const passwordPolicyText = 'Minimum 8 caractères, dont au moins 1 chiffre et 1 caractère spécial.';
const passwordPolicyRegex = /^(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

const ProfileSettingsPage: React.FC = () => {
  const { user, updateUser } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [savingTeam, setSavingTeam] = useState(false);

  const initials = useMemo(() => {
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || user?.name || email;
    return displayName
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((token) => token[0]?.toUpperCase() || '')
      .join('');
  }, [email, firstName, lastName, user?.name]);

  useEffect(() => {
    const load = async () => {
      try {
        const [me] = await Promise.all([
          profileService.getMe(),
          user?.role === 'team_manager'
            ? teamService.getMyTeam().then((info) => setTeamName(info?.teamName || '')).catch(() => {})
            : Promise.resolve(),
        ]);
        setFirstName(me.firstName || '');
        setLastName(me.lastName || '');
        setEmail(me.email || '');
        setAvatarUrl(me.avatarUrl || '');
      } catch (error: any) {
        toast.error(error?.response?.data?.message || 'Impossible de charger vos paramètres de profil');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const updated = await profileService.updateProfile({ firstName, lastName });
      setAvatarUrl(updated.avatarUrl || '');
      updateUser(updated);
      toast.success('Profil mis à jour');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de mettre à jour le profil');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarUpload = async () => {
    if (!selectedFile) {
      toast.error('Sélectionnez une image avant d\'importer');
      return;
    }

    setSavingAvatar(true);
    try {
      const updated = await profileService.uploadAvatar(selectedFile);
      setAvatarUrl(updated.avatarUrl || '');
      updateUser(updated);
      setSelectedFile(null);
      toast.success('Photo de profil mise à jour');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible d\'importer la photo');
    } finally {
      setSavingAvatar(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error('Les mots de passe ne correspondent pas');
      return;
    }

    if (!passwordPolicyRegex.test(newPassword)) {
      toast.error(passwordPolicyText);
      return;
    }

    setSavingPassword(true);
    try {
      await profileService.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Mot de passe mis à jour');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de mettre à jour le mot de passe');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSaveTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim() || teamName.trim().length < 2) {
      toast.error('Le nom d\'équipe doit comporter au moins 2 caractères.');
      return;
    }
    setSavingTeam(true);
    try {
      await teamService.updateMyTeam(teamName.trim(), null);
      toast.success('Nom d\'équipe mis à jour');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Impossible de mettre à jour le nom d\'équipe');
    } finally {
      setSavingTeam(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Paramètres du profil</h1>
        <p className="text-sm text-muted-foreground">Gérez vos informations personnelles, votre photo de profil et votre mot de passe.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCircle2 className="h-5 w-5 text-primary" />
              Informations personnelles
            </CardTitle>
            <CardDescription>Seul votre compte authentifié peut modifier ces valeurs.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSaveProfile}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firstName">Prénom</Label>
                  <Input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Nom</Label>
                  <Input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">E-mail</Label>
                <Input id="email" value={email} disabled />
              </div>
              <Button type="submit" disabled={savingProfile}>
                {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Enregistrer
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5 text-primary" />
              Photo de profil
            </CardTitle>
            <CardDescription>Visible dans les listes partagées et les menus de compte de l'application.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar className="h-20 w-20 ring-2 ring-primary/10">
                <AvatarImage src={avatarUrl || undefined} alt={user?.name || email} />
                <AvatarFallback className="text-lg bg-primary/5 text-primary">
                  {initials || 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="text-sm text-muted-foreground">
                <p>Formats acceptés : PNG, JPG, WEBP</p>
                <p>Taille maximale : 5 Mo</p>
              </div>
            </div>
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
            />
            <Button type="button" variant="outline" onClick={handleAvatarUpload} disabled={!selectedFile || savingAvatar}>
              {savingAvatar ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
              Importer la photo
            </Button>
          </CardContent>
        </Card>
      </div>

      {user?.role === 'team_manager' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Identité de l'équipe
            </CardTitle>
            <CardDescription>Définissez le nom qui apparaît sur votre tableau de bord et celui de vos membres.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4 max-w-xl" onSubmit={handleSaveTeam}>
              <div className="space-y-2">
                <Label htmlFor="teamName">Nom de l'équipe</Label>
                <Input
                  id="teamName"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  maxLength={80}
                  placeholder="ex. Alpha Squad"
                />
              </div>
              <Button type="submit" disabled={savingTeam}>
                {savingTeam ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Enregistrer
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-primary" />
            Changer le mot de passe
          </CardTitle>
          <CardDescription>Saisissez votre mot de passe actuel avant d'en définir un nouveau.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4 max-w-xl" onSubmit={handlePasswordChange}>
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Mot de passe actuel</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">Nouveau mot de passe</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5" />
                {passwordPolicyText}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirmer le nouveau mot de passe</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" disabled={savingPassword}>
              {savingPassword ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
              Mettre à jour
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProfileSettingsPage;
