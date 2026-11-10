/** Development-only browser-test entry; never imported by the application router. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth-context";
import { ZohoStageRequests } from "../components/ats/ZohoStageRequests";
import "../index.css";

export function mountStageRequestFixture(
  host: HTMLElement,
  campaignId: string,
  recipientId: string,
) {
  if (!import.meta.env.DEV) throw new Error("development-only fixture");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  root.render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <main className="mx-auto max-w-3xl p-4">
          <ZohoStageRequests
            campaignId={campaignId}
            recipientId={recipientId}
            reviewRevision={"a".repeat(64)}
          />
        </main>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { unmount: () => root.unmount(), client };
}
