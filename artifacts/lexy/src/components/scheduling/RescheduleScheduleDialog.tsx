import { useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import { apiBase, apiFetch } from "@/lib/api";
import {
  readNativeSchedules,
  readUpdatedSchedule,
  type ScheduleEditRecord,
} from "@/lib/schedule-edit";
import {
  canReschedule,
  hasRequestedTiming,
  initialRescheduleDraft,
  rescheduleUpdate,
} from "@/lib/schedule-reschedule";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@workspace/react-hooks/use-toast";

export function RescheduleScheduleDialog({
  schedule,
  onSaved,
  onClose,
  suggestedStart,
}: {
  schedule: ScheduleEditRecord;
  /** Prefills the draft date/time only; baseline and version stay the saved schedule. */
  suggestedStart?: string | null;
  onSaved: (saved: ScheduleEditRecord) => Promise<void>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [baseline, setBaseline] = useState(schedule);
  const [draft, setDraft] = useState(() =>
    initialRescheduleDraft(
      suggestedStart ? { ...schedule, scheduledAt: suggestedStart } : schedule,
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [latest, setLatest] = useState<ScheduleEditRecord | null>(null);
  const locked = useRef(false);
  const originalStart = schedule.scheduledAt;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "your browser's time zone";
  let validation = "";
  try {
    rescheduleUpdate(baseline, draft, originalStart);
  } catch (failure) {
    validation = failure instanceof Error ? failure.message : "Check the date and duration.";
  }

  async function save() {
    if (locked.current || needsReview) return;
    locked.current = true;
    setPending(true);
    setError("");
    let attempted = false;
    try {
      const update = rescheduleUpdate(baseline, draft, originalStart);
      attempted = true;
      const saved = await readUpdatedSchedule(
        await apiFetch(`${apiBase}/coordinator/schedules/${encodeURIComponent(baseline.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        }),
        baseline.id,
      );
      if (
        saved.applicationId !== baseline.applicationId ||
        saved.status !== "rescheduled" ||
        !hasRequestedTiming(saved, draft, originalStart)
      )
        throw new Error("The saved schedule could not be verified. Review its latest details.");
      await onSaved(saved);
      toast({
        title: "Rescheduled in Lexy",
        description:
          "No candidate invitation or Outlook event was changed. Review any existing Outlook hold separately.",
      });
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The server did not confirm this update.",
      );
      // A lost/malformed reply may follow a committed write. Read before retrying.
      if (
        attempted &&
        !(failure instanceof Error && "status" in failure && failure.status === 400)
      ) {
        setNeedsReview(true);
        setLatest(null);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  async function reviewLatest() {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      const rows = await readNativeSchedules(
        await apiFetch(
          `${apiBase}/coordinator/schedules?${new URLSearchParams({
            applicationId: baseline.applicationId,
          })}`,
        ),
      );
      const current = rows.find(
        (row) => row.id === baseline.id && row.applicationId === baseline.applicationId,
      );
      if (!current)
        throw new Error("This schedule is no longer available to you. Your draft has been kept.");
      setLatest(current);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Latest details unavailable. Your draft has been kept.",
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  async function adoptSavedSchedule() {
    if (
      !latest ||
      !canReschedule(latest) ||
      !hasRequestedTiming(latest, draft, originalStart) ||
      locked.current
    )
      return;
    locked.current = true;
    setPending(true);
    try {
      await onSaved(latest);
      toast({
        title: "Using the current saved schedule",
        description:
          "Its time and duration already match your draft. No new update, invitation or calendar change was sent.",
      });
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The saved schedule could not be shown. Your draft has been kept.",
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked.current) onClose();
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reschedule in Lexy</DialogTitle>
          <DialogDescription>
            Change this interview’s date, time or duration in Lexy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-sm">
            {String(schedule.candidateName || "Candidate")} ·{" "}
            {String(schedule.jobTitle || "Interview")}
          </p>
          <p className="text-sm text-muted-foreground">
            Current time: {format(parseISO(baseline.scheduledAt), "PPpp OOOO")} ·{" "}
            {baseline.durationMinutes} minutes. Times use {zone}.
          </p>
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            This changes only the Lexy schedule. Calendar availability has not been checked.
            Existing Outlook holds stay at their old time. No candidate invitation or calendar
            update will be sent. Interviewer, location, notes and feedback stay unchanged.
          </div>
          <fieldset disabled={pending} className="space-y-3 min-w-0">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="reschedule-date">New date</Label>
                <Input
                  className="min-w-0"
                  id="reschedule-date"
                  type="date"
                  required
                  value={draft.date}
                  onChange={(event) => setDraft({ ...draft, date: event.target.value })}
                />
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor="reschedule-time">New time</Label>
                <Input
                  className="min-w-0"
                  id="reschedule-time"
                  type="time"
                  required
                  value={draft.time}
                  onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reschedule-duration">Duration in minutes</Label>
              <Input
                id="reschedule-duration"
                type="number"
                min={5}
                max={480}
                step={1}
                required
                value={draft.durationMinutes}
                onChange={(event) => setDraft({ ...draft, durationMinutes: event.target.value })}
              />
            </div>
          </fieldset>
          {validation && !needsReview && (
            <p className="text-sm text-muted-foreground">{validation}</p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error} Your draft is still here.
            </p>
          )}
          {needsReview && (
            <section
              className="rounded-lg border border-amber-500/40 p-3 space-y-3 text-sm"
              role="status"
            >
              <p>
                The update is not confirmed. Review the latest saved schedule before retrying; your
                draft has been kept.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void reviewLatest()}
              >
                {pending ? "Loading…" : "Review latest saved schedule"}
              </Button>
              {latest && (
                <>
                  <p>
                    Latest: {format(parseISO(latest.scheduledAt), "PPpp OOOO")} ·{" "}
                    {latest.durationMinutes} minutes · {latest.status}.
                  </p>
                  <p>
                    Interviewer: {String(latest.interviewerName || "Not set")}. Location:{" "}
                    {String(latest.location || "Not set")}.
                  </p>
                  {!canReschedule(latest) ? (
                    <p>
                      This schedule is closed and cannot be rescheduled. Close this draft and create
                      a new schedule if needed.
                    </p>
                  ) : hasRequestedTiming(latest, draft, originalStart) ? (
                    <>
                      <p>The saved time and duration already match your draft.</p>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void adoptSavedSchedule()}
                      >
                        Use this saved schedule
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      className="h-auto whitespace-normal"
                      onClick={() => {
                        setBaseline(latest);
                        setLatest(null);
                        setNeedsReview(false);
                        setError("");
                      }}
                    >
                      Keep my draft and use this version
                    </Button>
                  )}
                </>
              )}
            </section>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Close without saving
            </Button>
            <Button type="submit" disabled={pending || needsReview || !!validation}>
              {pending ? "Please wait…" : "Save new time in Lexy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
