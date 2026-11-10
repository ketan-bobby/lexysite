import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  getOutlookPanelInvitation,
  sendOutlookPanelInvitation,
  type OutlookPanelInvitationStatus,
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
import { Users } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import type { InvitationSchedule as Schedule } from "./outlook-invitation-state";
import {
  PANEL_READ_FRESH_MS,
  canReviewPanelInvitation,
  isPanelReadFresh,
  readPanelStatus,
  receiptMatchesReview,
  samePanelReview,
} from "./outlook-panel-invitation-state";

function message(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const data = (e as { data?: { error?: unknown } })?.data;
  if (status && [400, 403, 404, 409].includes(status) && typeof data?.error === "string")
    return data.error;
  return "The server did not confirm this request.";
}

export function OutlookPanelInvitation({ schedule }: { schedule: Schedule }) {
  const { user } = useAuth() as { user?: { id?: string | number } | null };
  const key = `${user?.id ?? "anon"}|${schedule.id}|${schedule.version ?? ""}`;
  const keyRef = useRef(key);
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<OutlookPanelInvitationStatus | null>(null);
  const [status, setStatus] = useState<OutlookPanelInvitationStatus | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const seq = useRef(0);
  const request = () => ({ headers: authHeaders() });

  const load = useCallback(async () => {
    if (lock.current) return;
    const mine = ++seq.current;
    const k = keyRef.current;
    setLoading(true);
    setError(null);
    try {
      const s = readPanelStatus(
        await getOutlookPanelInvitation(schedule.id, request()),
        schedule.id,
      );
      if (mine !== seq.current || k !== keyRef.current || lock.current) return;
      setStatus(s);
      setLoadedAt(Date.now());
      setNow(Date.now());
    } catch (e) {
      if (mine !== seq.current || k !== keyRef.current) return;
      setStatus(null);
      setLoadedAt(null);
      setError(e instanceof Error && e.message.startsWith("Panel") ? e.message : message(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [schedule.id]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    keyRef.current = key;
    seq.current++;
    setOpen(false);
    setReviewed(null);
    setStatus(null);
    setLoadedAt(null);
    setError(null);
    setUncertain(false);
    setAttempted(false);
    setSending(false);
    setLoading(false);
    lock.current = false;
  }, [key]);

  // One read on open; a clock only marks reads stale. Nothing here sends.
  useEffect(() => {
    if (!open) return;
    void loadRef.current();
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, [open]);

  const fresh = isPanelReadFresh(loadedAt, now);
  const eligible =
    canReviewPanelInvitation(schedule, status, now) &&
    fresh &&
    !attempted &&
    !uncertain &&
    !loading &&
    !error &&
    !sending;

  useEffect(() => {
    if (reviewed && !sending && (!eligible || !samePanelReview(reviewed, status)))
      setReviewed(null);
  }, [reviewed, sending, eligible, status]);

  async function send() {
    if (lock.current || !eligible || !reviewed || !samePanelReview(reviewed, status)) return;
    lock.current = true;
    seq.current++; // late reads must not overwrite this mutation
    setAttempted(true);
    setSending(true);
    const k = keyRef.current;
    const snapshot = reviewed;
    try {
      const raw = await sendOutlookPanelInvitation(
        schedule.id,
        {
          confirm: true,
          expectedVersion: snapshot.version,
          expectedApprovalToken: snapshot.approvalToken as string,
        },
        request(),
      );
      if (k !== keyRef.current) return;
      const result = readPanelStatus(raw, schedule.id);
      if (!receiptMatchesReview(snapshot, result)) throw new Error("mismatch");
      setStatus(result);
      setLoadedAt(Date.now());
      if (result.status !== "accepted") {
        setUncertain(true);
        setError(
          "Outlook has not confirmed acceptance. Do not resend; reload status and check Outlook.",
        );
      }
    } catch (e) {
      if (k === keyRef.current) {
        setUncertain(true);
        const st = (e as { status?: number })?.status;
        setError(
          st === 409
            ? `The server refused the send: ${message(e)} Nothing was confirmed as sent. Reload status; a new review is required and this is not permission to resend.`
            : "Lexy could not confirm whether Outlook accepted the request. Do not resend; reload status only.",
        );
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
  const panel = status?.panelRecipients ?? [];

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid={`button-panel-invitation-${schedule.id}`}
        onClick={() => setOpen(true)}
      >
        <Users className="w-4 h-4 mr-1" /> Invite panel
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
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Outlook panel invitation</DialogTitle>
            <DialogDescription>
              Asks Outlook to send one meeting request from your connected calendar to the candidate
              and the saved panel. Nothing is sent until you review and confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {loading && <p role="status">Checking invitation status...</p>}
            {error && (
              <p
                role="alert"
                className="text-destructive"
                data-testid="text-panel-invitation-error"
              >
                {error}
              </p>
            )}
            {status && status.status === "unavailable" && (
              <p role="alert">
                Panel invitation is not available for this schedule. Check the saved panel and your
                Outlook connection.
              </p>
            )}
            {status && status.status !== "unavailable" && (
              <div
                className="rounded-lg border p-3 space-y-2"
                data-testid="text-panel-invitation-details"
              >
                <p>
                  Organizer (connected Outlook):{" "}
                  <strong>{status.organizerEmail ?? "not connected"}</strong>
                </p>
                <p>
                  Candidate: <strong>{status.recipientEmail}</strong>
                </p>
                <p>Time: {formatInterviewInstant(status.scheduledAt)}</p>
                <p>Duration: {status.durationMinutes} minutes</p>
                <div>
                  <p>Panel ({panel.length}):</p>
                  <ul className="list-disc pl-5">
                    {panel.map((p) => (
                      <li key={p.userId}>
                        {p.name} <span className="text-muted-foreground">{p.email}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {status &&
              status.status === "not_sent" &&
              !loading &&
              !error &&
              !canReviewPanelInvitation(schedule, status, now) && (
                <p role="alert">
                  The invitation details do not match the current schedule, are incomplete, or the
                  time has passed. Reload the schedule before continuing.
                </p>
              )}
            {status?.status === "not_sent" && loadedAt !== null && !fresh && (
              <p role="alert">
                This status is older than {Math.round(PANEL_READ_FRESH_MS / 1000)} seconds. Reload
                status to review again.
              </p>
            )}
            {status?.status === "accepted" && (
              <p role="status" data-testid="text-panel-invitation-accepted">
                Microsoft accepted the meeting request
                {status.acceptedAt ? ` at ${formatInterviewInstant(status.acceptedAt)}` : ""}. This
                is not proof of email delivery and not acceptance by the candidate or any panel
                member.
              </p>
            )}
            {(status?.status === "needs_review" || uncertain) && status?.status !== "accepted" && (
              <p role="alert">
                Needs review: the invitation details changed or the outcome is uncertain. Reload
                status and check Outlook before any further action. Lexy will not retry
                automatically.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Outlook hides the other guests from each invitee. If the organizer is also on the
              panel roster, they may not receive a separate guest invitation.{" "}
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
              data-testid="button-reload-panel-invitation"
            >
              Reload status
            </Button>
            <Button
              disabled={!eligible}
              onClick={() => {
                if (eligible && status)
                  setReviewed({
                    ...status,
                    panelRecipients: status.panelRecipients.map((p) => ({ ...p })),
                  });
              }}
              data-testid="button-review-panel-invitation"
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
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Send meeting request to candidate and panel?</DialogTitle>
            <DialogDescription>
              Outlook will be asked to invite everyone listed below.
            </DialogDescription>
          </DialogHeader>
          {reviewed && (
            <div className="space-y-1 text-sm" data-testid="text-panel-review">
              <p>
                Organizer: <strong>{reviewed.organizerEmail}</strong>
              </p>
              <p>
                Candidate: <strong>{reviewed.recipientEmail}</strong>
              </p>
              <p>
                {formatInterviewInstant(reviewed.scheduledAt)}, {reviewed.durationMinutes} minutes
              </p>
              <p>Panel ({reviewed.panelRecipients.length}):</p>
              <ul className="list-disc pl-5">
                {reviewed.panelRecipients.map((p) => (
                  <li key={p.userId}>
                    {p.name} {p.email}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={sending} onClick={() => setReviewed(null)}>
              Cancel
            </Button>
            <Button
              disabled={!eligible || !samePanelReview(reviewed, status)}
              onClick={() => void send()}
              data-testid="button-confirm-send-panel-invitation"
            >
              {sending ? "Waiting for Outlook..." : "Send invitations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
