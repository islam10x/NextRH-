import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Users, Award, AlertTriangle, Building2, TrendingUp, ChevronRight, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { bidService, BidDashboardStats } from '@/services/bid.service';

const BIDDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<BidDashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bidService.getDashboardStats()
      .then(setStats)
      .catch(() => setError('Failed to load dashboard data'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="flex items-center justify-center h-64 text-destructive">
        {error || 'No data available'}
      </div>
    );
  }

  const { certStats } = stats;

  const pieData = [
    { name: 'Active', value: certStats.active, color: 'hsl(var(--success))' },
    { name: 'Expiring', value: certStats.expiringSoon, color: 'hsl(var(--warning))' },
    { name: 'Expired', value: certStats.expired, color: 'hsl(var(--destructive))' },
  ].filter((d) => d.value > 0);

  const barData = certStats.byOrg;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">BID Dashboard</h1>
          <p className="text-muted-foreground">Overview of key performance metrics</p>
        </div>
        <Button onClick={() => navigate('/bid/ai-chat')}>
          <TrendingUp className="mr-2 h-4 w-4" />
          Generate Report
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="animate-fade-in">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Employees</CardTitle>
            <Users className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats.totalEmployees}</div>
          </CardContent>
        </Card>
        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Certifications</CardTitle>
            <Award className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{certStats.total}</div>
          </CardContent>
        </Card>
        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Expiring This Month</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-warning">{certStats.expiringThisMonth}</div>
          </CardContent>
        </Card>
        <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Teams</CardTitle>
            <Building2 className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats.totalTeams}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Certification Status */}
        <Card>
          <CardHeader>
            <CardTitle>Certification Status</CardTitle>
            <CardDescription>Overall certification health across the company</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-4 mt-4">
              {pieData.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-sm text-muted-foreground">{item.name}</span>
                  <span className="text-sm font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Certifications by Category */}
        <Card>
          <CardHeader>
            <CardTitle>Top Certification Categories</CardTitle>
            <CardDescription>Most popular certifications by issuer</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Expiring Certifications */}
        <Card>
          <CardHeader>
            <CardTitle>Expiring Certifications</CardTitle>
            <CardDescription>Certifications expiring in the next 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Total expiring</span>
                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20">
                  {certStats.expiringSoon}
                </Badge>
              </div>
              <Button variant="outline" className="w-full" onClick={() => navigate('/bid/certifications')}>
                View all certifications
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks for BID managers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Button variant="outline" className="w-full justify-between" onClick={() => navigate('/bid/ai-chat')}>
                <span>Ask AI Assistant</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="w-full justify-between" onClick={() => navigate('/bid/reports')}>
                <span>Generate Report</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" className="w-full justify-between" onClick={() => navigate('/bid/employees')}>
                <span>Manage Employees</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default BIDDashboard;
