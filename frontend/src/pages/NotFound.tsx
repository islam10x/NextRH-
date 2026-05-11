import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';

const NotFound = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    console.error('404 Error: User attempted to access non-existent route:', location.pathname);
  }, [location.pathname]);

  const dashboardPath = user?.role === 'employee'
    ? '/employee/dashboard'
    : user?.role === 'team_manager'
      ? '/manager/dashboard'
      : user?.role === 'bid_manager'
        ? '/bid/dashboard'
        : '/login';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg">
            <FileText className="h-6 w-6" />
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-bold text-foreground">CV Manager</h1>
            <p className="text-sm text-muted-foreground">AI-Driven Certification System</p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-8xl font-bold text-foreground">404</p>
          <p className="text-xl font-semibold text-foreground">Page introuvable</p>
          <p className="text-sm text-muted-foreground">
            Cette page n'existe pas ou a été déplacée.
          </p>
        </div>

        <Button className="w-full h-11" onClick={() => navigate(dashboardPath)}>
          Retour au tableau de bord
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
