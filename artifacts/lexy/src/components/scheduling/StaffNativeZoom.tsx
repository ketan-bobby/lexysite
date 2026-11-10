import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { zoomMeetingRequest as request } from "./zoom-meeting-request";
import { ZoomMeetingRecovery } from "./ZoomMeetingRecovery";
import { useAuth } from "@/lib/auth-context";
import type {
  ZoomMeetingView,
  ZoomMeetingReviewView,
  ZoomStaffAccountView,
  ZoomMeetingReview,
} from "@workspace/api-client-react";
import { safeZoomJoinUrl } from "@/lib/zoom-link";

type Action = ZoomMeetingReview["action"];
export function StaffNativeZoom({
  schedule,
}: {
  schedule: { id: string; scheduledAt?: string | null };
}) {
  const { user } = useAuth();
  return user ? (
    <StaffNativeZoomInner
      key={`${user.id}:${user.tenantId ?? ""}:${schedule.id}:${schedule.scheduledAt ?? ""}`}
      schedule={schedule}
    />
  ) : null;
}
function StaffNativeZoomInner({
  schedule,
}: {
  schedule: { id: string; scheduledAt?: string | null };
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [meeting, setMeeting] = useState<ZoomMeetingView | null>(null);
  const [account, setAccount] = useState<ZoomStaffAccountView | null>(null);
  const [review, setReview] = useState<{
    details: ZoomMeetingReviewView;
    input: ZoomMeetingReview;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `/zoom/schedules/${encodeURIComponent(schedule.id)}/meeting`;
  async function load() {
    setReview(null);
    setNotice("");
    setMeeting(null);
    setAccount(null);
    setError("");
    setBusy(true);
    try {
      const [nextMeeting, nextAccount] = await Promise.all([
        request<ZoomMeetingView>(path),
        request<ZoomStaffAccountView>("/zoom-account/me"),
      ]);
      if (nextMeeting.scheduleId !== schedule.id) throw new Error("Zoom status changed. Reload.");
      setMeeting(nextMeeting);
      setAccount(nextAccount);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoom status is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void load();
    // Discard cached approval if the appointment, current user or time changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule.id, schedule.scheduledAt, user?.id]);
  async function start(action: Action) {
    if (!meeting || !account?.connected || !account.revision) return;
    setError("");
    setNotice("");
    setBusy(true);
    const input: ZoomMeetingReview = {
      action,
      expectedVersion: meeting.version,
      expectedOperationId: meeting.operationId,
      accountRevision: account.revision,
    };
    try {
      const details = await request<ZoomMeetingReviewView>(`${path}-review`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (
        details.scheduleId !== meeting.scheduleId ||
        details.version !== meeting.version ||
        details.operationId !== meeting.operationId ||
        details.accountRevision !== account.revision ||
        details.action !== action
      )
        throw new Error("Zoom review changed. Reload before approving.");
      setReview({ details, input });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zoom review failed.");
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!review) return;
    const snap = review;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const [fresh, currentAccount] = await Promise.all([
        request<ZoomMeetingView>(path),
        request<ZoomStaffAccountView>("/zoom-account/me"),
      ]);
      if (
        fresh.version !== snap.input.expectedVersion ||
        fresh.operationId !== snap.input.expectedOperationId ||
        currentAccount.revision !== snap.input.accountRevision ||
        !currentAccount.connected
      )
        throw new Error("Appointment or Zoom account changed. Reload and review again.");
      const result = await request<ZoomMeetingView>(path, {
        method: "POST",
        body: JSON.stringify({
          ...snap.input,
          confirm: true,
          expiresAt: snap.details.expiresAt,
          approvalToken: snap.details.approvalToken,
        }),
      });
      if (result.scheduleId !== schedule.id)
        throw new Error("The provider receipt did not match. Reload.");
      setMeeting(result);
      setNotice(
        snap.input.action === "cancel"
          ? "Zoom accepted the cancellation. No separate email was sent."
          : "Zoom accepted the meeting. Sending a candidate invitation is a separate staff action.",
      );
    } catch (cause) {
      setMeeting(null);
      setAccount(null);
      setError(
        `${cause instanceof Error ? cause.message : "Zoom could not be confirmed."} Check Zoom before trying again; the result may be uncertain.`,
      );
    } finally {
      setBusy(false);
    }
  }
  const mayAct =
    !busy &&
    !!meeting &&
    !!account?.connected &&
    !!account.revision &&
    (!meeting.hostUserId || meeting.hostUserId === user?.id);
  const join = meeting?.providerVerified ? safeZoomJoinUrl(meeting.joinUrl) : null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={`button-native-zoom-${schedule.id}`}
      >
        <Video className="mr-1 h-4 w-4" /> Zoom meeting
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Zoom meeting</DialogTitle>
            <DialogDescription>
              Only your connected Zoom host account can create or change this meeting. Review the
              exact appointment before each action. Zoom does not send a candidate invitation from
              this screen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              Reload meeting and account
            </Button>
            {busy && <p role="status">Checking Zoom…</p>}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {meeting && (
              <>
                <p>
                  Appointment: {meeting.jobTitle} · {new Date(meeting.scheduledAt).toLocaleString()}{" "}
                  · {meeting.durationMinutes} minutes
                </p>
                <p>
                  Status: {meeting.status}
                  {meeting.status === "confirmed" && !meeting.providerVerified
                    ? " · appointment changed; update the Zoom meeting"
                    : ""}
                </p>
                {join && (
                  <a href={join} target="_blank" rel="noopener noreferrer" className="underline">
                    View participant link
                  </a>
                )}
                {["pending", "uncertain"].includes(meeting.status) && (
                  <p role="alert">
                    Zoom may already have accepted an operation. The original host can verify its
                    evidence below. No automatic retry is available.
                  </p>
                )}
                {account?.connected &&
                  account.revision &&
                  meeting.hostUserId === user?.id &&
                  ["pending", "uncertain"].includes(meeting.status) && (
                    <ZoomMeetingRecovery
                      key={`${meeting.operationId}:${meeting.version}:${account.revision}`}
                      meeting={meeting}
                      account={account}
                      onBusy={setBusy}
                      onResolved={(result) => {
                        setMeeting(result);
                        setNotice(
                          "Recovered the verified Zoom outcome. No Zoom meeting was created or changed, and no invitation was sent.",
                        );
                      }}
                    />
                  )}
                {account && !account.connected && (
                  <p role="status">Connect your own Zoom account in Calendar preferences first.</p>
                )}
                {mayAct && !review && (
                  <div className="flex flex-wrap gap-2">
                    {(meeting.status === "none" || meeting.status === "cancelled") && (
                      <Button onClick={() => void start("create")}>Review creation</Button>
                    )}
                    {meeting.status === "confirmed" && (
                      <>
                        {!meeting.providerVerified && (
                          <Button onClick={() => void start("update")}>Review new time</Button>
                        )}
                        <Button variant="outline" onClick={() => void start("cancel")}>
                          Review cancellation
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            {review && (
              <div className="rounded-md border p-3 space-y-2">
                <p>
                  Approve {review.input.action} for {review.details.jobTitle} at{" "}
                  {new Date(review.details.scheduledAt).toLocaleString()} (
                  {review.details.durationMinutes} minutes) using {account?.email}?
                </p>
                <p className="text-muted-foreground">
                  This changes Zoom. It does not send an invitation or update another calendar.
                </p>
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => void approve()}>
                    Confirm in Zoom
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setReview(null)}>
                    Keep unchanged
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
