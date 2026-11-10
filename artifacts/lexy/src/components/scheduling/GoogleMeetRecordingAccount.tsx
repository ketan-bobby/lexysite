import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMyGoogleMeetRecordingAccountQueryKey,
  useConnectMyGoogleMeetRecordingAccount,
  useDisconnectMyGoogleMeetRecordingAccount,
  useGetMyGoogleMeetRecordingAccount,
} from "@workspace/api-client-react";
import { FileVideo, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { safeGoogleMeetAuthUrl, shouldShowStatus, errStatus } from "./google-meet-recording-state";

const STAFF_ROLES = new Set([
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
]);
const DENIED = new Set([401, 403, 404]);

export function GoogleMeetRecordingAccount() {
  const { user } = useAuth();
  return user && STAFF_ROLES.has(user.role) ? (
    <Inner
      key={`${user.id}:${user.tenantId ?? ""}`}
      actorId={user.id}
      tenantId={user.tenantId ?? ""}
    />
  ) : null;
}

const STATE_LABEL = {
  setup_required: "Setup required",
  disconnected: "Not connected",
  authorization_pending: "Authorization pending",
  connected: "Connected",
  reconnect_required: "Reconnect required",
} as const;

function Inner({ actorId, tenantId }: { actorId: string; tenantId: string }) {
  const qc = useQueryClient();
  const queryKey = [...getGetMyGoogleMeetRecordingAccountQueryKey(), actorId, tenantId];
  const q = useGetMyGoogleMeetRecordingAccount({
    query: {
      queryKey,
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      retry: (n, e) => !DENIED.has(errStatus(e) ?? 0) && n < 1,
    },
  });
  const connectM = useConnectMyGoogleMeetRecordingAccount();
  const disconnectM = useDisconnectMyGoogleMeetRecordingAccount();

  const [consent, setConsent] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [callback] = useState(() => {
    const v = new URLSearchParams(window.location.search).get("googleMeetRecordings");
    return v === "connected" || v === "error" ? v : null;
  });
  const alive = useRef(true);
  // Set when a mutation is denied; holds the query timestamp at denial time.
  const [actionDeniedAt, setActionDeniedAt] = useState<number | null>(null);

  const readFailing = q.isError || q.failureReason != null;
  const denied =
    actionDeniedAt !== null ||
    DENIED.has(errStatus(q.error) ?? 0) ||
    DENIED.has(errStatus(q.failureReason) ?? 0);
  // Never show cached private data while a read is failing or access was denied.
  const status = shouldShowStatus({ readFailing, denied }) ? q.data : undefined;
  const state = status?.state;
  const revision = status?.revision ?? null;
  const busy = connectM.isPending || disconnectM.isPending || redirecting;

  useEffect(() => {
    alive.current = true;
    if (callback) {
      void qc.invalidateQueries({ queryKey });
      const url = new URL(window.location.href);
      url.searchParams.delete("googleMeetRecordings");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    return () => {
      alive.current = false;
      qc.removeQueries({ queryKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the mutation denial only after a fresh, successful authoritative read.
  useEffect(() => {
    if (
      actionDeniedAt !== null &&
      q.isSuccess &&
      !q.isFetching &&
      q.failureReason == null &&
      q.dataUpdatedAt > actionDeniedAt
    )
      setActionDeniedAt(null);
  }, [actionDeniedAt, q.isSuccess, q.isFetching, q.failureReason, q.dataUpdatedAt]);

  useEffect(() => {
    if (denied || readFailing) {
      setConsent(false);
      setConfirmDisconnect(false);
    }
  }, [denied, readFailing]);

  function handleMutationError(e: unknown, message: string) {
    if (!alive.current) return;
    if (DENIED.has(errStatus(e) ?? 0)) {
      setActionDeniedAt(Math.max(Date.now(), q.dataUpdatedAt));
      setConsent(false);
      setConfirmDisconnect(false);
    }
    setActionError(message);
    void qc.invalidateQueries({ queryKey });
  }

  useEffect(() => {
    setConfirmDisconnect(false);
    if (state === "connected") setConsent(false);
  }, [revision, state]);

  function connect() {
    if (!consent || busy) return;
    setActionError(null);
    connectM.mutate(
      { data: { confirmRecordingAccess: true } },
      {
        onSuccess: (res) => {
          if (!alive.current) return;
          setConsent(false);
          void qc.invalidateQueries({ queryKey });
          const url = safeGoogleMeetAuthUrl(res.authorizationUrl);
          if (!url) {
            setActionError(
              "Lexy returned an unexpected authorization address, so no redirect happened. Nothing was connected.",
            );
            return;
          }
          setRedirecting(true);
          window.location.assign(url);
        },
        onError: (e) =>
          handleMutationError(
            e,
            "Google authorization could not be started. Nothing was connected; try again.",
          ),
      },
    );
  }

  function disconnect() {
    if (!revision || busy) return;
    setActionError(null);
    disconnectM.mutate(
      { data: { revision, confirmDisconnect: true } },
      {
        onSuccess: (next) => {
          if (!alive.current) return;
          qc.setQueryData(queryKey, next);
          setConsent(false);
          setConfirmDisconnect(false);
          void qc.invalidateQueries({ queryKey });
        },
        onError: (e) =>
          handleMutationError(
            e,
            "Disconnect could not be confirmed. Status is re-read from Lexy; try again.",
          ),
      },
    );
  }

  const canConnect =
    !!status?.configured &&
    (state === "disconnected" ||
      state === "reconnect_required" ||
      state === "authorization_pending");

  return (
    <Card data-testid="google-meet-recording-account">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileVideo className="h-5 w-5" /> Google Meet recordings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Optional</Badge>
          <Badge variant="outline">Read-only · separate grant</Badge>
          {status && (
            <Badge
              variant={state === "connected" ? "default" : "outline"}
              data-testid="status-google-meet-recording-state"
            >
              {STATE_LABEL[status.state] ?? "Unknown"}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">
          A separate, optional read-only permission for recordings of Meet interviews you host. It
          does not change your Google Calendar connection. Lexy does not download, transcribe or
          score anything automatically. This step only connects the account; recording import
          controls are still to come, and each import will need your review.
        </p>

        {callback === "connected" && (
          <p
            role="status"
            className="rounded-md border px-3 py-2"
            data-testid="text-google-meet-callback-connected"
          >
            Google returned you to Lexy. The status below is re-read from the server and is the only
            confirmation.
          </p>
        )}
        {callback === "error" && (
          <p
            role="alert"
            className="text-destructive"
            data-testid="text-google-meet-callback-error"
          >
            Google authorization did not complete. Nothing is assumed; status below comes from Lexy.
          </p>
        )}

        {q.isLoading && (
          <div
            className="h-14 rounded-lg bg-muted animate-pulse"
            aria-label="Loading Google Meet recording status"
          />
        )}
        {denied ? (
          <div
            role="alert"
            className="space-y-2 text-destructive"
            data-testid="text-google-meet-access-denied"
          >
            <p>
              Access could not be confirmed. Check again or sign in again; account details stay
              hidden until access is confirmed.
            </p>
            <Button
              variant="outline"
              disabled={q.isFetching || busy}
              onClick={() => {
                setConsent(false);
                setConfirmDisconnect(false);
                setActionError(null);
                void q.refetch();
              }}
              data-testid="button-google-meet-check-access"
            >
              {q.isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Check access again
            </Button>
          </div>
        ) : (
          readFailing && (
            <div role="alert" className="space-y-2 text-destructive">
              <p>Google Meet recording status could not be loaded. No cached details are shown.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void q.refetch()}
                data-testid="button-google-meet-retry"
              >
                Retry
              </Button>
            </div>
          )
        )}

        {status && (
          <>
            {state === "setup_required" || !status.configured ? (
              <p className="text-muted-foreground" data-testid="text-google-meet-setup">
                Not set up for this workspace yet. An administrator must finish setup; no secrets
                are entered here.
              </p>
            ) : state === "connected" ? (
              <p data-testid="text-google-meet-connected">
                Connected as{" "}
                <span className="font-medium break-all">
                  {status.accountEmail ?? "your Google account"}
                </span>
                {status.connectedAt && (
                  <span className="text-muted-foreground">
                    {" "}
                    since {new Date(status.connectedAt).toLocaleDateString()}
                  </span>
                )}
                . Recording read permission: {status.canReadRecordings ? "granted" : "not granted"}.
              </p>
            ) : state === "reconnect_required" ? (
              <p role="status" className="text-destructive">
                Recording access needs re-authorization
                {status.accountEmail ? ` for ${status.accountEmail}` : ""}.
              </p>
            ) : state === "authorization_pending" ? (
              <p role="status" className="text-muted-foreground">
                Authorization is pending. Only the status shown here confirms a connection.
              </p>
            ) : (
              <p className="text-muted-foreground">Not connected.</p>
            )}

            {status.redirectUri && (
              <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 font-medium">
                  <ShieldCheck className="h-4 w-4" /> Operator setup
                </p>
                <p className="text-muted-foreground">
                  Register this extra authorized redirect URI on the Google OAuth client (in
                  addition to the Calendar one):
                </p>
                <code
                  className="block break-all rounded bg-background px-2 py-1 font-mono text-xs"
                  data-testid="text-google-meet-redirect-uri"
                >
                  {status.redirectUri}
                </code>
                <p className="text-xs text-muted-foreground">
                  Meet recording access uses a restricted Google scope, which requires Google
                  verification of the OAuth app before use beyond test users.
                </p>
              </div>
            )}

            {canConnect && (
              <div className="space-y-3 rounded-lg border p-3">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={consent}
                    disabled={busy}
                    onChange={(e) => setConsent(e.target.checked)}
                    data-testid="checkbox-google-meet-consent"
                  />
                  <span>
                    I am granting read-only access to recordings of Meet interviews I host, from my
                    own Google account. This is separate from my Calendar connection and starts no
                    download, transcription or scoring.
                  </span>
                </label>
                <Button
                  onClick={connect}
                  disabled={!consent || busy}
                  data-testid="button-google-meet-connect"
                >
                  {(connectM.isPending || redirecting) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {state === "reconnect_required"
                    ? "Reconnect recording access"
                    : "Connect recording access"}
                </Button>
              </div>
            )}

            {(state === "connected" ||
              state === "reconnect_required" ||
              state === "authorization_pending") &&
              (!confirmDisconnect ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy || !revision}
                  data-testid="button-google-meet-disconnect"
                >
                  {state === "authorization_pending"
                    ? "Cancel pending authorization"
                    : "Disconnect recording access"}
                </Button>
              ) : (
                <div className="space-y-2 rounded-lg border p-3">
                  <p>
                    Remove the recording grant? Your Google Calendar connection is not affected.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={disconnect}
                      disabled={busy}
                      data-testid="button-google-meet-disconnect-confirm"
                    >
                      {disconnectM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDisconnect(false)}
                      disabled={busy}
                      data-testid="button-google-meet-disconnect-keep"
                    >
                      Keep
                    </Button>
                  </div>
                </div>
              ))}
          </>
        )}

        {actionError && (
          <p role="alert" className="text-destructive" data-testid="text-google-meet-action-error">
            {actionError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
