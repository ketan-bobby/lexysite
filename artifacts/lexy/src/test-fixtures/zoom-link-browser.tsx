/** Isolated regression entry only; never imported by the application's router. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { StaffZoomLink } from "../components/scheduling/StaffZoomLink";
import { CandidateZoomLink } from "../components/scheduling/CandidateZoomLink";
import "../index.css";

type S = {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  type: string;
  version: string;
};
function Actor() {
  const { user } = useAuth();
  return <span data-testid="fixture-actor">{user ? `${user.id}:${user.role}` : "none"}</span>;
}
function Page({ schedule }: { schedule: S }) {
  const [shown, setShown] = useState(true);
  return (
    <main className="p-4 space-y-4">
      <Actor />
      <button data-testid="fixture-toggle" onClick={() => setShown((x) => !x)}>
        toggle
      </button>
      {shown && <StaffZoomLink schedule={schedule} />}
      {shown && <CandidateZoomLink scheduleId={schedule.id} />}
    </main>
  );
}
export function mountZoomFixture(host: HTMLElement, initial: S) {
  if (!import.meta.env.DEV) throw new Error("development-only fixture");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  const render = (s: S) =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Page schedule={s} />
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
