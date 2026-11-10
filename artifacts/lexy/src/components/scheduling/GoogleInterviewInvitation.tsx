import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  getGoogleInterviewInvitation,
  sendGoogleInterviewInvitation,
  type GoogleInterviewInvitationStatus as Status,
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
import { Video } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import type { InvitationSchedule as Schedule } from "./outlook-invitation-state";
import {
  identityMatches,
  isExpired,
  readGoogleInvitation,
  sameGoogleReview,
} from "./google-interview-invitation-state";

const REASONS: Record<string, string> = {
  setup_required: "Google Calendar is not set up for this workspace.",
  connection_required: "Connect your Google Calendar before inviting.",
  write_consent_required:
    "Your Google connection is read-only. Reconnect with invitation permission to send.",
  ineligible: "This schedule is not eligible for a Google invitation.",
  panel_unsupported:
    "The saved panel is not a current, authorized Google panel. Review its members and Google connections before inviting.",
  another_provider: "This interview already uses another calendar provider.",
  changed: "The schedule or connection changed since it was last reviewed.",
  unknown: "Google could not confirm the state of this invitation.",
};

function MeetLine({ s }: { s: Status }) {
  if (s.conferenceStatus === "ready" && s.meetUrl)
    return (
      <p data-testid="text-google-invite-meet">
        Meet link:{" "}
        <a
          href={s.meetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary break-all"
        >
          {s.meetUrl}
        </a>
      </p>
    );
  const t =
    s.conferenceStatus === "pending"
      ? "Google is still creating the Meet link. Refresh to check; do not resend."
      : s.conferenceStatus === "failed"
        ? "Google did not create a Meet link. The invitation may exist without one; check Google Calendar. Do not resend."
        : "No Meet link has been confirmed.";
  return <p data-testid="text-google-invite-meet">{t}</p>;
}

export function GoogleInterviewInvitation({ schedule }: { schedule: Schedule }) {
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
  const [view, setView] = useState<Status | null>(null);
  const [reviewed, setReviewed] = useState<Status | null>(null);
  const [approved, setApproved] = useState(false);
  const [phase, setPhase] = useState<"idle" | "reading" | "verifying" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const req = () => ({ headers: authHeaders() });

  function clearApproval() {
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

  // Identity, tenant, schedule or prop change: drop everything, invalidate in-flight work.
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    attemptedRef.current = false;
    setOpen(false);
    setView(null);
    setReviewed(null);
    setApproved(false);
    setPhase("idle");
    setError(null);
    setAttempted(false);
  }, [key]);

  // Returning focus may mean the user changed something elsewhere: approval is dropped.
  useEffect(() => {
    const onFocus = () => {
      if (!lock.current) clearRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Approval expires on the server-provided clock.
  useEffect(() => {
    if (!reviewed?.reviewExpiresAt) return;
    const ms = Math.max(0, Date.parse(reviewed.reviewExpiresAt) - Date.now());
    const t = window.setTimeout(() => {
      if (!attemptedRef.current && phase !== "sending") {
        clearRef.current();
        setError("The review expired. Review the invitation again.");
      }
    }, ms);
    return () => window.clearTimeout(t);
  }, [reviewed, phase]);

  async function read() {
    if (lock.current) return;
    lock.current = true;
    const ep = epoch.current;
    const live = () => alive.current && ep === epoch.current;
    clearApproval();
    setError(null);
    setPhase("reading");
    try {
      const s = readGoogleInvitation(
        await getGoogleInterviewInvitation(scheduleRef.current.id, req()),
        scheduleRef.current,
      );
      if (!live()) return;
      setView(s);
      if (!attemptedRef.current && s.status === "ready" && !isExpired(s))
        setReviewed(Object.freeze({ ...s }));
    } catch {
      if (!live()) return;
      setView(null);
      setError("Lexy could not read a valid invitation status. Nothing was sent. Try again.");
    } finally {
      if (live()) {
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  async function send() {
    const snap = reviewed;
    if (lock.current || !snap || !approved || attemptedRef.current) return;
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
    let fresh: Status;
    try {
      fresh = readGoogleInvitation(
        await getGoogleInterviewInvitation(scheduleRef.current.id, req()),
        scheduleRef.current,
      );
    } catch {
      return abort("Lexy could not re-check the invitation just before sending. Nothing was sent.");
    }
    if (!live()) return;
    if (!sameGoogleReview(snap, fresh) || isExpired(snap) || isExpired(fresh)) {
      setView(fresh);
      return abort(
        "The invitation changed or expired since you reviewed it. Nothing was sent. Review again.",
      );
    }
    // Past this point the outcome may be unknowable: no further send, ever.
    attemptedRef.current = true;
    setAttempted(true);
    setPhase("sending");
    try {
      const raw = await sendGoogleInterviewInvitation(
        snap.scheduleId,
        {
          confirm: true,
          expectedVersion: snap.version,
          expectedApprovalToken: snap.approvalToken as string,
          reviewExpiresAt: snap.reviewExpiresAt as string,
        },
        req(),
      );
      if (!live()) return;
      const r = readGoogleInvitation(raw, scheduleRef.current);
      if (r.status !== "accepted" || !identityMatches(snap, r)) throw new Error("mismatch");
      setView(r);
    } catch {
      if (live())
        setError(
          "Lexy could not confirm whether Google accepted the invitation. Do not resend. Use Refresh status and check Google Calendar.",
        );
    } finally {
      if (live()) {
        clearApproval();
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  if (schedule.status !== "confirmed") return null;
  const busy = phase !== "idle";
  const shown = reviewed ?? view;
  const detailed = shown && (shown.status === "ready" || shown.status === "accepted");

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid={`button-google-invitation-${schedule.id}`}
        onClick={() => setOpen(true)}
      >
        <Video className="w-4 h-4 mr-1" /> Google invite
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
            <DialogTitle>Google Calendar invitation + Meet</DialogTitle>
            <DialogDescription>
              Asks Google Calendar to create one event with a Meet link for the candidate and any
              saved Google panel members shown below. Nothing is sent until you review and confirm.
            </DialogDescription>
            <p className="text-xs text-muted-foreground">
              {shown?.panelRecipientEmails
                ? "After saving a time change or cancellation in Lexy, use Update Google or Cancel in Google to review every recipient and approve the change to the existing event. Panel membership changes need separate review; do not send a replacement invitation. Changed or uncertain receipts cannot authorize recording import."
                : "Later edits or cancellations in Lexy do not automatically update Google. After saving the change in Lexy, use Update Google (or Cancel in Google) on the schedule to review it; do not send a replacement invitation."}
            </p>
          </DialogHeader>
          <div className="space-y-3 text-sm" data-testid="google-invite-body">
            {busy && (
              <p role="status" className="animate-pulse">
                {phase === "reading"
                  ? "Reading invitation status..."
                  : phase === "verifying"
                    ? "Re-checking before sending..."
                    : "Waiting for Google..."}
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive" data-testid="text-google-invite-error">
                {error}
              </p>
            )}
            {!shown && !busy && !error && (
              <p className="text-muted-foreground">
                Press Review to read the current details from Lexy. Reviewing sends nothing.
              </p>
            )}
            {view && view.status !== "ready" && view.status !== "accepted" && (
              <p role="alert" data-testid="text-google-invite-unavailable">
                {view.status === "blocked_other_provider"
                  ? REASONS.another_provider
                  : (view.reason && REASONS[view.reason]) ||
                    (view.status === "needs_review"
                      ? "Needs review: details changed or the outcome is uncertain. Refresh and check Google Calendar."
                      : "A Google invitation is not available for this schedule.")}
              </p>
            )}
            {view?.status === "ready" && !reviewed && attempted && (
              <p role="alert">
                Status is read-only after a send attempt. This will not be resent from here.
              </p>
            )}
            {view?.status === "ready" && !reviewed && !attempted && isExpired(view) && (
              <p role="alert">The review window has passed. Review again.</p>
            )}
            {detailed && shown && (
              <div
                className="rounded-lg border p-3 space-y-1 transition-opacity"
                data-testid="text-google-invite-details"
              >
                <p>
                  Candidate: <strong>{shown.recipientEmail}</strong>
                </p>
                {!!shown.panelRecipientEmails?.length && (
                  <div data-testid="text-google-invite-panel-recipients">
                    <p>Panel members invited by Google:</p>
                    <ul className="list-disc pl-5 break-all">
                      {shown.panelRecipientEmails.map((email) => (
                        <li key={email}>{email}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p>
                  Organizer (your Google calendar):{" "}
                  <strong>{shown.organizerEmail ?? "not connected"}</strong>
                </p>
                <p>
                  Role: <strong>{shown.jobTitle || "Interview"}</strong>
                </p>
                <p>
                  {formatInterviewInstant(shown.scheduledAt)}, {shown.durationMinutes} minutes
                </p>
              </div>
            )}
            {view?.status === "accepted" && (
              <div role="status" className="space-y-1" data-testid="text-google-invite-accepted">
                <p>
                  Google accepted the event request
                  {view.acceptedAt ? ` at ${formatInterviewInstant(view.acceptedAt)}` : ""}. This is
                  not proof of email delivery or that the candidate has responded.
                </p>
                <MeetLine s={view} />
              </div>
            )}
            {reviewed && !attempted && (
              <>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-google-invite-notice"
                >
                  Google may email the candidate and every panel recipient listed above and add this
                  event to their calendars. Guest-list visibility is disabled for attendees.
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={approved}
                    disabled={busy}
                    onChange={(e) => setApproved(e.target.checked)}
                    data-testid="checkbox-google-invite-approve"
                  />
                  <span>
                    I reviewed all recipients, the organizer, role and time above and approve this
                    one invitation with a Google Meet request.
                  </span>
                </label>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              <Link href="/recruiter/settings" className="underline text-primary">
                Manage Google connection
              </Link>
            </p>
          </div>
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read()}
              data-testid="button-google-invite-review"
            >
              {attempted ? "Refresh status" : "Review"}
            </Button>
            {!attempted && (
              <Button
                disabled={!reviewed || !approved || busy}
                onClick={() => void send()}
                data-testid="button-google-invite-send"
              >
                Send invitation + request Meet
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
