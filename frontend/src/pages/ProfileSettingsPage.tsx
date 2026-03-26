import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { profileService } from '@/services/profile.service';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { toast } from 'sonner';
import { Camera, Loader2, Lock, Save, ShieldCheck, UserCircle2 } from 'lucide-react';

const passwordPolicyText = 'Minimum 8 characters, including at least 1 number and 1 special character.';
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
        const me = await profileService.getMe();
        setFirstName(me.firstName || '');
        setLastName(me.lastName || '');
        setEmail(me.email || '');
        setAvatarUrl(me.avatarUrl || '');
      } catch (error: any) {
        toast.error(error?.response?.data?.message || 'Failed to load your profile settings');
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
      toast.success('Profile details updated');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to update profile details');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarUpload = async () => {
    if (!selectedFile) {
      toast.error('Choose an image before uploading');
      return;
    }

    setSavingAvatar(true);
    try {
      const updated = await profileService.uploadAvatar(selectedFile);
      setAvatarUrl(updated.avatarUrl || '');
      updateUser(updated);
      setSelectedFile(null);
      toast.success('Profile picture updated');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to upload profile picture');
    } finally {
      setSavingAvatar(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match');
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
      toast.success('Password updated successfully');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'Failed to update password');
    } finally {
      setSavingPassword(false);
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
        <h1 className="text-2xl font-bold text-foreground">Profile Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your personal details, profile picture, and password.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCircle2 className="h-5 w-5 text-primary" />
              Personal Details
            </CardTitle>
            <CardDescription>Only your authenticated account can update these values.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSaveProfile}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={email} disabled />
              </div>
              <Button type="submit" disabled={savingProfile}>
                {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save Changes
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5 text-primary" />
              Profile Picture
            </CardTitle>
            <CardDescription>Visible in shared lists and account menus across the app.</CardDescription>
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
                <p>Accepted formats: PNG, JPG, WEBP</p>
                <p>Maximum file size: 5 MB</p>
              </div>
            </div>
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
            />
            <Button type="button" variant="outline" onClick={handleAvatarUpload} disabled={!selectedFile || savingAvatar}>
              {savingAvatar ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
              Upload Picture
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-primary" />
            Change Password
          </CardTitle>
          <CardDescription>Enter your current password before saving a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4 max-w-xl" onSubmit={handlePasswordChange}>
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
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
              <Label htmlFor="confirmPassword">Confirm new password</Label>
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
              Update Password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProfileSettingsPage;
