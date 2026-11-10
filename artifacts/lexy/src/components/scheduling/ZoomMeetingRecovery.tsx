import { useState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ZoomMeetingView,
  ZoomStaffAccountView,
  ZoomRecoveryReview,
  ZoomRecoveryView,
} from "@workspace/api-client-react";
import { zoomMeetingRequest as request } from "./zoom-meeting-request";

export function ZoomMeetingRecovery({
  meeting,
  account,
  onBusy,
  onResolved,
}: {
  meeting: ZoomMeetingView;
  account: ZoomStaffAccountView;
  onBusy: (busy: boolean) => void;
  onResolved: (result: ZoomMeetingView) => void;
}) {
  const labelId = useId();
  const [meetingId, setMeetingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState<{
    input: ZoomRecoveryReview;
    view: ZoomRecoveryView;
  } | null>(null);
  const path = `/zoom/schedules/${encodeURIComponent(meeting.scheduleId)}/meeting-recovery`;
  function working(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  async function verify() {
    if (!account.revision || !meeting.operationId) return;
    setReview(null);
    setConsent(false);
    setError("");
    const cleaned = meetingId.replace(/[\s-]/g, "");
    if (cleaned && !/^\d{9,15}$/.test(cleaned)) {
      setError("Enter a Zoom meeting ID with 9–15 digits, not a link or a host start URL.");
      return;
    }
    const input: ZoomRecoveryReview = {
      expectedVersion: meeting.version,
      accountRevision: account.revision,
      expectedOperationId: meeting.operationId,
      ...(cleaned ? { meetingId: cleaned } : {}),
    };
    working(true);
    try {
      const view = await request<ZoomRecoveryView>(`${path}-review`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (
        view.scheduleId !== meeting.scheduleId ||
        view.version !== meeting.version ||
        view.operationId !== meeting.operationId ||
        view.accountRevision !== account.revision
      )
        throw new Error("The appointment or host changed. Reload and check again.");
      setReview({ input, view });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Evidence could not be verified. Keep this operation unresolved.",
      );
    } finally {
      working(false);
    }
  }
  async function confirm() {
    if (!review || !consent) return;
    const snap = review;
    setReview(null);
    setConsent(false);
    setError("");
    working(true);
    try {
      const result = await request<ZoomMeetingView>(path, {
        method: "POST",
        body: JSON.stringify({
          ...snap.input,
          confirm: true,
          reason: "provider_evidence_checked",
          expiresAt: snap.view.expiresAt,
          approvalToken: snap.view.approvalToken,
        }),
      });
      if (result.scheduleId !== meeting.scheduleId || result.operationId !== meeting.operationId)
        throw new Error("The recovery receipt did not match. Reload its status.");
      onResolved(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Recovery was not confirmed. Reload its status before another action.",
      );
    } finally {
      working(false);
    }
  }
  return (
    <section
      aria-label="Recover uncertain Zoom operation"
      className="rounded-md border p-3 space-y-3"
    >
      <h3 className="font-medium">Recover an uncertain Zoom result</h3>
      <p>
        This only reads Zoom and reconciles Lexy’s saved status. It never creates, changes or
        deletes a Zoom meeting, and sends no invitation.
      </p>
      <p className="text-muted-foreground">
        For a lost creation response, find the meeting in your original Zoom host account and enter
        its ID. Lexy must verify its exact operation reference. Older meetings without that
        reference remain unresolved.
      </p>
      {!review ? (
        <>
          <label htmlFor={labelId}>Zoom meeting ID (required for lost creation only)</label>
          <Input
            id={labelId}
            value={meetingId}
            disabled={busy}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Leave blank to check the saved meeting"
            onChange={(event) => {
              setMeetingId(event.target.value);
              setError("");
            }}
          />
          <Button disabled={busy} onClick={() => void verify()}>
            Verify Zoom evidence
          </Button>
        </>
      ) : (
        <div className="space-y-2">
          <p>
            Original request: {review.view.action} · Zoom meeting: {review.view.meetingId}
          </p>
          <p>
            Verified host: {account.email} · {review.view.hostZoomId}
          </p>
          {review.view.resolution === "confirmed" ? (
            <p>
              Zoom reports the exact operation at{" "}
              {new Date(review.view.providerStartAt!).toLocaleString()} for{" "}
              {review.view.providerDurationMinutes} minutes. Resolve as confirmed.
            </p>
          ) : (
            <p>
              Zoom reports that this saved meeting does not exist. Resolve the cancellation as
              cancelled.
            </p>
          )}
          <label className="flex gap-2 items-start">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I checked this exact Zoom meeting and outcome.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !consent} onClick={() => void confirm()}>
              Confirm recovery
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setReview(null);
                setConsent(false);
              }}
            >
              Keep unresolved
            </Button>
          </div>
        </div>
      )}
      {busy && <p role="status">Checking provider evidence…</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
