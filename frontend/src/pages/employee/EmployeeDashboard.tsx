import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/common';
import { mockEmployees, mockNotifications } from '@/data/mockData';
import { Employee } from '@/types';
import { Award, FileText, GraduationCap, Bell, ChevronRight, Upload, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const EmployeeDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Get employee data
  const employeeData = mockEmployees.find((emp) => emp.id === user?.id) as Employee | undefined;
  const notifications = mockNotifications.filter((n) => n.userId === user?.id && !n.read);

  const certStats = {
    active: employeeData?.certifications.filter((c) => c.status === 'active').length || 0,
    expiring: employeeData?.certifications.filter((c) => c.status === 'expiring_soon').length || 0,
    expired: employeeData?.certifications.filter((c) => c.status === 'expired').length || 0,
  };

  const chartData = [
    { name: 'Active', value: certStats.active, color: 'hsl(var(--success))' },
    { name: 'Expiring', value: certStats.expiring, color: 'hsl(var(--warning))' },
    { name: 'Expired', value: certStats.expired, color: 'hsl(var(--destructive))' },
  ].filter((d) => d.value > 0);

  const quickActions = [
    { label: 'Upload CV', icon: Upload, onClick: () => navigate('/employee/cv-upload') },
    { label: 'Add Certification', icon: Award, onClick: () => navigate('/employee/certifications') },
    { label: 'View CV', icon: FileText, onClick: () => navigate('/employee/cv-preview') },
  ];

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Welcome back, {user?.name?.split(' ')[0]}!</h1>
          <p className="text-muted-foreground">{employeeData?.title} • {employeeData?.yearsOfExperience} years experience</p>
        </div>
        <div className="flex gap-2">
          {quickActions.map((action) => (
            <Button key={action.label} variant="outline" size="sm" onClick={action.onClick}>
              <action.icon className="h-4 w-4 mr-2" />
              {action.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="animate-fade-in" style={{ animationDelay: '0ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Certifications</CardTitle>
            <Award className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{employeeData?.certifications.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {certStats.active} active, {certStats.expiring} expiring soon
            </p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Training Completed</CardTitle>
            <GraduationCap className="h-4 w-4 text-accent" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{employeeData?.trainings.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Professional development courses
            </p>
          </CardContent>
        </Card>

        <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Projects</CardTitle>
            <FileText className="h-4 w-4 text-success" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{employeeData?.projects.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Client engagements
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Certification Status */}
        <Card className="lg:col-span-2 animate-fade-in" style={{ animationDelay: '300ms' }}>
          <CardHeader>
            <CardTitle className="text-lg">Certification Status</CardTitle>
            <CardDescription>Overview of your professional certifications</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-6">
              {/* Chart */}
              <div className="w-full md:w-48 h-48">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={chartData}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={70}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {chartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    No certifications yet
                  </div>
                )}
              </div>

              {/* Certification List */}
              <div className="flex-1 space-y-3">
                {employeeData?.certifications.slice(0, 4).map((cert) => (
                  <div
                    key={cert.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{cert.name}</p>
                      <p className="text-xs text-muted-foreground">{cert.issuer}</p>
                    </div>
                    <StatusBadge status={cert.status} />
                  </div>
                ))}
                {(!employeeData?.certifications || employeeData.certifications.length === 0) && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Award className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No certifications added yet</p>
                    <Button variant="link" size="sm" onClick={() => navigate('/employee/certifications')}>
                      Add your first certification
                    </Button>
                  </div>
                )}
                {employeeData?.certifications && employeeData.certifications.length > 4 && (
                  <Button
                    variant="ghost"
                    className="w-full text-primary"
                    onClick={() => navigate('/employee/certifications')}
                  >
                    View all certifications
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notifications Panel */}
        <Card className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Notifications</CardTitle>
              <Bell className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {notifications.length > 0 ? (
              notifications.map((notif) => (
                <div
                  key={notif.id}
                  className={`p-3 rounded-lg border-l-4 ${
                    notif.type === 'error'
                      ? 'border-l-destructive bg-destructive/5'
                      : notif.type === 'warning'
                      ? 'border-l-warning bg-warning/5'
                      : 'border-l-primary bg-primary/5'
                  }`}
                >
                  <p className="font-medium text-sm">{notif.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">{notif.message}</p>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No new notifications</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* CV Status */}
      <Card className="animate-fade-in" style={{ animationDelay: '500ms' }}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">CV Status</CardTitle>
              <CardDescription>Your current CV information</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/employee/cv-preview')}>
              <FileText className="h-4 w-4 mr-2" />
              View CV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-muted">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1">
              <p className="font-medium">{user?.name}_CV.pdf</p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last updated: {employeeData?.cvLastUpdated || 'Never'}
              </div>
            </div>
            <Button onClick={() => navigate('/employee/cv-upload')}>
              <Upload className="h-4 w-4 mr-2" />
              Update CV
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default EmployeeDashboard;
