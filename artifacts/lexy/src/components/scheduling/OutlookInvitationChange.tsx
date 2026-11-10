import { useEffect, useRef, useState } from "react";
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
import { formatInterviewInstant } from "@/lib/interview-time-display";
import type { InvitationSchedule } from "./outlook-invitation-state";
import {
  readInvitationChange,
  sameChange,
  type InvitationChange,
} from "./outlook-invitation-change-state";

export function OutlookInvitationChange({ schedule }: { schedule: InvitationSchedule }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<InvitationChange | null>(null);
  const [reviewed, setReviewed] = useState<InvitationChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const path = `/outlook-calendar/schedules/${encodeURIComponent(schedule.id)}/invitation/change`;
  async function request(body?: unknown) {
    const response = await apiFetch(`${apiBase}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        [400, 403, 404, 409].includes(response.status) && typeof data?.error === "string"
          ? data.error
          : "Outlook status could not be confirmed. Reload status; do not send again.",
      );
    return readInvitationChange(data, schedule.id);
  }
  async function load() {
    if (lock.current) return;
    const mine = ++generation.current;
    setReviewed(null);
    setStatus(null);
    setBusy(true);
    setError(null);
    try {
      const result = await request();
      if (mine === generation.current) setStatus(result);
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : "Reload status.");
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    generation.current++;
    lock.current = false;
    setOpen(false);
    setStatus(null);
    setReviewed(null);
    setBusy(false);
    setSending(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [schedule.id, schedule.version]);
  useEffect(() => {
    if (!open) return;
    void loadRef.current();
    const focus = () => void loadRef.current();
    window.addEventListener("focus", focus);
    return () => {
      generation.current++;
      window.removeEventListener("focus", focus);
    };
  }, [open]);
  const eligible =
    !!status &&
    status.status === "ready" &&
    !busy &&
    !sending &&
    !error &&
    status.version === schedule.version &&
    Date.parse(status.scheduledAt) === Date.parse(schedule.scheduledAt) &&
    status.durationMinutes === schedule.durationMinutes &&
    Date.parse(status.scheduledAt) > Date.now();
  async function send() {
    if (lock.current || !eligible || !reviewed || !sameChange(reviewed, status)) return;
    lock.current = true;
    const mine = ++generation.current;
    const snapshot = reviewed;
    setSending(true);
    setError(null);
    try {
      const result = await request({
        confirm: true,
        expectedVersion: snapshot.version,
        approvalVersion: snapshot.approvalVersion,
      });
      if (mine !== generation.current) return;
      if (
        result.status !== "current" ||
        result.version !== snapshot.version ||
        result.recipientEmail !== snapshot.recipientEmail ||
        result.organizerEmail !== snapshot.organizerEmail ||
        result.scheduledAt !== snapshot.scheduledAt ||
        result.durationMinutes !== snapshot.durationMinutes
      )
        throw new Error(
          "The update receipt did not match the reviewed details. Reload status; do not send again.",
        );
      setStatus(result);
    } catch {
      if (mine === generation.current) {
        setStatus(null);
        setError(
          "Lexy could not confirm whether Outlook updated the meeting. Reload status and check Outlook; do not send again.",
        );
      }
    } finally {
      if (mine === generation.current) {
        setReviewed(null);
        setSending(false);
        lock.current = false;
      }
    }
  }
  if (schedule.status !== "confirmed") return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={`button-outlook-change-${schedule.id}`}
      >
        Update existing Outlook invitation
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!sending) {
            setOpen(v);
            setReviewed(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review Outlook time update</DialogTitle>
            <DialogDescription>
              Saving a time in Lexy does not update Outlook. This action updates the same existing
              candidate meeting. Outlook may email the attendee; it does not create another
              invitation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {busy && <p role="status">Checking the linked meeting…</p>}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {status && (
              <div className="space-y-2 rounded-lg border p-3">
                <p>
                  Candidate: <strong>{status.recipientEmail}</strong>
                </p>
                {status.organizerEmail && <p>Organizer: {status.organizerEmail}</p>}
                {status.previousScheduledAt && (
                  <p>
                    Current Outlook time: {formatInterviewInstant(status.previousScheduledAt)}
                    {status.previousEndAt
                      ? ` – ${formatInterviewInstant(status.previousEndAt)}`
                      : ""}
                  </p>
                )}
                <p>
                  Saved Lexy time: {formatInterviewInstant(status.scheduledAt)} ·{" "}
                  {status.durationMinutes} minutes
                </p>
              </div>
            )}
            {status?.status === "unavailable" && (
              <p>
                This requires a confirmed upcoming interview and a previously accepted Lexy
                invitation from your connected Outlook account. Changed recipients or organizers
                require human review.
              </p>
            )}
            {status?.status === "needs_review" && (
              <p role="alert">
                Needs human review. Check the meeting in Outlook. Lexy will not repeat an uncertain
                update automatically.
              </p>
            )}
            {status?.status === "current" && (
              <p role="status">
                The Outlook meeting matches the saved Lexy time. This does not prove the candidate
                received an email or accepted the change.
              </p>
            )}
            {reviewed && (
              <p role="alert" className="rounded-lg border p-3">
                You are approving the candidate, organizer and time shown above. This does not
                change other panel calendars. Confirm only after reviewing these details.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy || sending} onClick={() => void load()}>
              Reload status
            </Button>
            {reviewed ? (
              <Button
                disabled={!eligible || !sameChange(reviewed, status)}
                onClick={() => void send()}
                data-testid="button-confirm-outlook-change"
              >
                {sending ? "Waiting for Outlook…" : "Approve and update Outlook"}
              </Button>
            ) : (
              <Button
                disabled={!eligible}
                onClick={() => status && setReviewed({ ...status })}
                data-testid="button-review-outlook-change"
              >
                Review update
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
