/** Browser-only fixture of the real component. Not imported by application routes. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../lib/auth-context";
import { MeetingAttendancePanel } from "../components/meeting-attendance-panel";
import "../index.css";

export function mountAttendanceFixture(host: HTMLElement) {
  if (!import.meta.env.DEV) throw new Error("Development-only fixture.");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(host).render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <main className="mx-auto max-w-4xl p-6">
          <MeetingAttendancePanel
            jobId="attendance-fixture-job"
            candidateId="attendance-fixture-candidate"
          />
        </main>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
