/** Isolated browser entry; never imported by the application router. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth-context";
import { ZohoInterviewCampaigns } from "../components/ats/ZohoInterviewCampaigns";
import "../index.css";

export function mountZohoFixture(host: HTMLElement, connected = true) {
  if (!import.meta.env.DEV) throw new Error("development-only fixture");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  (
    window as Window & { setFixtureIdentity?: (user: unknown) => Promise<void> }
  ).setFixtureIdentity = async (user) => {
    await fetch("/__fixture/set-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });
    client.setQueryData(["auth/me"], user);
    await client.refetchQueries({ queryKey: ["auth/me"], exact: true });
    return client.getQueryData(["auth/me"]);
  };
  const render = (providerAvailable: boolean) =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <main className="mx-auto max-w-4xl p-4">
            <ZohoInterviewCampaigns
              revision={providerAvailable ? "a".repeat(64) : null}
              providerAvailable={providerAvailable}
            />
          </main>
        </AuthProvider>
      </QueryClientProvider>,
    );
  (window as Window & { setZohoConnection?: (available: boolean) => void }).setZohoConnection =
    render;
  render(connected);
  return () => root.unmount();
}
