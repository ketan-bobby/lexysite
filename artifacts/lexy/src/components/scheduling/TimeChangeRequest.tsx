import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readTimeChangeView, type TimeChangeView } from "@/lib/time-change-request";
import { formatInterviewInstant } from "@/lib/interview-time-display";

/** Same request flow for portal owners, candidate-bound links and authorized staff. */
export function TimeChangeRequest({
  scheduleId,
  token,
  staff = false,
}: {
  scheduleId?: string;
  token?: string;
  staff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TimeChangeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const lock = useRef(false);
  const identity = `${staff}|${scheduleId ?? ""}|${token ?? ""}`;
  const generation = useRef(identity);
  generation.current = identity;
  const invoke = useCallback(
    async (write: boolean, body?: Record<string, unknown>, withdraw = false) => {
      const base = token
        ? `/public/interview-booking/time-change${write ? "" : "/read"}`
        : `/${staff ? "coordinator/schedules" : "portal/interview-schedules"}/${encodeURIComponent(scheduleId ?? "")}/time-change-request`;
      const path = `${base}${withdraw ? "/withdraw" : ""}`;
      const response = await apiFetch(`${apiBase}${path}`, {
        method: write || token ? "POST" : "GET",
        ...(token ? { credentials: "omit" as const, referrerPolicy: "no-referrer" as const } : {}),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...(write || token
          ? { body: JSON.stringify({ ...body, ...(token ? { token } : {}) }) }
          : {}),
      });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "Request status is unavailable. Reload or contact your recruiter.",
        );
      return readTimeChangeView(value, scheduleId);
    },
    [scheduleId, token, staff],
  );
  const load = useCallback(async () => {
    if (lock.current) return;
    const mine = ++seq.current;
    const key = generation.current;
    setBusy(true);
    setView(null); // No action against an unverified proposal during refresh.
    setError(null);
    try {
      const next = await invoke(false);
      if (mine === seq.current && key === generation.current) setView(next);
    } catch (e) {
      if (mine === seq.current && key === generation.current)
        setError(e instanceof Error ? e.message : "Request status unavailable.");
    } finally {
      if (mine === seq.current && key === generation.current) setBusy(false);
    }
  }, [invoke]);
  useEffect(() => {
    ++seq.current;
    setOpen(false);
    setView(null);
    setError(null);
    setBusy(false);
    // An old operation retains its own lock until it settles; identity guards
    // prevent its response from being shown on another schedule.
  }, [identity]);
  useEffect(() => {
    if (!open) return;
    void load();
    const focus = () => void load();
    const timer = window.setInterval(focus, 30_000);
    window.addEventListener("focus", focus);
    return () => {
      ++seq.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [open, load]);
  async function submit(withdraw = false) {
    if (
      !view ||
      busy ||
      lock.current ||
      (!staff && (withdraw ? !view.canWithdraw : !view.canRequest)) ||
      (staff && (!view.request || view.request.reviewedAt || view.request.withdrawnAt))
    )
      return;
    const reviewed = view;
    const key = generation.current;
    ++seq.current;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke(
        true,
        staff
          ? { requestId: reviewed.request!.id }
          : {
              confirm: true,
              expectedVersion: reviewed.version,
              ...(withdraw ? { requestId: reviewed.request!.id } : {}),
            },
        withdraw,
      );
      if (key !== generation.current) return;
      if (
        !next.request ||
        (staff
          ? next.request.id !== reviewed.request!.id ||
            !next.request.reviewedAt ||
            !!next.request.withdrawnAt
          : next.version !== reviewed.version ||
            !next.request.currentProposal ||
            (withdraw
              ? next.request.id !== reviewed.request!.id ||
                !next.request.withdrawnAt ||
                !!next.request.reviewedAt ||
                next.canWithdraw
              : !!next.request.withdrawnAt))
      )
        throw new Error("The saved request could not be verified.");
      setView(next);
    } catch {
      if (key === generation.current) {
        setView(null);
        setError(
          "The outcome could not be confirmed. Reload status before trying again; no appointment change or invitation was requested.",
        );
      }
    } finally {
      lock.current = false;
      if (key === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={staff ? "button-review-time-change" : "button-request-time-change"}
      >
        {staff ? "Time-change requests" : "Request a different time"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!lock.current) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {staff ? "Review time-change request" : "Need a different interview time?"}
            </DialogTitle>
            <DialogDescription>
              {staff
                ? "Review the request, then use the existing reschedule controls if a new proposal is needed."
                : "Tell the recruiting team that this time does not work. They will review your request and arrange another proposal."}{" "}
              The appointment stays unchanged. No calendar event or invitation is created.
            </DialogDescription>
          </DialogHeader>
          {busy && <p role="status">Checking request…</p>}
          {view && (
            <div className="space-y-3 text-sm">
              <p>
                Current time: {formatInterviewInstant(view.scheduledAt)} · {view.durationMinutes}{" "}
                minutes
              </p>
              {view.request && (
                <p role="status" data-testid="status-time-change-request">
                  {view.request.withdrawnAt
                    ? "Request withdrawn — appointment unchanged"
                    : view.request.reviewedAt
                      ? "Reviewed by the recruiting team"
                      : "Request saved — awaiting staff review"}
                  {" · "}
                  {formatInterviewInstant(
                    view.request.withdrawnAt ?? view.request.reviewedAt ?? view.request.requestedAt,
                  )}
                  {!view.request.currentProposal && " · This request concerns an earlier proposal."}
                </p>
              )}
              {!staff && !view.request && !view.canRequest && (
                <p>
                  This interview is no longer available for a time-change request. Contact your
                  recruiter.
                </p>
              )}
              {staff && !view.request && (
                <p>No time-change request is recorded for this candidate.</p>
              )}
              <Button
                disabled={
                  busy ||
                  (staff
                    ? !view.request || !!view.request.reviewedAt || !!view.request.withdrawnAt
                    : !view.canRequest)
                }
                onClick={() => void submit()}
                data-testid="button-submit-time-change"
              >
                {staff ? "Mark request reviewed" : "Send time-change request"}
              </Button>
              {!staff && view.canWithdraw && (
                <div className="space-y-2">
                  <p>
                    You can withdraw this request before staff review. This does not cancel your
                    interview.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void submit(true)}
                    data-testid="button-withdraw-time-change"
                  >
                    Withdraw time-change request
                  </Button>
                </div>
              )}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Reload status
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
