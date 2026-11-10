/** Isolated regression entry only; never imported by the application's router. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { GooglePanelConsent } from "../components/scheduling/GooglePanelConsent";
import { PanelTimeFinder } from "../components/scheduling/PanelTimeFinder";
import { GooglePanelTimeFinder } from "../components/scheduling/GooglePanelTimeFinder";
import type { ScheduleEditRecord } from "../lib/schedule-edit";
import "../index.css";

function Actor() {
  const { user } = useAuth();
  return <span data-testid="fixture-actor">{user ? `${user.id}:${user.role}` : "none"}</span>;
}
function Page({ schedule }: { schedule: ScheduleEditRecord }) {
  const [shown, setShown] = useState(true);
  return (
    <main className="p-4 space-y-4">
      <Actor />
      <GooglePanelConsent />
      <button data-testid="fixture-toggle" onClick={() => setShown((x) => !x)}>
        toggle
      </button>
      {shown && <GooglePanelTimeFinder schedule={schedule} />}
      {(window as unknown as { __outlook?: boolean }).__outlook && (
        <PanelTimeFinder schedule={schedule} />
      )}
    </main>
  );
}
export function mountGoogleFixture(host: HTMLElement, initial: ScheduleEditRecord) {
  if (!import.meta.env.DEV) throw new Error("development-only fixture");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  const render = (s: ScheduleEditRecord) =>
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
