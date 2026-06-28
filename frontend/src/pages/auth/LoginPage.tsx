import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FileText, Loader2, LogIn } from 'lucide-react';

const dashboardFor = (role?: string) =>
  role === 'employee'
    ? '/employee/dashboard'
    : role === 'team_manager'
      ? '/manager/dashboard'
      : '/bid/dashboard';

const LoginPage: React.FC = () => {
  const { login, isAuthenticated, user, isLoading } = useAuth();
  const navigate = useNavigate();

  // Once Keycloak has authenticated and the local profile is loaded,
  // send the user to their role-based dashboard.
  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(dashboardFor(user.role), { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg">
            <FileText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">NextRH</h1>
            <p className="text-sm text-muted-foreground">Système de gestion des certifications</p>
          </div>
        </div>

        <Card className="shadow-xl border-0">
          <CardHeader className="text-center pb-4">
            <CardTitle className="text-xl">Bienvenue</CardTitle>
            <CardDescription>Connectez-vous pour accéder à votre portail</CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            <p className="text-center text-sm text-muted-foreground">
              L'authentification est gérée de façon sécurisée par le portail
              d'identité NextStep.
            </p>
          </CardContent>

          <CardFooter className="flex-col gap-4">
            <Button
              type="button"
              className="w-full h-11"
              disabled={isLoading}
              onClick={() => login()}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connexion...
                </>
              ) : (
                <>
                  <LogIn className="mr-2 h-4 w-4" />
                  Se connecter
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
};

export default LoginPage;
