import { useEffect, useRef, useState } from "react";
import {
  getStaffZoomLink,
  reviewStaffZoomLink,
  publishStaffZoomLink,
  removeStaffZoomLink,
  type StaffZoomLinkView,
} from "@workspace/api-client-react";
import { authHeaders } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { safeZoomJoinUrl, zoomErrorMessage } from "@/lib/zoom-link";

type Sched = {
  id: string;
  type?: string;
  version?: string | null;
  scheduledAt: string;
  durationMinutes?: number | null;
  status: string;
};
type Phase = "idle" | "loading" | "reviewing" | "verifying" | "publishing" | "removing";
type Review = { view: StaffZoomLinkView; draftUrl: string; joinUrl: string };

const REASONS: Record<string, string> = {
  schedule_ineligible: "This schedule is not eligible for a Zoom link.",
  calendar_invitation_exists:
    "A calendar invitation already exists for this interview, so a Zoom link cannot be published here.",
};

export function StaffZoomLink({ schedule }: { schedule: Sched }) {
  const { user } = useAuth() as {
    user?: { id?: string | number; tenantId?: string | null } | null;
  };
  const key = [
    user?.id ?? "anon",
    user?.tenantId ?? "",
    schedule.id,
    schedule.version ?? "",
    schedule.scheduledAt,
    schedule.durationMinutes ?? "",
    schedule.status,
  ].join("|");
  const idRef = useRef(schedule.id);
  idRef.current = schedule.id;
  const epoch = useRef(0);
  const lock = useRef(false);
  const alive = useRef(true);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<StaffZoomLinkView | null>(null);
  const [url, setUrl] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [ack, setAck] = useState(false);
  const [removeAck, setRemoveAck] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const req = () => ({ headers: authHeaders(), cache: "no-store" as const });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  // Auth / schedule / native change: reset everything, invalidate in-flight work.
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setOpen(false);
    setView(null);
    setUrl("");
    setReview(null);
    setAck(false);
    setRemoveAck(false);
    setPhase("idle");
    setError(null);
    setNotice(null);
  }, [key]);

  const dropApproval = () => {
    setReview(null);
    setAck(false);
  };

  async function load(keepError = false): Promise<StaffZoomLinkView | null> {
    const ep = epoch.current;
    setPhase("loading");
    if (!keepError) setError(null);
    try {
      const v = await getStaffZoomLink(idRef.current, req());
      if (!alive.current || ep !== epoch.current) return null;
      if (v.scheduleId !== idRef.current) throw new Error("mismatch");
      setView(v);
      return v;
    } catch (e) {
      if (!alive.current || ep !== epoch.current) return null;
      setView(null);
      dropApproval();
      setError(zoomErrorMessage(e, "read") + " The saved link state is unknown.");
      return null;
    } finally {
      if (alive.current && ep === epoch.current) setPhase("idle");
    }
  }
  const loadRef = useRef<(keep?: boolean) => Promise<StaffZoomLinkView | null>>(load);
  loadRef.current = load;
  useEffect(() => {
    if (open) void loadRef.current();
  }, [open, key]);

  // Review expiry
  useEffect(() => {
    const at = review?.view.reviewExpiresAt;
    if (!at) return;
    const t = window.setTimeout(
      () => {
        if (phase === "publishing") return;
        dropApproval();
        setError("The review expired. Review the link again.");
      },
      Math.max(0, Date.parse(at) - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [review, phase]);

  // Editing the URL invalidates approval.
  function onUrl(v: string) {
    setUrl(v);
    setNotice(null);
    if (review && v !== review.draftUrl) dropApproval();
  }

  async function doReview() {
    if (lock.current || !view) return;
    const safe = safeZoomJoinUrl(url.trim());
    if (!safe) {
      setError(
        "Enter a Zoom join link (https://...zoom.us/j/<meeting id>). Host or start links are not accepted.",
      );
      return;
    }
    lock.current = true;
    const ep = epoch.current;
    dropApproval();
    setError(null);
    setNotice(null);
    setPhase("reviewing");
    try {
      const r = await reviewStaffZoomLink(
        idRef.current,
        {
          expectedVersion: view.version,
          expectedPublicationId: view.publicationId,
          joinUrl: url.trim(),
        },
        req(),
      );
      if (!alive.current || ep !== epoch.current) return;
      const norm = safeZoomJoinUrl(r.joinUrl);
      if (
        r.scheduleId !== idRef.current ||
        !r.canPublish ||
        !r.approvalToken ||
        !r.reviewExpiresAt ||
        !norm ||
        Date.parse(r.reviewExpiresAt) <= Date.now() ||
        r.version !== view.version ||
        r.publicationId !== view.publicationId
      )
        throw Object.assign(new Error("bad review"), { status: 0 });
      setReview({ view: r, draftUrl: url, joinUrl: norm });
    } catch (e) {
      if (!alive.current || ep !== epoch.current) return;
      setError(zoomErrorMessage(e, "review"));
      if ((e as { status?: number }).status === 409) void loadRef.current(true); // draft preserved
    } finally {
      if (alive.current && ep === epoch.current) {
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  async function publish() {
    const snap = review;
    if (lock.current || !snap || !ack || !view) return;
    lock.current = true;
    const ep = epoch.current;
    const live = () => alive.current && ep === epoch.current;
    setError(null);
    setPhase("verifying");
    try {
      const fresh = await getStaffZoomLink(idRef.current, req());
      if (!live()) return;
      if (
        fresh.version !== snap.view.version ||
        fresh.publicationId !== snap.view.publicationId ||
        !fresh.canPublish ||
        Date.parse(snap.view.reviewExpiresAt as string) <= Date.now() ||
        url !== snap.draftUrl
      ) {
        setView(fresh);
        dropApproval();
        setError(
          "The interview or link changed, or the review expired. Nothing was published. Review again.",
        );
        lock.current = false;
        setPhase("idle");
        return;
      }
      setPhase("publishing");
    } catch (e) {
      if (!live()) return;
      dropApproval();
      setError(zoomErrorMessage(e, "re-check") + " Publishing was not attempted.");
      lock.current = false;
      setPhase("idle");
      return;
    }
    if (!live()) return;
    try {
      const r = await publishStaffZoomLink(
        idRef.current,
        {
          expectedVersion: snap.view.version,
          expectedPublicationId: snap.view.publicationId,
          joinUrl: snap.joinUrl,
          approvalToken: snap.view.approvalToken as string,
          reviewExpiresAt: snap.view.reviewExpiresAt as string,
          confirm: true,
        },
        req(),
      );
      if (!live()) return;
      if (r.state !== "published" || safeZoomJoinUrl(r.joinUrl) !== snap.joinUrl)
        throw new Error("unconfirmed");
      setView(r);
      setUrl("");
      dropApproval();
      setNotice("Staff-provided link published in Lexy. Nothing was created or sent in Zoom.");
    } catch (e) {
      if (!live()) return;
      dropApproval();
      const st = (e as { status?: number }).status;
      setError(
        st
          ? zoomErrorMessage(e, "publish")
          : "Lexy could not confirm the link was published. Reloading the saved state; check it before retrying.",
      );
      if (!st || st === 409) await loadRef.current(true);
    } finally {
      if (live()) {
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  async function remove() {
    if (lock.current || !view || !view.publicationId || !removeAck) return;
    lock.current = true;
    const ep = epoch.current;
    const live = () => alive.current && ep === epoch.current;
    setError(null);
    setPhase("removing");
    try {
      const r = await removeStaffZoomLink(
        idRef.current,
        { expectedVersion: view.version, expectedPublicationId: view.publicationId, confirm: true },
        req(),
      );
      if (!live()) return;
      if (r.joinUrl || r.state === "published") throw new Error("unconfirmed");
      setView(r);
      setRemoveAck(false);
      dropApproval();
      setNotice(
        "Link removed from Lexy. Candidates no longer see it. The Zoom meeting itself was not changed.",
      );
    } catch (e) {
      if (!live()) return;
      const st = (e as { status?: number }).status;
      setError(
        st
          ? zoomErrorMessage(e, "removal")
          : "Lexy could not confirm the removal. Reloading the saved state.",
      );
      if (!st || st === 409) await loadRef.current(true);
    } finally {
      if (live()) {
        lock.current = false;
        setPhase("idle");
      }
    }
  }

  if (schedule.type === "ai_interview") return null;
  const busy = phase !== "idle";
  const hasLink = !!view?.publicationId && !!view.joinUrl;
  const blockedReason = view?.reason ? REASONS[view.reason] : null;
  const canEdit = !!view && view.canPublish && !blockedReason;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid={`button-staff-zoom-${schedule.id}`}
        onClick={() => setOpen(true)}
      >
        <Video className="w-4 h-4 mr-1" /> Staff-provided Zoom
      </Button>
      <Dialog
        open={open}
        onOpenChange={(n) => {
          if (phase === "publishing" || phase === "removing" || phase === "verifying") return;
          setOpen(n);
          if (!n) {
            dropApproval();
            setRemoveAck(false);
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Staff-provided Zoom link</DialogTitle>
            <DialogDescription>
              Publishes a link you created in Zoom so the candidate can see it in Lexy.
              Staff-provided, not API-verified. Lexy does not create meetings, send invitations,
              cancel or reschedule.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm" data-testid="staff-zoom-body">
            {busy && (
              <p role="status" className="animate-pulse">
                {phase === "loading"
                  ? "Loading saved link..."
                  : phase === "reviewing"
                    ? "Reviewing link..."
                    : phase === "verifying"
                      ? "Re-checking before publishing..."
                      : phase === "publishing"
                        ? "Publishing..."
                        : "Removing..."}
              </p>
            )}
            {error && (
              <div
                role="alert"
                className="text-destructive space-y-2"
                data-testid="text-staff-zoom-error"
              >
                <p>{error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void load()}
                  data-testid="button-staff-zoom-reload"
                >
                  Reload saved state
                </Button>
              </div>
            )}
            {notice && (
              <p role="status" data-testid="text-staff-zoom-notice">
                {notice}
              </p>
            )}
            {view && (
              <div className="rounded-lg border p-3 space-y-1" data-testid="text-staff-zoom-state">
                <p>
                  Role: <strong>{view.jobTitle}</strong>
                </p>
                <p>
                  {formatInterviewInstant(view.scheduledAt)}, {view.durationMinutes} minutes
                </p>
                <p>
                  Saved link:{" "}
                  <strong>
                    {view.state === "none"
                      ? "none"
                      : view.state === "stale"
                        ? "stale (interview changed since it was published)"
                        : "published"}
                  </strong>
                </p>
                {hasLink && (
                  <p className="break-all">
                    {view.joinUrl}{" "}
                    <span className="text-xs text-muted-foreground">
                      (staff-provided, not API-verified)
                    </span>
                  </p>
                )}
                {view.state === "stale" && (
                  <p className="text-xs">
                    The interview time changed after this link was published. Candidates do not see
                    a stale link. Remove it or review a new link.
                  </p>
                )}
                {blockedReason && (
                  <p role="alert" data-testid="text-staff-zoom-blocked">
                    {blockedReason}
                  </p>
                )}
              </div>
            )}
            {canEdit && (
              <div className="space-y-2">
                <label className="block text-xs" htmlFor={`zoom-url-${schedule.id}`}>
                  Zoom join link
                </label>
                <Input
                  id={`zoom-url-${schedule.id}`}
                  value={url}
                  disabled={busy}
                  placeholder="https://example.zoom.us/j/123456789"
                  onChange={(e) => onUrl(e.target.value)}
                  data-testid="input-staff-zoom-url"
                />
                {review && (
                  <div
                    className="rounded-lg border p-3 space-y-1"
                    data-testid="text-staff-zoom-review"
                  >
                    <p>
                      Review: {formatInterviewInstant(review.view.scheduledAt)},{" "}
                      {review.view.durationMinutes} minutes
                    </p>
                    <p>
                      Role: <strong>{review.view.jobTitle}</strong>
                    </p>
                    <p className="break-all">
                      Link: <strong>{review.joinUrl}</strong>
                    </p>
                    <label className="flex items-start gap-2 pt-1">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={ack}
                        disabled={busy}
                        onChange={(e) => setAck(e.target.checked)}
                        data-testid="checkbox-staff-zoom-ack"
                      />
                      <span>
                        I confirm staff created the correct meeting in Zoom. This only publishes the
                        link in Lexy; it sends no invitation and does not create, cancel or
                        reschedule anything.
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}
            {hasLink && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={removeAck}
                  disabled={busy}
                  onChange={(e) => setRemoveAck(e.target.checked)}
                  data-testid="checkbox-staff-zoom-remove"
                />
                <span>
                  I confirm removing this link from Lexy. The Zoom meeting is not cancelled.
                </span>
              </label>
            )}
          </div>
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            {hasLink && (
              <Button
                variant="outline"
                disabled={busy || !removeAck}
                onClick={() => void remove()}
                data-testid="button-staff-zoom-remove"
              >
                Remove link
              </Button>
            )}
            {canEdit && (
              <Button
                variant="outline"
                disabled={busy || !url.trim()}
                onClick={() => void doReview()}
                data-testid="button-staff-zoom-review"
              >
                Review link
              </Button>
            )}
            {canEdit && (
              <Button
                disabled={busy || !review || !ack}
                onClick={() => void publish()}
                data-testid="button-staff-zoom-publish"
              >
                Publish link in Lexy
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
