import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppLayout } from "@/components/layout/AppLayout";
import type { ZohoRecruitAccountView } from "@workspace/api-client-react";
import { zohoCallbackError } from "@/lib/zoho-callback-error";
import { ZohoAccessCheck } from "@/components/ats/ZohoAccessCheck";
import { ZohoReviewedImport } from "@/components/ats/ZohoReviewedImport";
import { ZohoJobApplicants } from "@/components/ats/ZohoJobApplicants";
import { ZohoInterviewCampaigns } from "@/components/ats/ZohoInterviewCampaigns";
import { RecallConnectionCheck } from "@/components/recall-connection-check";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`${apiBase}/zoho-recruit/account${path}`, {
    cache: "no-store",
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Zoho Recruit could not be checked. Try again.");
  }
  return response.json() as Promise<T>;
}
export default function AtsSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [stageConsent, setStageConsent] = useState(false);
  const [noteConsent, setNoteConsent] = useState(false);
  const [stageWriteConsent, setStageWriteConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const embedded = window.self !== window.top;
  const callbackError = zohoCallbackError(window.location.search);
  const allowed = user?.role === "tenant_admin";
  const key = ["zoho-recruit-account", user?.id, user?.tenantId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => request<ZohoRecruitAccountView>(""),
    enabled: allowed,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
    retry: false,
  });
  const view = query.data;
  const providerReady =
    allowed &&
    view?.state === "connected" &&
    !!view.revision &&
    !query.isError &&
    !query.isLoading &&
    !busy;
  useEffect(() => {
    setConsent(false);
    setStageConsent(false);
    setNoteConsent(false);
    setStageWriteConsent(false);
    setError("");
  }, [view?.revision, view?.state, view?.region, user?.id, user?.tenantId]);
  async function act(action: "connect" | "approve" | "disconnect") {
    if ((action === "connect" || action === "approve") && !consent) return;
    if (
      action === "disconnect" &&
      !window.confirm(
        "Remove Lexy's stored Zoho authorization? This will not revoke consent in Zoho or delete imported data.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (action === "connect") {
        const result = await request<{ authorizationUrl: string }>("/connect", {
          confirmEmployerAuthority: true,
          includeStageMetadata: stageConsent,
          includeInterviewNotes: noteConsent,
          includeStageWrites: stageWriteConsent,
        });
        const url = new URL(result.authorizationUrl);
        const expectedOrigin =
          view?.region === "United States"
            ? "https://accounts.zoho.com"
            : view?.region === "India"
              ? "https://accounts.zoho.in"
              : null;
        if (!expectedOrigin || url.origin !== expectedOrigin || url.pathname !== "/oauth/v2/auth")
          throw new Error("Zoho authorization URL is invalid.");
        window.location.assign(url.toString());
      } else {
        await request<ZohoRecruitAccountView>(`/${action}`, {
          revision: view?.revision,
          confirm: true,
        });
        setConsent(false);
        await qc.invalidateQueries({ queryKey: key });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoho authorization failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppLayout>
      <div className="mx-auto max-w-3xl space-y-6 p-3 sm:p-6">
        <div>
          <Link href="/recruiter/settings" className="text-sm text-primary">
            Back to settings
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">ATS connections</h1>
          <p className="mt-2 text-muted-foreground">
            Connect employer-owned recruiting systems without replacing Lexy's native hiring
            workflow.
          </p>
        </div>
        <RecallConnectionCheck key={`recall:${user?.id}:${user?.tenantId}:${user?.role}`} />
        <Card>
          <CardHeader>
            <CardTitle>Zoho Recruit{view?.region ? ` · ${view.region}` : ""}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p>
              This direct Lexy connection uses the saved Zoho application credentials—not Replit's
              Connect button. Candidate/job imports require explicit review. Interview campaigns
              send real invitations only after employer approval; no Zoho stage changes or offers
              run here.
            </p>
            {embedded && (
              <p>
                Zoho sign-in must run outside the embedded preview.{" "}
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  Open these settings in a new tab
                </a>
                , and sign in there if prompted.
              </p>
            )}
            {!allowed ? (
              <p role="status">
                An employer administrator must sign in to authorize this connection. Platform and
                agency access alone do not establish employer authority.
              </p>
            ) : (
              <>
                {query.isLoading && <p role="status">Checking connection…</p>}
                {query.isError && (
                  <div role="alert">
                    <p>{query.error.message}</p>
                    <Button variant="outline" onClick={() => void query.refetch()}>
                      Retry connection check
                    </Button>
                  </div>
                )}
                {view && (
                  <>
                    <p>
                      <strong>{query.isError ? "Last saved status: " : "Status: "}</strong>
                      {
                        {
                          disconnected: "Not connected",
                          review_required: "Authorization received—employer review required",
                          connected: "Authorized and employer-confirmed",
                          reconnect_required: "Configuration changed—reconnect required",
                        }[view.state]
                      }
                    </p>
                    {!view.configured && (
                      <p role="alert">
                        Server setup is incomplete. Configure ZOHO_REDIRECT_URI and
                        ZOHO_SETTINGS_URL alongside the saved Client ID and Client Secret. Check
                        ZOHO_DATA_CENTER (us or in). HTTPS and the exact callback path are required.
                      </p>
                    )}
                    {view.redirectUri && (
                      <div>
                        <p>
                          Register this exact authorized redirect URI in your Zoho API Console
                          application:
                        </p>
                        <code className="mt-2 block break-all rounded bg-muted p-3">
                          {view.redirectUri}
                        </code>
                      </div>
                    )}
                    {callbackError &&
                      (view.state === "disconnected" || view.state === "reconnect_required") && (
                        <p role="alert">{callbackError}</p>
                      )}
                    {view.companyName && (
                      <p>
                        <strong>Zoho company: </strong>
                        {view.companyName}
                      </p>
                    )}
                    {(view.state === "disconnected" || view.canApprove) && (
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={consent}
                          onChange={(e) => setConsent(e.target.checked)}
                          className="mt-1"
                        />
                        <span>
                          {view.canApprove
                            ? "I reviewed the displayed Zoho company and confirm this account belongs to this Lexy employer."
                            : stageWriteConsent
                              ? "I am authorized by this employer to request candidate update permission for controlled stage changes. This does not enable automatic updates or offers."
                              : noteConsent
                                ? "I am authorized by this employer to connect its Zoho Recruit account for read access and reviewed interview-note creation."
                                : "I am authorized by this employer to connect its Zoho Recruit account for read-only access."}
                        </span>
                      </label>
                    )}
                    {view.state === "disconnected" && (
                      <label className="flex items-start gap-3 text-sm">
                        <input
                          type="checkbox"
                          checked={stageConsent}
                          disabled={busy}
                          data-testid="checkbox-zoho-stage-consent"
                          onChange={(e) => setStageConsent(e.target.checked)}
                        />
                        <span>
                          Also request read-only stage metadata access. This adds no write
                          permission.
                        </span>
                      </label>
                    )}
                    {view.state === "disconnected" && (
                      <label className="flex items-start gap-3 text-sm">
                        <input
                          type="checkbox"
                          checked={noteConsent}
                          disabled={busy}
                          data-testid="checkbox-zoho-notes-consent"
                          onChange={(e) => setNoteConsent(e.target.checked)}
                        />
                        <span>
                          Also allow reviewed interview progress and assessments to be published as
                          candidate notes in Zoho. This requests note creation permission, not stage
                          or offer changes.
                        </span>
                      </label>
                    )}
                    <div className="flex flex-wrap gap-3">
                      {view.state === "disconnected" && (
                        <label className="flex items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={stageWriteConsent}
                            disabled={busy}
                            data-testid="checkbox-zoho-stage-write-consent"
                            onChange={(e) => setStageWriteConsent(e.target.checked)}
                          />
                          <span>
                            Also request candidate update permission for controlled stage changes.
                            This grants a broader candidate-update capability in Zoho, not just a
                            single stage field. Lexy will not use it for global profile updates,
                            offers, or automatic dispatch. Application-specific transition
                            verification is still required before any live stage change.
                          </span>
                        </label>
                      )}
                      {view.state === "disconnected" && (
                        <Button
                          disabled={
                            embedded || !view.configured || !consent || busy || query.isFetching
                          }
                          onClick={() => void act("connect")}
                        >
                          Connect Zoho Recruit
                        </Button>
                      )}
                      {view.canApprove && (
                        <Button
                          disabled={!consent || busy || query.isFetching}
                          onClick={() => void act("approve")}
                        >
                          Confirm employer account
                        </Button>
                      )}
                      {view.revision && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void act("disconnect")}
                        >
                          Disconnect locally
                        </Button>
                      )}
                    </div>
                    {view.state === "review_required" && !view.canApprove && (
                      <p>
                        The administrator who authorized Zoho must confirm this account, or an
                        employer administrator can disconnect it locally.
                      </p>
                    )}
                    {view.state === "reconnect_required" && (
                      <p role="status">
                        Zoho now needs application-search permission to review applicants by job.
                        Disconnect locally, then reconnect and confirm the employer account again.
                        This does not remove previously imported Lexy records.
                      </p>
                    )}
                    {view.state === "connected" && (
                      <p className="text-muted-foreground">
                        Account authorization is saved. Use the manual check below to verify read
                        permissions. Import individual records only after reviewing them below.
                      </p>
                    )}
                    {providerReady && view.revision && (
                      <ZohoAccessCheck
                        key={[user?.id, user?.tenantId, view.revision, view.connectedAt].join(":")}
                        revision={view.revision}
                      />
                    )}
                    {providerReady && view.revision && (
                      <ZohoReviewedImport
                        key={`import:${user?.id}:${user?.tenantId}:${view.revision}:${view.connectedAt}`}
                        revision={view.revision}
                      />
                    )}
                    {providerReady && view.revision && (
                      <ZohoJobApplicants
                        key={`applicants:${user?.id}:${user?.tenantId}:${view.revision}:${view.connectedAt}`}
                        revision={view.revision}
                      />
                    )}
                  </>
                )}
              </>
            )}
            {busy && <p role="status">Processing…</p>}
            {error && <p role="alert">{error}</p>}
          </CardContent>
        </Card>
        {allowed && (
          <ZohoInterviewCampaigns
            key={`campaigns:${user?.id}:${user?.tenantId}:${user?.role}`}
            revision={view?.revision ?? null}
            providerAvailable={providerReady}
          />
        )}
      </div>
    </AppLayout>
  );
}
