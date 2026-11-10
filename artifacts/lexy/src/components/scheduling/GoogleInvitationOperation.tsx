import { useEffect, useRef, useState } from "react";
import {
  applyGoogleInvitationOperation,
  getGoogleInvitationOperation,
  type GoogleInvitationOperationView as Op,
} from "@workspace/api-client-react";
import { authHeaders } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CalendarSync, CalendarX2, ArrowDown } from "lucide-react";
import type { InvitationSchedule as Schedule } from "./outlook-invitation-state";
import {
  exactInstant,
  expectedKind,
  expired,
  readOperation,
  sameDetails,
  sameReview,
} from "./google-invitation-operation-state";

function Instant({
  iso,
  testid,
  strike,
}: {
  iso: string | null;
  testid: string;
  strike?: boolean;
}) {
  if (!iso) return <span className="text-muted-foreground">none</span>;
  const x = exactInstant(iso);
  return (
    <span data-testid={testid} className={strike ? "line-through decoration-destructive/60" : ""}>
      <strong className="block font-semibold tabular-nums">{x.local}</strong>
      <span className="block font-mono text-[11px] text-muted-foreground break-all">{x.raw}</span>
    </span>
  );
}

function Range({
  start,
  end,
  id,
  strike,
}: {
  start: string | null;
  end: string | null;
  id: string;
  strike?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Starts</p>
      <Instant iso={start} testid={`${id}-start`} strike={strike} />
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground pt-1">Ends</p>
      <Instant iso={end} testid={`${id}-end`} strike={strike} />
    </div>
  );
}

const REASON: Record<string, string> = {
  unavailable:
    "A Google update is not available for this schedule. It may have no Google invitation from Lexy, or the connection needs attention.",
  current: "Google already matches this Lexy schedule. There is nothing to send.",
  needs_review:
    "Needs review: Google could not confirm which operation applies. If the event is missing in Google, that does not prove which operation removed it. Check Google Calendar.",
};

export function GoogleInvitationOperation({ schedule }: { schedule: Schedule }) {
  const { user } = useAuth() as {
    user?: { id?: string | number; tenantId?: string | null } | null;
  };
  const key = [
    user?.id ?? "anon",
    user?.tenantId ?? "",
    schedule.id,
    schedule.version ?? "",
    schedule.scheduledAt,
    schedule.durationMinutes,
    schedule.status,
  ].join("|");
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const epoch = useRef(0);
  const alive = useRef(true);
  const lock = useRef(false);
  const attemptedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Op | null>(null);
  const [reviewed, setReviewed] = useState<Op | null>(null);
  const [ack, setAck] = useState(false);
  const [approved, setApproved] = useState(false);
  const [phase, setPhase] = useState<"idle" | "reading" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const req = () => ({ headers: authHeaders() });

  function clearApproval() {
    setAck(false);
    setApproved(false);
    setReviewed(null);
  }
  const clearRef = useRef(clearApproval);
  clearRef.current = clearApproval;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Identity, tenant, schedule or native edit: drop everything and orphan in-flight replies.
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    attemptedRef.current = false;
    setOpen(false);
    setView(null);
    setReviewed(null);
    setAck(false);
    setApproved(false);
    setPhase("idle");
    setError(null);
    setAttempted(false);
  }, [key]);

  useEffect(() => {
    const onFocus = () => {
      if (!lock.current) clearRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!reviewed?.reviewExpiresAt) return;
    const wait = Math.max(0, Date.parse(reviewed.reviewExpiresAt) - Date.now());
    const t = window.setTimeout(() => {
      if (!attemptedRef.current && !lock.current) {
        clearRef.current();
        setError("The review expired. Review the change again.");
      }
    }, wait);
    return () => window.clearTimeout(t);
  }, [reviewed]);

  async function read() {
    if (lock.current) return;
    lock.current = true;
    const ep = epoch.current;
    const live = () => alive.current && ep === epoch.current;
    clearApproval();
    setError(null);
    setPhase("reading");
    try {
      const s = readOperation(
        await getGoogleInvitationOperation(scheduleRef.current.id, req()),
        scheduleRef.current,
      );
      if (!live()) return;
      setView(s);
      if (!attemptedRef.current && s.status === "ready" && !expired(s))
        setReviewed(Object.freeze({ ...s }));
    } catch {
      if (!live()) return;
      setView(null);
      setError("Lexy could not read a valid Google update review. Nothing was sent. Try again.");
    } finally {
      if (live()) {
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  async function apply() {
    const snap = reviewed;
    if (lock.current || !snap || !ack || !approved || attemptedRef.current) return;
    lock.current = true;
    const ep = epoch.current;
    const live = () => alive.current && ep === epoch.current;
    const abort = (msg: string) => {
      if (!live()) return;
      clearApproval();
      setError(msg);
      lock.current = false;
      setPhase("idle");
    };
    setPhase("verifying");
    setError(null);
    let fresh: Op;
    try {
      fresh = readOperation(
        await getGoogleInvitationOperation(scheduleRef.current.id, req()),
        scheduleRef.current,
      );
    } catch {
      return abort("Lexy could not re-check Google just before sending. Nothing was sent.");
    }
    if (!live()) return;
    if (!sameReview(snap, fresh) || expired(snap) || expired(fresh)) {
      setView(fresh);
      return abort(
        "The change or its review expired since you reviewed it. Nothing was sent. Review again.",
      );
    }
    // Past here the outcome may be unknowable: no second write, ever.
    attemptedRef.current = true;
    setAttempted(true);
    setPhase("sending");
    try {
      const raw = await applyGoogleInvitationOperation(
        snap.scheduleId,
        {
          confirm: true,
          kind: snap.kind,
          expectedVersion: snap.version,
          expectedApprovalToken: snap.approvalToken as string,
          reviewExpiresAt: snap.reviewExpiresAt as string,
        },
        req(),
      );
      if (!live()) return;
      const r = readOperation(raw, scheduleRef.current);
      if (r.status !== "accepted" || !sameDetails(snap, r)) throw new Error("mismatch");
      setView(r);
    } catch {
      if (live())
        setError(
          "Lexy could not confirm whether Google accepted the change. Do not retry. This record is now read-only; check Google Calendar.",
        );
    } finally {
      if (live()) {
        clearApproval();
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  if ((schedule as { type?: string }).type === "ai_interview") return null;
  const cancelling = expectedKind(schedule) === "cancel";
  const busy = phase !== "idle";
  const shown = reviewed ?? view;
  const detailed = shown && (shown.status === "ready" || shown.status === "accepted");
  const Icon = cancelling ? CalendarX2 : CalendarSync;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid={`button-google-operation-${schedule.id}`}
        onClick={() => setOpen(true)}
      >
        <Icon className="w-4 h-4 mr-1" /> {cancelling ? "Cancel in Google" : "Update Google"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(n) => {
          if (phase === "sending" || phase === "verifying") return;
          setOpen(n);
          if (!n) clearApproval();
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {cancelling ? "Cancel the Google event" : "Reschedule the Google event"}
            </DialogTitle>
            <DialogDescription>
              Editing or cancelling in Lexy alone does not update Google. Save the change in Lexy
              first, then review it here and ask Google to match. Nothing is sent until you review
              and approve.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm" data-testid="google-operation-body">
            {busy && (
              <p role="status" className="animate-pulse">
                {phase === "reading"
                  ? "Reading the change from Lexy..."
                  : phase === "verifying"
                    ? "Re-checking before sending..."
                    : "Waiting for Google..."}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="text-destructive"
                data-testid="text-google-operation-error"
              >
                {error}
              </p>
            )}
            {!shown && !busy && !error && (
              <p className="text-muted-foreground">
                Editing Lexy alone does not update Google. Press Review to read the current change.
                Reviewing sends nothing to Google.
              </p>
            )}
            {view && !detailed && (
              <p role="alert" data-testid="text-google-operation-unavailable">
                {REASON[view.status] ?? REASON.unavailable}
              </p>
            )}
            {view?.status === "ready" && !reviewed && attempted && (
              <p role="alert" data-testid="text-google-operation-readonly">
                Read-only after a send attempt. Nothing will be sent again from here.
              </p>
            )}
            {view?.status === "ready" && !reviewed && !attempted && expired(view) && (
              <p role="alert">The review window has passed. Review again.</p>
            )}
            {detailed && shown && (
              <div
                className="rounded-lg border p-3 space-y-3"
                data-testid="text-google-operation-details"
              >
                <p>
                  Operation:{" "}
                  <strong data-testid="text-google-operation-kind">
                    {shown.kind === "cancel" ? "Cancel event" : "Reschedule event"}
                  </strong>
                </p>
                <p>
                  Candidate: <strong>{shown.recipientEmail}</strong>
                </p>
                {!!shown.panelRecipientEmails?.length && (
                  <div>
                    <p className="font-semibold">Panel recipients</p>
                    <ul className="list-disc pl-5 break-all" data-testid="google-operation-panel">
                      {shown.panelRecipientEmails.map((email) => (
                        <li key={email}>{email}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p>
                  Organizer: <strong>{shown.organizerEmail ?? "not connected"}</strong>
                </p>
                <div className="grid gap-2">
                  <div className="rounded-md bg-muted/50 p-2">
                    <p className="text-xs font-semibold mb-1">Now in Google</p>
                    <Range
                      id="op-previous"
                      start={shown.previousStart}
                      end={shown.previousEnd}
                      strike
                    />
                  </div>
                  <ArrowDown className="w-4 h-4 mx-auto text-muted-foreground" aria-hidden />
                  <div className="rounded-md border border-primary/40 p-2">
                    <p className="text-xs font-semibold mb-1">
                      {shown.kind === "cancel" ? "After this operation" : "New time"}
                    </p>
                    {shown.kind === "cancel" ? (
                      <p data-testid="op-target-cancelled">
                        The event will be cancelled in Google.
                      </p>
                    ) : (
                      <Range id="op-target" start={shown.targetStart} end={shown.targetEnd} />
                    )}
                  </div>
                </div>
              </div>
            )}
            {view?.status === "accepted" && (
              <div role="status" className="space-y-1" data-testid="text-google-operation-accepted">
                <p>
                  Google accepted the {view.kind === "cancel" ? "cancellation" : "reschedule"}{" "}
                  request
                  {view.acceptedAt ? ` at ${exactInstant(view.acceptedAt).local}` : ""}. This is a
                  record of Google's acceptance only; it is not proof that the guest was notified or
                  has responded.
                </p>
                {view.kind === "cancel" && (
                  <p>
                    This does not cancel the interview in Lexy, and the original Google event cannot
                    be resent or recreated from here.
                  </p>
                )}
              </div>
            )}
            {reviewed && !attempted && (
              <>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-google-operation-notice"
                >
                  Google may email the candidate and all listed panel recipients about this change.
                  Lexy cannot confirm delivery. This changes the existing event, not its guest list.
                  {reviewed.kind === "reschedule"
                    ? " All current panel calendars and saved working hours are rechecked before the update. A busy or unverifiable calendar stops the update; availability is not reserved until Google accepts it."
                    : " Cancellation does not require panel availability."}
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ack}
                    disabled={busy}
                    onChange={(e) => {
                      setAck(e.target.checked);
                      if (!e.target.checked) setApproved(false);
                    }}
                    data-testid="checkbox-google-operation-ack"
                  />
                  <span>
                    I understand the Lexy edit is already saved, and this separately asks Google to
                    change the existing event.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={approved}
                    disabled={busy || !ack}
                    onChange={(e) => setApproved(e.target.checked)}
                    data-testid="checkbox-google-operation-approve"
                  />
                  <span>
                    Final approval: I checked every recipient, organizer, previous and new instants
                    above and approve this one{" "}
                    {reviewed.kind === "cancel" ? "cancellation" : "reschedule"}.
                  </span>
                </label>
              </>
            )}
          </div>
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read()}
              data-testid="button-google-operation-review"
            >
              {attempted ? "Refresh status" : "Review"}
            </Button>
            {!attempted && (
              <Button
                variant={cancelling ? "destructive" : "default"}
                disabled={!reviewed || !ack || !approved || busy}
                onClick={() => void apply()}
                data-testid="button-google-operation-send"
              >
                {cancelling ? "Cancel Google event" : "Update Google event"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
