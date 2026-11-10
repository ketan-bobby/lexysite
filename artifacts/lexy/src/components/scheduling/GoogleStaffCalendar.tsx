import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  checkMyGoogleCalendarAvailability,
  connectMyGoogleCalendar,
  disconnectMyGoogleCalendar,
  getGetMyGoogleCalendarQueryKey,
  getMyGoogleCalendar,
  type GoogleStaffAvailabilityReceipt,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarCheck, Loader2 } from "lucide-react";

const STAFF_ROLES = [
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
];
const DAY = 86_400_000;

function safeGoogleAuthUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "accounts.google.com" || u.port) return null;
    if (u.username || u.password || u.pathname !== "/o/oauth2/v2/auth") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function GoogleStaffCalendar() {
  const { user } = useAuth();
  return user && STAFF_ROLES.includes(user.role) ? (
    <Inner
      key={`${user.id}:${user.tenantId ?? ""}`}
      actorId={user.id}
      tenantId={user.tenantId ?? ""}
    />
  ) : null;
}

const RESULT_LABEL = {
  free: "Free for this interval",
  busy: "Busy during this interval",
  outside_working_hours: "Outside your working hours",
} as const;

function Inner({ actorId, tenantId }: { actorId: string; tenantId: string }) {
  const qc = useQueryClient();
  const queryKey = [...getGetMyGoogleCalendarQueryKey(), actorId, tenantId];
  const statusQ = useQuery({ queryKey, queryFn: ({ signal }) => getMyGoogleCalendar({ signal }) });
  const status = statusQ.data;
  const revision = status?.revision ?? null;

  const [consent, setConsent] = useState(false);
  const [allowInvites, setAllowInvites] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<null | "connect" | "disconnect">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState("30");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<GoogleStaffAvailabilityReceipt | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const actionCtl = useRef<AbortController | null>(null);
  // Callback query is only a hint to show a generic notice; never proof of state.
  const [callbackFailed] = useState(
    () => new URLSearchParams(window.location.search).get("googleCalendar") === "error",
  );
  const checkCtl = useRef<AbortController | null>(null);

  function clearAvailability() {
    checkCtl.current?.abort();
    checkCtl.current = null;
    setChecking(false);
    setResult(null);
    setCheckError(null);
  }
  const clearRef = useRef(clearAvailability);
  clearRef.current = clearAvailability;

  useEffect(() => {
    clearRef.current();
    setConfirmDisconnect(false);
  }, [revision, status?.state]);
  useEffect(() => {
    const onFocus = () => clearRef.current();
    window.addEventListener("focus", onFocus);
    alive.current = true;
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      checkCtl.current?.abort();
      actionCtl.current?.abort();
      // Query key is not user-scoped: drop it so another actor never sees it.
      qc.removeQueries({ queryKey });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    if (lock.current || !consent) return;
    lock.current = true;
    const ctl = new AbortController();
    actionCtl.current = ctl;
    const live = () => alive.current && !ctl.signal.aborted;
    setBusy("connect");
    setActionError(null);
    try {
      const res = await connectMyGoogleCalendar(
        { confirmOwnCalendar: true, allowInvitations: allowInvites && consent },
        { signal: ctl.signal },
      );
      if (!live()) return;
      const url = safeGoogleAuthUrl(res.authorizationUrl);
      if (!url) throw new Error("bad url");
      window.location.assign(url);
    } catch {
      if (!live()) return;
      setActionError(
        "Google authorization could not be started. Nothing was connected; try again.",
      );
      void qc.invalidateQueries({ queryKey });
      lock.current = false;
      setBusy(null);
    }
  }

  async function disconnect() {
    if (lock.current || !revision) return;
    lock.current = true;
    const ctl = new AbortController();
    actionCtl.current = ctl;
    const live = () => alive.current && !ctl.signal.aborted;
    setBusy("disconnect");
    setActionError(null);
    clearAvailability();
    try {
      const next = await disconnectMyGoogleCalendar(
        { revision, confirmDisconnect: true },
        { signal: ctl.signal },
      );
      if (!live()) return;
      qc.setQueryData(queryKey, next);
      setConfirmDisconnect(false);
      setConsent(false);
      setAllowInvites(false);
    } catch {
      if (!live()) return;
      setActionError(
        "Disconnect could not be confirmed. The status below is re-read from the server; try again.",
      );
    } finally {
      if (live()) {
        void qc.invalidateQueries({ queryKey });
        lock.current = false;
        setBusy(null);
      }
    }
  }

  const startMs = start ? new Date(start).getTime() : NaN;
  const mins = Number(duration);
  const now = Date.now();
  const inputError = !start
    ? null
    : Number.isNaN(startMs)
      ? "Enter a valid start time."
      : startMs < now
        ? "Choose a time in the future."
        : startMs > now + 90 * DAY
          ? "Choose a time within the next 90 days."
          : !Number.isInteger(mins) || mins < 15 || mins > 480
            ? "Duration must be 15 to 480 minutes."
            : null;
  const canCheck =
    !!status?.canCheckAvailability &&
    status.state === "connected" &&
    !!revision &&
    !!start &&
    !inputError &&
    !checking;

  async function check() {
    if (!canCheck || !revision || checkCtl.current) return;
    const ctl = new AbortController();
    checkCtl.current = ctl;
    const forRevision = revision;
    setChecking(true);
    setResult(null);
    setCheckError(null);
    try {
      const r = await checkMyGoogleCalendarAvailability(
        { revision: forRevision, startAt: new Date(startMs).toISOString(), durationMinutes: mins },
        { signal: ctl.signal },
      );
      if (ctl.signal.aborted) return;
      const wantStart = startMs,
        wantEnd = startMs + mins * 60_000;
      if (
        r.revision !== forRevision ||
        !Object.prototype.hasOwnProperty.call(RESULT_LABEL, r.status) ||
        new Date(r.startAt).getTime() !== wantStart ||
        new Date(r.endAt).getTime() !== wantEnd ||
        r.reserved !== false ||
        r.invitationsEnabled !== false
      )
        throw new Error("mismatch");
      setResult(r);
    } catch {
      if (!ctl.signal.aborted) {
        setCheckError("The availability check failed, so no result is shown. Try again.");
        void qc.invalidateQueries({ queryKey });
      }
    } finally {
      if (checkCtl.current === ctl) {
        checkCtl.current = null;
        setChecking(false);
      }
    }
  }

  const state = status?.state;
  return (
    <Card data-testid="google-staff-calendar">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarCheck className="h-5 w-5" /> Your Google Calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Badge variant="secondary">Personal · private</Badge>
        {callbackFailed && (
          <p role="alert" className="text-sm text-destructive">
            Google authorization did not complete. Nothing is assumed; your connection status below
            comes from Lexy.
          </p>
        )}
        {statusQ.isLoading && (
          <div
            className="h-16 rounded-lg bg-muted animate-pulse"
            aria-label="Loading Google Calendar status"
          />
        )}
        {statusQ.isError && !status && (
          <div role="alert" className="text-sm text-destructive space-y-2">
            <p>Your Google Calendar status could not be loaded.</p>
            <Button size="sm" variant="outline" onClick={() => void statusQ.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {status && (
          <>
            {state === "setup_required" || !status.configured ? (
              <p className="text-sm text-muted-foreground">
                Google Calendar is not set up for this workspace yet. An administrator needs to
                finish setup before you can connect. Nothing is shared in the meantime.
              </p>
            ) : state === "connected" ? (
              <p className="text-sm">
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
              </p>
            ) : state === "reconnect_required" ? (
              <p role="status" className="text-sm text-destructive">
                Google access needs to be re-authorized
                {status.accountEmail ? ` for ${status.accountEmail}` : ""}. Reconnect below.
              </p>
            ) : state === "authorization_pending" ? (
              <p role="status" className="text-sm text-muted-foreground">
                Authorization is pending. Returning from Google does not confirm a connection; only
                the status shown here does. You can cancel it below.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not connected.</p>
            )}

            {state === "connected" && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="google-staff-invite-permission"
              >
                Invitation permission:{" "}
                {status.canSendInvitations === true
                  ? "granted (each send still needs your review)"
                  : "not granted"}
              </p>
            )}
            {status.configured && state !== "setup_required" && state !== "connected" && (
              <div className="space-y-3 rounded-lg border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={consent}
                    onChange={(e) => {
                      setConsent(e.target.checked);
                      if (!e.target.checked) setAllowInvites(false);
                    }}
                    disabled={!!busy}
                  />
                  <span>
                    I am connecting my own Google Calendar. Access is read-only by default;
                    invitation permission requires the separate opt-in below. Starting or replacing
                    a connection clears the old local grant. Neither option grants panel access.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={allowInvites}
                    onChange={(e) => setAllowInvites(e.target.checked)}
                    disabled={!consent || !!busy}
                    data-testid="google-staff-allow-invitations"
                  />
                  <span>
                    Optional: also allow Lexy to create Google events with Meet for candidate-only
                    invitations. This is a separate write permission. Nothing is sent without a
                    per-invitation review by you. Leave unchecked to stay read-only.
                  </span>
                </label>
                <Button
                  onClick={() => void connect()}
                  disabled={!consent || !!busy}
                  data-testid="google-staff-connect"
                >
                  {busy === "connect" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {state === "reconnect_required"
                    ? "Reconnect Google Calendar"
                    : "Connect Google Calendar"}
                </Button>
              </div>
            )}

            {(state === "connected" ||
              state === "reconnect_required" ||
              state === "authorization_pending") && (
              <div className="space-y-2">
                {!confirmDisconnect ? (
                  <Button
                    variant="outline"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={!!busy || !revision}
                    data-testid="google-staff-disconnect"
                  >
                    {state === "authorization_pending"
                      ? "Cancel pending connection"
                      : "Disconnect Google Calendar"}
                  </Button>
                ) : (
                  <div className="rounded-lg border p-3 space-y-2 text-sm">
                    <p>
                      {state === "authorization_pending"
                        ? "Cancel this pending authorization?"
                        : "Disconnect your Google Calendar? Availability checks will stop until you reconnect."}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void disconnect()}
                        disabled={!!busy}
                        data-testid="google-staff-disconnect"
                      >
                        {busy === "disconnect" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Confirm
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDisconnect(false)}
                        disabled={!!busy}
                      >
                        Keep
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {state === "connected" && (
              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium">Check one personal interval</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="gsc-start">Start</Label>
                    <Input
                      id="gsc-start"
                      type="datetime-local"
                      value={start}
                      onChange={(e) => {
                        setStart(e.target.value);
                        clearAvailability();
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="gsc-dur">Duration (minutes)</Label>
                    <Input
                      id="gsc-dur"
                      type="number"
                      min={15}
                      max={480}
                      step={1}
                      value={duration}
                      onChange={(e) => {
                        setDuration(e.target.value);
                        clearAvailability();
                      }}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Up to 90 days ahead, 15 to 480 minutes.
                </p>
                {inputError && (
                  <p role="alert" className="text-sm text-destructive">
                    {inputError}
                  </p>
                )}
                <Button
                  onClick={() => void check()}
                  disabled={!canCheck}
                  data-testid="google-staff-check-availability"
                  className="w-full sm:w-auto"
                >
                  {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {checking ? "Checking…" : "Check availability"}
                </Button>
                {checkError && (
                  <p role="alert" className="text-sm text-destructive">
                    {checkError}
                  </p>
                )}
                {result && (
                  <div role="status" className="rounded-lg border p-3 text-sm space-y-1">
                    <p className="font-medium">{RESULT_LABEL[result.status]}</p>
                    <p className="text-muted-foreground">
                      {new Date(result.startAt).toLocaleString()} –{" "}
                      {new Date(result.endAt).toLocaleTimeString()}. Not reserved. Not an
                      invitation. Event details are never shown.
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
        {statusQ.isError && status && (
          <p role="alert" className="text-sm text-destructive">
            Status refresh failed; showing the last known state.{" "}
            <button className="underline" onClick={() => void statusQ.refetch()}>
              Retry
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
