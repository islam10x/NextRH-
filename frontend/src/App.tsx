import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { MainLayout } from "@/components/layout";
import LoginPage from "@/pages/auth/LoginPage";
import SetupPasswordPage from "@/pages/auth/SetupPasswordPage";
import ForgotPasswordPage from "@/pages/auth/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/auth/ResetPasswordPage";
import { EmployeeDashboard, CVUploadPage, CertificationsPage, TrainingProjectsPage, CVPreviewPage } from "@/pages/employee";
import { ManagerDashboard, TeamMembersPage, MemberProfilePage, CertificationTrackingPage, ManagerTrainingsPage, ManagerProjectsPage } from "@/pages/manager";
import { BIDDashboard, EmployeeDirectoryPage, AIChatPage, CVGenerationPage } from "@/pages/bid";
import ProfileSettingsPage from "./pages/ProfileSettingsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/setup-password" element={<SetupPasswordPage />} />
            <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

            {/* Employee Routes */}
            <Route element={<MainLayout requiredRole="employee" />}>
              <Route path="/employee/dashboard" element={<EmployeeDashboard />} />
              <Route path="/employee/training-projects" element={<TrainingProjectsPage />} />
            </Route>

            {/* Shared self-service routes (employees + managers) */}
            <Route element={<MainLayout requiredRole={["employee", "team_manager", "bid_manager"]} />}>
              <Route path="/employee/cv-upload" element={<CVUploadPage />} />
              <Route path="/employee/certifications" element={<CertificationsPage />} />
              <Route path="/employee/cv-preview/" element={<CVPreviewPage />} />
              <Route path="/employee/cv-preview/:employeeId" element={<CVPreviewPage />} />
              <Route path="/employee/settings" element={<ProfileSettingsPage />} />
            </Route>

            {/* Manager Routes */}
            <Route element={<MainLayout requiredRole="team_manager" />}>
              <Route path="/manager/dashboard" element={<ManagerDashboard />} />
              <Route path="/manager/team" element={<TeamMembersPage />} />
              <Route path="/manager/member/:memberId" element={<MemberProfilePage />} />
              <Route path="/manager/certifications" element={<CertificationTrackingPage />} />
              <Route path="/manager/trainings" element={<ManagerTrainingsPage />} />
              <Route path="/manager/projects" element={<ManagerProjectsPage />} />
              <Route path="/manager/settings" element={<ProfileSettingsPage />} />
            </Route>

            {/* BID Manager Routes */}
            <Route element={<MainLayout requiredRole="bid_manager" />}>
              <Route path="/bid/dashboard" element={<BIDDashboard />} />
              <Route path="/bid/directory" element={<EmployeeDirectoryPage />} />
              <Route path="/bid/employee/:memberId" element={<MemberProfilePage />} />
              <Route path="/bid/ai-chat" element={<AIChatPage />} />
              <Route path="/bid/cv-generation" element={<CVGenerationPage />} />
              <Route path="/bid/settings" element={<ProfileSettingsPage />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
