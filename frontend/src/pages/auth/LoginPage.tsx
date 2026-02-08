import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { UserRole } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileText, User, Users, Briefcase, Loader2 } from 'lucide-react';

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRole, setSelectedRole] = useState<UserRole>('employee');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const success = await login(email, password, selectedRole);
    setIsLoading(false);

    if (success) {
      const redirectPath =
        selectedRole === 'employee'
          ? '/employee/dashboard'
          : selectedRole === 'manager'
          ? '/manager/dashboard'
          : '/bid/dashboard';
      navigate(redirectPath);
    }
  };

  const roleCards = [
    {
      role: 'employee' as UserRole,
      title: 'Employee',
      description: 'Access your CV, certifications, and training records',
      icon: User,
      color: 'bg-primary',
    },
    {
      role: 'manager' as UserRole,
      title: 'Team Manager',
      description: 'Monitor your team\'s certifications and skills',
      icon: Users,
      color: 'bg-accent',
    },
    {
      role: 'bid_manager' as UserRole,
      title: 'BID Manager',
      description: 'Search profiles, use AI assistant, generate CVs',
      icon: Briefcase,
      color: 'bg-success',
    },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg">
            <FileText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">CV Manager</h1>
            <p className="text-sm text-muted-foreground">AI-Driven Certification System</p>
          </div>
        </div>

        <Card className="shadow-xl border-0">
          <CardHeader className="text-center pb-4">
            <CardTitle className="text-xl">Welcome Back</CardTitle>
            <CardDescription>Sign in to access your portal</CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-6">
              {/* Role Selection */}
              <div className="space-y-3">
                <Label className="text-sm font-medium">Select Your Role</Label>
                <div className="grid grid-cols-3 gap-3">
                  {roleCards.map((card) => (
                    <button
                      key={card.role}
                      type="button"
                      onClick={() => setSelectedRole(card.role)}
                      className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
                        selectedRole === card.role
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-muted hover:border-primary/50 hover:bg-muted/50'
                      }`}
                    >
                      <div
                        className={`p-2 rounded-lg ${
                          selectedRole === card.role ? card.color : 'bg-muted'
                        }`}
                      >
                        <card.icon
                          className={`h-5 w-5 ${
                            selectedRole === card.role ? 'text-white' : 'text-muted-foreground'
                          }`}
                        />
                      </div>
                      <span
                        className={`text-xs font-medium ${
                          selectedRole === card.role ? 'text-primary' : 'text-muted-foreground'
                        }`}
                      >
                        {card.title}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {roleCards.find((c) => c.role === selectedRole)?.description}
                </p>
              </div>

              {/* Login Form */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11"
                  />
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex-col gap-4">
              <Button type="submit" className="w-full h-11" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Demo mode: Any credentials will work. Select a role to explore the system.
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
};

export default LoginPage;
