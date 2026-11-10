/** Isolated browser-regression entry, never imported by the app router. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { AuthProvider } from "../lib/auth-context";
import { TooltipProvider } from "../components/ui/tooltip";
import { TourProvider } from "../lib/tour/TourProvider";
import MailHolds from "../pages/admin/mail-holds";
import "../index.css";

export function mountMailHoldsFixture(host: HTMLElement) {
  if (!import.meta.env.DEV) throw new Error("Development fixture only");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(host);
  root.render(
    <Router>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <TooltipProvider>
            <TourProvider>
              <MailHolds />
            </TourProvider>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </Router>,
  );
  return {
    refresh: () => client.invalidateQueries({ queryKey: ["/api/platform/mail-holds"] }),
    switchActor: (actor: unknown) => client.setQueryData(["auth/me"], actor),
    unmount: () => {
      root.unmount();
      client.clear();
    },
  };
}
