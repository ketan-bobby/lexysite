import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Video } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { apiBase, apiFetch as authenticatedFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ZoomStaffAccountView, ZoomStaffAuthorization } from "@workspace/api-client-react";

const staffRoles = new Set([
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
]);
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "Zoom account could not be checked. Try again.");
  }
  return response.json() as Promise<T>;
}
export function ZoomStaffAccount() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowed = !!user && staffRoles.has(user.role);
  const key = ["zoom-staff-account", user?.id, user?.tenantId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => request<ZoomStaffAccountView>("/zoom-account/me"),
    enabled: allowed,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
  if (!allowed) return null;
  const status = q.data;
  async function begin() {
    if (!consent) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<ZoomStaffAuthorization>("/zoom-account/me/connect", {
        method: "POST",
        body: JSON.stringify({ confirmOwnZoom: true }),
      });
      const url = new URL(result.authorizationUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "zoom.us" ||
        url.pathname !== "/oauth/authorize"
      )
        throw new Error("Zoom authorization URL is invalid.");
      window.location.assign(url.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoom could not start authorization.");
      setBusy(false);
    }
  }
  async function disconnect() {
    if (
      !status?.revision ||
      !window.confirm("Disconnect this Zoom account? Existing Zoom meetings are not cancelled.")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await request<ZoomStaffAccountView>("/zoom-account/me/disconnect", {
        method: "POST",
        body: JSON.stringify({ revision: status.revision, confirmDisconnect: true }),
      });
      await qc.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoom could not be disconnected.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card data-testid="zoom-staff-account">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Video className="h-5 w-5" /> Your Zoom account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Connect your own Zoom host account to create interview meetings after explicit approval.
          This does not send candidate invitations or share your Zoom account with other employers.
        </p>
        {q.isPending ? (
          <p>Checking Zoom account…</p>
        ) : q.isError ? (
          <Button variant="outline" onClick={() => void q.refetch()}>
            Retry Zoom status
          </Button>
        ) : status?.connected ? (
          <>
            <p role="status">
              Connected as {status.email}. Meeting actions still need separate approval.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>
              Disconnect Zoom
            </Button>
          </>
        ) : status?.configured ? (
          <>
            <p role="status">
              {status.needsReconnect
                ? "Reconnect your Zoom account to continue."
                : "No Zoom host account connected."}
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I am connecting my own Zoom host account.
            </label>
            <Button disabled={!consent || busy} onClick={() => void begin()}>
              Connect Zoom
            </Button>
          </>
        ) : (
          <p role="status">
            Zoom app setup is required before staff accounts can connect. Staff-provided links still
            work.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
