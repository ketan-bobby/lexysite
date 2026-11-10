/** Isolated regression entry only; never imported by the application's router. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { CandidateGoogleMeet } from "../components/scheduling/CandidateGoogleMeet";
import "../index.css";

type Props = { scheduleId: string; scheduledAt: string; durationMinutes: number | null };
function Actor() {
  const { user } = useAuth();
  return <span data-testid="fixture-actor">{user?.id ?? "none"}</span>;
}

export function mountMeetFixture(host: HTMLElement, initial: Props) {
  if (!import.meta.env.DEV) throw new Error("development-only fixture");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  const render = (p: Props) =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <main className="p-4">
            <Actor />
            <div className="flex flex-wrap gap-2" data-testid="actions">
              <button data-testid="button-prep" type="button">
                Prep
              </button>
              <CandidateGoogleMeet
                scheduleId={p.scheduleId}
                scheduledAt={p.scheduledAt}
                durationMinutes={p.durationMinutes}
              />
            </div>
          </main>
        </AuthProvider>
      </QueryClientProvider>,
    );
  render(initial);
  return {
    setProps: render,
    unmount: () => root.unmount(),
    switchActor: (u: User | null) => client.setQueryData(["auth/me"], u),
  };
}
