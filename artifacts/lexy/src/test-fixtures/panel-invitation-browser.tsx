/** Isolated regression entry only; never imported by the application's router. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { OutlookPanelInvitation } from "../components/scheduling/OutlookPanelInvitation";
import { GoogleStaffCalendar } from "../components/scheduling/GoogleStaffCalendar";
import { GoogleInterviewInvitation } from "../components/scheduling/GoogleInterviewInvitation";
import { GoogleInvitationOperation } from "../components/scheduling/GoogleInvitationOperation";
import { GoogleCalendarPilot } from "../components/scheduling/GoogleCalendarPilot";
import type { InvitationSchedule } from "../components/scheduling/outlook-invitation-state";
import "../index.css";

function CurrentActor() {
  const { user } = useAuth();
  return <span data-testid="fixture-actor">{user?.id ?? "none"}</span>;
}

export function mountPanelInvitationFixture(
  host: HTMLElement,
  initial: InvitationSchedule,
  googleOnly = false,
  googleStaff = false,
  googleInvite = false,
  googleOperation = false,
) {
  if (!import.meta.env.DEV) throw new Error("Panel invitation fixture is development-only");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(host);
  const realNow = Date.now.bind(Date);
  const originalInterval = window.setInterval.bind(window);
  const originalClear = window.clearInterval.bind(window);
  let offset = 0;
  let nextId = -1;
  const clocks = new Map<number, () => void>();
  // Drive only the component's five-second freshness clock, not real timers,
  // network delays, or application code. This avoids a 90-second test sleep.
  Date.now = () => realNow() + offset;
  window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 5_000 && typeof callback === "function") {
      const id = nextId--;
      clocks.set(id, () => callback(...args));
      return id;
    }
    return originalInterval(callback, delay, ...args);
  }) as typeof window.setInterval;
  window.clearInterval = (id) => {
    if (typeof id === "number" && clocks.delete(id)) return;
    originalClear(id);
  };
  const render = (schedule: InvitationSchedule) =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <main className="p-4">
            <CurrentActor />
            {googleOperation ? (
              <GoogleInvitationOperation schedule={schedule} />
            ) : googleInvite ? (
              <GoogleInterviewInvitation schedule={schedule} />
            ) : googleStaff ? (
              <GoogleStaffCalendar />
            ) : googleOnly ? (
              <GoogleCalendarPilot />
            ) : (
              <OutlookPanelInvitation schedule={schedule} />
            )}
          </main>
        </AuthProvider>
      </QueryClientProvider>,
    );
  render(initial);
  return {
    switchSchedule: render,
    refetchStatus: () => client.invalidateQueries({ queryKey: ["/api/google-calendar/me"] }),
    switchActor: (user: User) => client.setQueryData(["auth/me"], user),
    advanceClock(milliseconds: number) {
      offset += milliseconds;
      for (const tick of clocks.values()) tick();
    },
    unmount() {
      root.unmount();
      client.clear();
      Date.now = realNow;
      window.setInterval = originalInterval;
      window.clearInterval = originalClear;
    },
  };
}
