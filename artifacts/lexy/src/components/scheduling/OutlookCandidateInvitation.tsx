import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Mail } from "lucide-react";
import { OutlookInvitationChange } from "./OutlookInvitationChange";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import {
  canSendInvitation,
  readInvitationStatus,
  sameInvitationDetails,
  type OutlookCandidateInvitationStatus,
  type InvitationSchedule as Schedule,
} from "./outlook-invitation-state";

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const res = await apiFetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      [400, 403, 404, 409].includes(res.status) && body && typeof body.error === "string"
        ? body.error
        : "The server did not confirm this request.",
    );
  return body;
}

export function OutlookCandidateInvitation({ schedule }: { schedule: Schedule }) {
  const key = `${schedule.id}|${schedule.version ?? ""}`;
  const keyRef = useRef(key);
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<OutlookCandidateInvitationStatus | null>(null);
  const [status, setStatus] = useState<OutlookCandidateInvitationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const seq = useRef(0);
  const path = `/outlook-calendar/schedules/${encodeURIComponent(schedule.id)}/invitation`;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const k = keyRef.current;
    setLoading(true);
    setError(null);
    try {
      const s = readInvitationStatus(await call(path), schedule.id);
      if (mine !== seq.current || k !== keyRef.current) return;
      setStatus(s);
      if (s.status !== "not_sent") setUncertain(false);
    } catch (e) {
      if (mine !== seq.current) return;
      setStatus(null);
      setError(e instanceof Error ? e.message : "Status could not be read.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path, schedule.id]);
  const loadRef = useRef(load);
  loadRef.current = load;

  // Reset everything when schedule identity or version changes.
  useEffect(() => {
    keyRef.current = key;
    seq.current++;
    setOpen(false);
    setReviewed(null);
    setStatus(null);
    setError(null);
    setUncertain(false);
    setAttempted(false);
    setSending(false);
    setLoading(false);
    lock.current = false;
  }, [key]);

  // Refresh status on open and on window focus while open (reads only).
  useEffect(() => {
    if (!open) return;
    void loadRef.current();
    const onFocus = () => {
      if (!lock.current) void loadRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open]);

  const eligible =
    canSendInvitation(schedule, status) &&
    !attempted &&
    !uncertain &&
    !loading &&
    !error &&
    !sending;

  useEffect(() => {
    // A refresh, lost authority, changed recipient or changed schedule requires
    // another deliberate review. Never reopen it automatically after a retry.
    if (reviewed && !sending && (!eligible || !sameInvitationDetails(reviewed, status)))
      setReviewed(null);
  }, [reviewed, sending, eligible, status]);

  async function send() {
    if (
      lock.current ||
      !eligible ||
      !reviewed ||
      !sameInvitationDetails(reviewed, status) ||
      !canSendInvitation(schedule, status)
    )
      return;
    lock.current = true;
    setAttempted(true);
    setSending(true);
    const k = keyRef.current;
    try {
      const result = readInvitationStatus(
        await call(path, {
          method: "POST",
          body: JSON.stringify({
            confirm: true,
            expectedVersion: reviewed.version,
            expectedRecipientEmail: reviewed.recipientEmail,
          }),
        }),
        schedule.id,
      );
      if (k !== keyRef.current) return;
      if (!sameInvitationDetails(reviewed, result)) throw new Error("mismatch");
      setStatus(result);
      if (result.status !== "accepted") setUncertain(true);
    } catch {
      if (k === keyRef.current) {
        setUncertain(true);
        setError("Lexy could not confirm whether Outlook accepted the request. Do not resend yet.");
      }
    } finally {
      if (k === keyRef.current) {
        setSending(false);
        setReviewed(null);
      }
      lock.current = false;
    }
  }

  if (schedule.status !== "confirmed") return null;

  return (
    <>
      <OutlookInvitationChange schedule={schedule} />
      <Button
        size="sm"
        variant="outline"
        data-testid={`button-candidate-invitation-${schedule.id}`}
        onClick={() => setOpen(true)}
      >
        <Mail className="w-4 h-4 mr-1" /> Invite candidate
      </Button>
      <Dialog
        open={open}
        onOpenChange={(n) => {
          if (!sending) {
            setOpen(n);
            if (!n) setReviewed(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Outlook calendar invitation</DialogTitle>
            <DialogDescription>
              Asks Outlook to send a meeting request to the candidate only. Your private hold is
              separate, and no other panel calendars are invited.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {loading && <p role="status">Checking invitation status...</p>}
            {error && (
              <p role="alert" className="text-destructive" data-testid="text-invitation-error">
                {error}
              </p>
            )}
            {status && (
              <div
                className="rounded-lg border p-3 space-y-1"
                data-testid="text-invitation-details"
              >
                <p>
                  Recipient: <strong>{status.recipientEmail}</strong>
                </p>
                <p>Time: {formatInterviewInstant(status.scheduledAt)}</p>
                <p>Duration: {status.durationMinutes} minutes</p>
              </div>
            )}
            {status && !canSendInvitation(schedule, status) && status.status === "not_sent" && (
              <p role="alert">
                The invitation details do not match the current schedule, or the time has passed.
                Reload the schedule before continuing.
              </p>
            )}
            {status?.status === "accepted" && (
              <p role="status" data-testid="text-invitation-accepted">
                Outlook accepted the meeting request
                {status.acceptedAt ? ` at ${formatInterviewInstant(status.acceptedAt)}` : ""}. This
                does not confirm the candidate received it.
              </p>
            )}
            {(status?.status === "needs_review" || uncertain) && status?.status !== "accepted" && (
              <p role="alert">
                Needs review: the outcome is uncertain. Reload status and check Outlook before any
                further action. Lexy will not retry automatically.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Calendar access may need separate consent.{" "}
              <Link href="/recruiter/settings" className="underline text-primary">
                Manage connection
              </Link>
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={loading || sending}
              onClick={() => void load()}
              data-testid="button-reload-invitation"
            >
              Reload status
            </Button>
            <Button
              disabled={!eligible}
              onClick={() => {
                if (eligible && status) setReviewed({ ...status });
              }}
              data-testid="button-review-invitation"
            >
              Review and send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!reviewed}
        onOpenChange={(n) => {
          if (!sending && !n) setReviewed(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send meeting request to candidate?</DialogTitle>
            <DialogDescription>
              {reviewed
                ? `Outlook will be asked to invite ${reviewed.recipientEmail} for ${formatInterviewInstant(reviewed.scheduledAt)}, ${reviewed.durationMinutes} minutes.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={sending} onClick={() => setReviewed(null)}>
              Cancel
            </Button>
            <Button
              disabled={!eligible || !sameInvitationDetails(reviewed, status)}
              onClick={() => void send()}
              data-testid="button-confirm-send-invitation"
            >
              {sending ? "Waiting for Outlook..." : "Send invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
