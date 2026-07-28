/*
 * App.tsx — Root of the public marketing site (lexy-site).
 *
 * Wires up the wouter router, the shared React Query / Tooltip / Toaster
 * providers, and the GDPR cookie banner. Every public page (home, employers,
 * candidates, signup/trial flows, and the legal/trust pages) is registered as
 * a route here. The router is mounted under the deploy BASE_URL so the site can
 * be served from a sub-path behind the platform proxy.
 */
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Candidates from "@/pages/candidates";
import Employers from "@/pages/employers";
import StartTrial from "@/pages/start-trial";
import Signup from "@/pages/signup";
import SignupSuccess from "@/pages/signup-success";
import Privacy from "@/pages/privacy";
import Terms from "@/pages/terms";
import Dpa from "@/pages/dpa";
import Security from "@/pages/security";
import Subprocessors from "@/pages/subprocessors";
import AiSystemCard from "@/pages/ai-system-card";
import Pricing from "@/pages/pricing";
import Trust from "@/pages/trust";
import ResponsibleAi from "@/pages/responsible-ai";
import AiTransparency from "@/pages/ai-transparency";
import FairHiring from "@/pages/fair-hiring";
import CandidateRights from "@/pages/candidate-rights";
import Compliance from "@/pages/compliance";
import Disclaimer from "@/pages/disclaimer";
import WhistleblowerPolicy from "@/pages/whistleblower-policy";
import OrderFormTerms from "@/pages/order-form-terms";
import ProhibitedUses from "@/pages/prohibited-uses";
import Blog from "@/pages/blog";
import Philosophy from "@/pages/philosophy";
import BlogPost from "@/pages/blog-post";
import CookieBanner from "@/components/CookieBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Resets scroll position to the top whenever the route changes — wouter does
// not do this automatically, so deep pages would otherwise retain scroll.
function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

const queryClient = new QueryClient();

function Router() {
  return (
    <>
      <ScrollToTop />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/candidates" component={Candidates} />
        <Route path="/employers" component={Employers} />
        <Route path="/start-trial" component={StartTrial} />
        <Route path="/blog" component={Blog} />
        <Route path="/philosophy" component={Philosophy} />
        <Route path="/blog/:slug" component={BlogPost} />
        <Route path="/signup" component={Signup} />
        <Route path="/signup-success" component={SignupSuccess} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/dpa" component={Dpa} />
        <Route path="/security" component={Security} />
        <Route path="/subprocessors" component={Subprocessors} />
        {/* T011l — public AI System Card. Linked from candidate
            disclosures, outbound email footers, and the homepage
            footer. URL must remain stable. */}
        <Route path="/trust/ai" component={AiSystemCard} />
        <Route path="/ai-system-card" component={AiSystemCard} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/trust" component={Trust} />
        <Route path="/responsible-ai" component={ResponsibleAi} />
        <Route path="/ai-transparency" component={AiTransparency} />
        <Route path="/fair-hiring" component={FairHiring} />
        <Route path="/candidate-rights" component={CandidateRights} />
        <Route path="/compliance" component={Compliance} />
        <Route path="/disclaimer" component={Disclaimer} />
        <Route path="/whistleblower-policy" component={WhistleblowerPolicy} />
        <Route path="/order-form-terms" component={OrderFormTerms} />
        <Route path="/prohibited-uses" component={ProhibitedUses} />
        <Route component={NotFound} />
      </Switch>
      <CookieBanner />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ErrorBoundary>
              <Router />
            </ErrorBoundary>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
