import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { Toaster } from "../components/ui/toaster";
import { WorkflowHandoffReceipt } from "../components/jobs/WorkflowHandoffReceipt";
import { SignOutAllDevices } from "../components/settings/SignOutAllDevices";
import "../index.css";

export function mountSecurityFixture(host: HTMLElement) {
  if (!import.meta.env.DEV) throw Error("Development fixture only");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(host);
  let setAuthority: (enabled: boolean) => void = () => {};
  const records: string[] = [];
  function Fixture() {
    const { user, logout } = useAuth();
    const [enabled, setEnabled] = useState(true);
    const [receipt, setReceipt] = useState<{
      recordedBy: string;
      recordedAt: string;
      evidenceReference: string;
      verification: "human_reported_only";
    }>();
    setAuthority = setEnabled;
    return (
      <main className="p-6 space-y-5">
        <h1>Isolated session and employer handoff regression</h1>
        <p data-testid="auth-identity">{user?.id ?? "Anonymous"}</p>
        <button data-testid="logout-ui" onClick={logout}>
          Sign out
        </button>
        <SignOutAllDevices />
        <WorkflowHandoffReceipt
          workflowId="fixture"
          enabled={enabled}
          packet={{
            id: "packet-one",
            snapshotHash: "a".repeat(64),
            approvedAt: "2026-11-10T00:00:00Z",
            exportedAt: "2026-11-10T00:00:00Z",
            handoffReceipt: receipt,
          }}
          onRecord={(reference) => {
            records.push(reference);
            setReceipt({
              recordedBy: "synthetic-owner",
              recordedAt: new Date().toISOString(),
              evidenceReference: reference,
              verification: "human_reported_only",
            });
          }}
        />
        <Toaster />
      </main>
    );
  }
  root.render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Fixture />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return {
    setAuthority: (enabled: boolean) => setAuthority(enabled),
    switchIdentity: () =>
      client.setQueryData(["auth/me"], {
        ...client.getQueryData<object>(["auth/me"]),
        id: "different-fixture-user",
      }),
    records,
    unmount: () => {
      root.unmount();
      client.clear();
    },
  };
}
