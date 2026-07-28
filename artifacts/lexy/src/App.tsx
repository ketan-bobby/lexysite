/**
 * App.tsx — Root application component and client-side router.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Bootstraps the entire React application:
 *   1. Creates and provides the TanStack Query client (global data cache)
 *   2. Wraps the tree in AuthProvider (JWT session context) and ErrorBoundary
 *   3. Declares every route using Wouter's <Switch> / <Route>
 *
 * ── Route groups ──────────────────────────────────────────────────────────────
 *  /                    Recruiter dashboard (default after login)
 *  /jobs, /candidates   Recruiter job and candidate management
 *  /interviews          Interview scheduling, rooms, proctoring
 *  /outreach            Outreach campaigns and inbox
 *  /sourcing            Sourcing and talent match
 *  /agents              AI agent hub and workflow canvas
 *  /analytics           Recruiter analytics dashboard
 *  /clients             Client (tenant) management
 *  /portal/*            Candidate self-service portal
 *  /careers/*           Public job listings and application pages
 *  /login, /accept-invite, /not-found  Auth and utility pages
 *
 * ── Auth guard ────────────────────────────────────────────────────────────────
 * <ProtectedRoute> redirects unauthenticated users to /login.
 * Portal routes use a separate <PortalRoute> guard keyed to candidateToken.
 */

import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { TourProvider } from "@/lib/tour/TourProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import Login from "@/pages/login";
import MicrosoftCallback from "@/pages/auth-microsoft-callback";
import TrialExchange from "@/pages/trial-exchange";
import TrialSetup from "@/pages/trial-setup";
import Dashboard from "@/pages/recruiter/dashboard";
import PlatformDashboard from "@/pages/recruiter/platform-dashboard";
import JobsList from "@/pages/recruiter/jobs/index";
import JobDetail from "@/pages/recruiter/jobs/[id]";
import CandidatesList from "@/pages/recruiter/candidates/index";
import CandidateProfile from "@/pages/recruiter/candidates/[id]";
import InterviewsDashboard from "@/pages/recruiter/interviews/index";
import InterviewDetail from "@/pages/recruiter/interviews/[id]";
import InterviewRoom from "@/pages/recruiter/interviews/room";
import ProctoringReport from "@/pages/recruiter/interviews/proctor-report";
import Coordinator from "@/pages/recruiter/coordinator";
import OutreachCampaigns from "@/pages/recruiter/outreach/index";
import OutreachInbox from "@/pages/recruiter/outreach/inbox";
import Sourcing from "@/pages/recruiter/sourcing";
import RunView from "@/pages/recruiter/run-view";
import Communication from "@/pages/recruiter/communication";
import Analytics from "@/pages/recruiter/analytics";
import MarketIntelligence from "@/pages/recruiter/market-intelligence";
import LinxQueue from "@/pages/recruiter/linx-queue";
import Engagement from "@/pages/recruiter/engagement";
import Verify from "@/pages/recruiter/verify";
import TalentMatch from "@/pages/recruiter/talent-match";
import InternalTalent from "@/pages/recruiter/internal-talent";
import Admin from "@/pages/recruiter/admin";
import AgentHub from "@/pages/recruiter/agents";
import OpenWorkOrders from "@/pages/recruiter/open-work-orders";
import ClientsList from "@/pages/recruiter/clients/index";
import ClientDetail from "@/pages/recruiter/clients/[id]";
import CandidatePortal from "@/pages/portal/index";
import PortalInterviews from "@/pages/portal/interviews";
import PrepCenter from "@/pages/portal/prep";
import PortalApplications from "@/pages/portal/applications";
import PortalNotifications from "@/pages/portal/notifications";
import StaffNotifications from "@/pages/notifications";
import CareersPage from "@/pages/careers/index";
import CareersJobPage from "@/pages/careers/[id]";
import ClientCareersPage from "@/pages/careers/[slug]";
import DecisionQueue from "@/pages/recruiter/decision-queue";
import HumanReview from "@/pages/recruiter/human-review";
import Appeals from "@/pages/recruiter/appeals";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import AntiGhost from "@/pages/recruiter/anti-ghost/index";
import DNCManager from "@/pages/recruiter/dnc/index";
import CandidatePortalLogin from "@/pages/portal/login";
import AcceptInvite from "@/pages/accept-invite";
import NotFound from "@/pages/not-found";
import CareerHub from "@/pages/portal/career";
import CareerInterview from "@/pages/portal/career-interview";
import OnboardingResume from "@/pages/portal/onboarding-resume";
import OnboardingScreening from "@/pages/portal/onboarding-screening";
import PortalSelfId from "@/pages/portal/self-id";
import PortalSettings from "@/pages/portal/settings";
import InterviewConsent from "@/pages/portal/interview-consent";
import PortalDeletionRequest from "@/pages/portal/deletion-request";
import AedtNotice from "@/pages/portal/aedt-notice";
import AdminDeletionRequests from "@/pages/admin/deletion-requests";
import TranscriptionHealth from "@/pages/admin/transcription-health";
import FairnessDashboard from "@/pages/admin/fairness";
import HirePulse from "@/pages/hire-pulse";
import AuditPage from "@/pages/recruiter/audit";
import CareerRegister from "@/pages/career-register";
import ResetPassword from "@/pages/reset-password";
import HmPackagePage from "@/pages/hm-package";
import HiringDashboard from "@/pages/hiring/dashboard";
import HiringJobs from "@/pages/hiring/jobs";
import HiringCandidates from "@/pages/hiring/candidates";
import HiringInterviews from "@/pages/hiring/interviews";
import Subscription from "@/pages/recruiter/subscription";
import PlatformSubscriptions from "@/pages/recruiter/platform-subscriptions";
import PlatformFeeLedger from "@/pages/recruiter/platform-fee-ledger";
import TenantFees from "@/pages/recruiter/fees";
import PlatformPricing from "@/pages/recruiter/platform-pricing";
import PlatformSystemErrors from "@/pages/recruiter/platform-system-errors";
import AiJobsDashboard from "@/pages/recruiter/ai-jobs";
import TrialRequests from "@/pages/recruiter/trial-requests";
import HiringTalentPool from "@/pages/hiring/talent-pool";
import InterviewerInterviews from "@/pages/interviewer/interviews";
import AcceptTeamInvite from "@/pages/accept-team-invite";
import ResumeImport from "@/pages/recruiter/import";
import MyTeam from "@/pages/recruiter/team";
import RecruiterSettings from "@/pages/recruiter/settings";
import IntroVideo from "@/pages/recruiter/intro-video";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component, roles }: { component: any; roles?: string[] }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" /></div>;
  if (!isAuthenticated) return <Redirect to="/login" />;
  if (roles && user && !roles.includes(user.role)) {
    if (user.role === "candidate")        return <Redirect to="/portal/career" />;
    if (user.role === "hiring_manager")   return <Redirect to="/hiring/dashboard" />;
    if (user.role === "interviewer")      return <Redirect to="/interviewer/interviews" />;
    if (user.role === "platform_admin")   return <Redirect to="/platform" />;
    return <Redirect to="/dashboard" />;
  }
  return <Component />;
}

function RootRedirect() {
  const { user, isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <Redirect to="/login" />;
  if (user?.role === "candidate")        return <Redirect to="/portal/career" />;
  if (user?.role === "platform_admin")   return <Redirect to="/platform" />;
  if (user?.role === "hiring_manager")   return <Redirect to="/hiring/dashboard" />;
  if (user?.role === "interviewer")      return <Redirect to="/interviewer/interviews" />;
  return <Redirect to="/dashboard" />;
}

const recruiterRoles = ["recruiter", "recruiter_admin", "platform_admin", "tenant_admin"];
const adminRoles = ["platform_admin", "tenant_admin"];
const hiringManagerRoles = ["hiring_manager"];
const interviewerRoles = ["interviewer"];

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootRedirect} />
      <Route path="/login" component={Login} />
      <Route path="/auth/microsoft/callback" component={MicrosoftCallback} />
      <Route path="/auth/trial-setup" component={TrialSetup} />
      {/* Legacy: older email links pointed here; the page now forwards to
          /auth/trial-setup so existing inboxes still work. */}
      <Route path="/auth/trial-exchange" component={TrialExchange} />

      <Route path="/platform"><ProtectedRoute component={PlatformDashboard} roles={["platform_admin"]} /></Route>
      <Route path="/dashboard"><ProtectedRoute component={Dashboard} roles={recruiterRoles} /></Route>
      <Route path="/jobs"><ProtectedRoute component={JobsList} roles={recruiterRoles} /></Route>
      <Route path="/jobs/:id"><ProtectedRoute component={JobDetail} roles={[...recruiterRoles, "hiring_manager"]} /></Route>
      <Route path="/candidates"><ProtectedRoute component={CandidatesList} roles={recruiterRoles} /></Route>
      <Route path="/candidates/:id"><ProtectedRoute component={CandidateProfile} roles={[...recruiterRoles, "hiring_manager"]} /></Route>
      <Route path="/decision-queue"><ProtectedRoute component={DecisionQueue} roles={recruiterRoles} /></Route>
      <Route path="/human-review"><ProtectedRoute component={HumanReview} roles={[...recruiterRoles, "hiring_manager"]} /></Route>
      <Route path="/human-review/appeals"><ProtectedRoute component={Appeals} roles={[...recruiterRoles, "hiring_manager"]} /></Route>
      <Route path="/interviews"><ProtectedRoute component={InterviewsDashboard} roles={recruiterRoles} /></Route>
      <Route path="/interviews/:id/room" component={InterviewRoom} />
      <Route path="/interviews/:id/proctor-report" component={ProctoringReport} />
      <Route path="/interviews/:id"><ProtectedRoute component={InterviewDetail} roles={recruiterRoles} /></Route>
      <Route path="/coordinator"><ProtectedRoute component={Coordinator} roles={recruiterRoles} /></Route>
      <Route path="/outreach"><ProtectedRoute component={OutreachCampaigns} roles={recruiterRoles} /></Route>
      <Route path="/outreach/inbox"><ProtectedRoute component={OutreachInbox} roles={recruiterRoles} /></Route>
      <Route path="/sourcing"><ProtectedRoute component={Sourcing} roles={recruiterRoles} /></Route>
      <Route path="/runs/:id"><ProtectedRoute component={RunView} roles={recruiterRoles} /></Route>
      <Route path="/communication"><ProtectedRoute component={Communication} roles={recruiterRoles} /></Route>
      <Route path="/analytics"><ProtectedRoute component={Analytics} roles={recruiterRoles} /></Route>
      <Route path="/market-intelligence"><ProtectedRoute component={MarketIntelligence} roles={recruiterRoles} /></Route>
      <Route path="/linx/queue"><ProtectedRoute component={LinxQueue} roles={adminRoles} /></Route>
      <Route path="/engagement"><ProtectedRoute component={Engagement} roles={recruiterRoles} /></Route>
      <Route path="/verify"><ProtectedRoute component={Verify} roles={recruiterRoles} /></Route>
      <Route path="/talent-match"><ProtectedRoute component={TalentMatch} roles={recruiterRoles} /></Route>
      <Route path="/internal-talent"><ProtectedRoute component={InternalTalent} roles={recruiterRoles} /></Route>
      <Route path="/admin"><ProtectedRoute component={Admin} roles={adminRoles} /></Route>
      <Route path="/subscription"><ProtectedRoute component={Subscription} roles={["tenant_admin", "platform_admin", "recruiter"]} /></Route>
      <Route path="/platform/subscriptions"><ProtectedRoute component={PlatformSubscriptions} roles={["platform_admin"]} /></Route>
      <Route path="/platform/fee-ledger"><ProtectedRoute component={PlatformFeeLedger} roles={["platform_admin"]} /></Route>
      <Route path="/fees"><ProtectedRoute component={TenantFees} roles={["tenant_admin", "recruiter_admin", "platform_admin"]} /></Route>
      <Route path="/platform/pricing"><ProtectedRoute component={PlatformPricing} roles={["platform_admin"]} /></Route>
      <Route path="/platform/trial-requests"><ProtectedRoute component={TrialRequests} roles={["platform_admin"]} /></Route>
      <Route path="/platform/system-errors"><ProtectedRoute component={PlatformSystemErrors} roles={["platform_admin"]} /></Route>
      <Route path="/admin/ai-jobs"><ProtectedRoute component={AiJobsDashboard} roles={recruiterRoles} /></Route>
      <Route path="/agents"><ProtectedRoute component={AgentHub} roles={recruiterRoles} /></Route>
      <Route path="/anti-ghost"><ProtectedRoute component={AntiGhost} roles={recruiterRoles} /></Route>
      <Route path="/dnc"><ProtectedRoute component={DNCManager} roles={recruiterRoles} /></Route>
      <Route path="/team"><ProtectedRoute component={MyTeam} roles={recruiterRoles} /></Route>
      <Route path="/recruiter/settings"><ProtectedRoute component={RecruiterSettings} roles={recruiterRoles} /></Route>
      <Route path="/settings/intro-video"><ProtectedRoute component={IntroVideo} roles={[...recruiterRoles, "hiring_manager", "interviewer"]} /></Route>
      <Route path="/clients"><ProtectedRoute component={ClientsList} roles={[...adminRoles, "recruiter_admin"]} /></Route>
      <Route path="/clients/:id"><ProtectedRoute component={ClientDetail} roles={[...adminRoles, "recruiter_admin"]} /></Route>
      <Route path="/open-work-orders"><ProtectedRoute component={OpenWorkOrders} roles={["platform_admin"]} /></Route>
      <Route path="/import"><ProtectedRoute component={ResumeImport} roles={["platform_admin"]} /></Route>

      <Route path="/portal"><Redirect to="/portal/career" /></Route>
      <Route path="/portal/interviews"><ProtectedRoute component={PortalInterviews} roles={["candidate"]} /></Route>
      <Route path="/portal/prep"><ProtectedRoute component={PrepCenter} roles={["candidate"]} /></Route>
      <Route path="/portal/applications"><ProtectedRoute component={PortalApplications} roles={["candidate"]} /></Route>
      <Route path="/portal/notifications"><ProtectedRoute component={PortalNotifications} roles={["candidate"]} /></Route>
      <Route path="/notifications"><ProtectedRoute component={StaffNotifications} roles={[...recruiterRoles, "hiring_manager", "interviewer"]} /></Route>
      <Route path="/portal/career/interview"><ProtectedRoute component={CareerInterview} roles={["candidate"]} /></Route>
      <Route path="/portal/onboarding/resume"><ProtectedRoute component={OnboardingResume} roles={["candidate"]} /></Route>
      <Route path="/portal/onboarding/screening"><ProtectedRoute component={OnboardingScreening} roles={["candidate"]} /></Route>
      <Route path="/portal/self-id"><ProtectedRoute component={PortalSelfId} roles={["candidate"]} /></Route>
      <Route path="/portal/interview-consent"><ProtectedRoute component={InterviewConsent} roles={["candidate"]} /></Route>
      <Route path="/portal/deletion-request"><ProtectedRoute component={PortalDeletionRequest} roles={["candidate"]} /></Route>
      <Route path="/portal/aedt-notice" component={AedtNotice} />
      <Route path="/admin/deletion-requests"><ProtectedRoute component={AdminDeletionRequests} roles={["platform_admin"]} /></Route>
      <Route path="/admin/transcription-health"><ProtectedRoute component={TranscriptionHealth} roles={["platform_admin"]} /></Route>
      <Route path="/admin/fairness"><ProtectedRoute component={FairnessDashboard} roles={adminRoles} /></Route>
      <Route path="/hire-pulse/:applicationId"><ProtectedRoute component={HirePulse} roles={[...recruiterRoles, "hiring_manager"]} /></Route>
      <Route path="/activity"><ProtectedRoute component={AuditPage} roles={recruiterRoles} /></Route>
      <Route path="/portal/settings"><ProtectedRoute component={PortalSettings} roles={["candidate"]} /></Route>
      <Route path="/portal/career"><ProtectedRoute component={CareerHub} roles={["candidate"]} /></Route>

      <Route path="/company/:slug" component={ClientCareersPage} />
      <Route path="/careers" component={CareersPage} />
      <Route path="/careers/:id" component={CareersJobPage} />
      <Route path="/career-register" component={CareerRegister} />
      <Route path="/portal/reset-password" component={ResetPassword} />
      <Route path="/hm/:token" component={HmPackagePage} />

      {/* ── Hiring Manager portal ─────────────────────────────── */}
      <Route path="/hiring/dashboard"><ProtectedRoute component={HiringDashboard} roles={hiringManagerRoles} /></Route>
      <Route path="/hiring/jobs"><ProtectedRoute component={HiringJobs} roles={hiringManagerRoles} /></Route>
      <Route path="/hiring/candidates"><ProtectedRoute component={HiringCandidates} roles={hiringManagerRoles} /></Route>
      <Route path="/hiring/talent-pool"><ProtectedRoute component={HiringTalentPool} roles={[...recruiterRoles, ...hiringManagerRoles]} /></Route>
      <Route path="/hiring/interviews"><ProtectedRoute component={HiringInterviews} roles={hiringManagerRoles} /></Route>

      {/* ── Interviewer portal ────────────────────────────────── */}
      <Route path="/interviewer/interviews"><ProtectedRoute component={InterviewerInterviews} roles={interviewerRoles} /></Route>

      <Route path="/portal/login" component={CandidatePortalLogin} />
      <Route path="/accept-invite" component={AcceptInvite} />
      <Route path="/accept-team-invite" component={AcceptTeamInvite} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <TourProvider>
                <ErrorBoundary>
                  {/* T011 — sticky red banner whenever a platform admin
                      has an open "view as" session. No-op for non-admins. */}
                  <ImpersonationBanner />
                  <Router />
                </ErrorBoundary>
              </TourProvider>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
