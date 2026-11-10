import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OutlookAvailability,
  OutlookScheduleReceipt,
  OutlookScheduleActionInput,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Calendar, Loader2 } from "lucide-react";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth-context";
import {
  calendarActionInput,
  readCalendarReceipt,
  verifyCalendarActionReceipt,
  type CalendarScheduleView,
} from "@/lib/calendar-schedule-action";
import {
  availableInterviewSlots,
  localWorkWindow,
  validateAvailability,
  type InterviewSlot,
} from "@/lib/calendar-slots";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${BASE}/api${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : "Calendar request failed. Refresh before retrying.",
    );
  return body as T;
}
const localTime = (value: string) =>
  new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
function localDay() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

export function OutlookAvailabilityCard({
  onChooseSlot,
}: {
  onChooseSlot?: (slot: InterviewSlot & { bufferMinutes: number }) => void;
}) {
  const { user } = useAuth();
  const [day, setDay] = useState(localDay);
  const [durationMinutes, setDuration] = useState(60);
  const [bufferMinutes, setBuffer] = useState(15);
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const connection = useQuery({
    queryKey: ["ms-graph-status", user?.id],
    queryFn: () => request<{ calendarConnected: boolean }>("/auth/microsoft-graph/status"),
    enabled: Boolean(user),
    refetchInterval: 60_000,
  });
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(`${day}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const validDay = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime());
  const availability = useQuery<OutlookAvailability>({
    queryKey: ["outlook-calendar", "availability", user?.id, day],
    queryFn: async () => {
      const data = validateAvailability(
        await request(
          `/outlook-calendar/availability?${new URLSearchParams({ start: start.toISOString(), end: end.toISOString() })}`,
        ),
      );
      if (Date.parse(data.start) !== start.getTime() || Date.parse(data.end) !== end.getTime())
        throw new Error("Outlook did not confirm the selected calendar day.");
      return data;
    },
    enabled: Boolean(connection.data?.calendarConnected && validDay),
    retry: false,
    refetchInterval: 60_000,
  });
  const fresh = clock - availability.dataUpdatedAt <= 60_000;
  let slots: InterviewSlot[] = [];
  let slotError = "";
  if (availability.data && fresh && !availability.isError) {
    try {
      slots = availableInterviewSlots(availability.data, {
        ...localWorkWindow(day, workStart, workEnd),
        durationMinutes,
        bufferMinutes,
        now: clock,
      });
    } catch (error) {
      slotError =
        error instanceof Error ? error.message : "Available times could not be calculated.";
    }
  }
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex justify-between items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" /> My Outlook availability
          </h2>
          <Link href="/recruiter/settings" className="text-sm text-primary underline">
            Manage connection
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Private busy periods from your connected calendar only. This does not check other
          interviewers or send invitations. Times use your browser’s time zone:{" "}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}.
        </p>
        {connection.isError ? (
          <p role="alert">
            Connection status could not be loaded.{" "}
            <Button size="sm" variant="outline" onClick={() => connection.refetch()}>
              Retry
            </Button>
          </p>
        ) : connection.isPending ? (
          <p>Checking connection…</p>
        ) : !connection.data?.calendarConnected ? (
          <p className="text-sm">
            Connect Outlook Calendar in Settings to check availability. Your email integration stays
            separate.
          </p>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="w-full sm:w-auto min-w-0">
                <Label htmlFor="outlook-day">Calendar day</Label>
                <Input
                  id="outlook-day"
                  type="date"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                />
              </div>
              <Button
                className="w-full sm:w-auto"
                variant="outline"
                onClick={() => availability.refetch()}
                disabled={!validDay || availability.isFetching}
              >
                Refresh availability
              </Button>
            </div>
            {!validDay ? (
              <p role="alert">Choose a valid date.</p>
            ) : availability.isFetching ? (
              <p>
                <Loader2 className="inline w-4 h-4 animate-spin" /> Checking Outlook…
              </p>
            ) : availability.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {availability.error.message} Availability is unknown—not free.
              </p>
            ) : availability.data ? (
              <div className="space-y-1 text-sm">
                {availability.data.busy.length ? (
                  availability.data.busy.map((period, i) => (
                    <p key={`${period.start}-${i}`}>
                      Busy: {localTime(period.start)} – {localTime(period.end)}
                    </p>
                  ))
                ) : (
                  <p>
                    No busy periods were reported for this day. Availability is checked again when a
                    hold is created or updated.
                  </p>
                )}
              </div>
            ) : null}
            {availability.data && !availability.isError && (
              <div className="space-y-3 border-t pt-3">
                <h3 className="text-sm font-semibold">Find an interview time</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <Label htmlFor="outlook-work-start">From</Label>
                    <Input
                      id="outlook-work-start"
                      type="time"
                      value={workStart}
                      onChange={(e) => setWorkStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="outlook-work-end">Until</Label>
                    <Input
                      id="outlook-work-end"
                      type="time"
                      value={workEnd}
                      onChange={(e) => setWorkEnd(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="outlook-duration">Duration</Label>
                    <select
                      id="outlook-duration"
                      className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                      value={durationMinutes}
                      onChange={(e) => setDuration(Number(e.target.value))}
                    >
                      {[30, 45, 60, 90, 120].map((value) => (
                        <option key={value} value={value}>
                          {value} minutes
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="outlook-buffer">Meeting buffer</Label>
                    <select
                      id="outlook-buffer"
                      className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                      value={bufferMinutes}
                      onChange={(e) => setBuffer(Number(e.target.value))}
                    >
                      {[0, 5, 10, 15, 30].map((value) => (
                        <option key={value} value={value}>
                          {value} minutes
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Suggestions check only your Outlook calendar, with at least 15 minutes’ notice.
                  Choosing a time opens a draft; it does not reserve a slot or invite anyone. Other
                  interviewers’ calendars are not checked.
                </p>
                {slotError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {slotError}
                  </p>
                ) : !fresh ? (
                  <p role="status" className="text-sm">
                    Refresh availability before choosing a time.
                  </p>
                ) : availability.isFetching ? (
                  <p role="status" className="text-sm">
                    Refreshing available times…
                  </p>
                ) : slots.length === 0 ? (
                  <p role="status" className="text-sm">
                    No available times match these hours, duration and buffer. Try another day or
                    adjust the search.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2" aria-label="Available interview times">
                    {slots.map((slot) => (
                      <Button
                        key={slot.start}
                        size="sm"
                        variant="outline"
                        disabled={!onChooseSlot}
                        onClick={() => {
                          if (Date.now() - availability.dataUpdatedAt > 60_000) {
                            availability.refetch();
                            return;
                          }
                          onChooseSlot?.({ ...slot, bufferMinutes });
                        }}
                      >
                        {new Date(slot.start).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function OutlookScheduleControls({
  schedule,
  onUpdate,
}: {
  schedule: CalendarScheduleView;
  onUpdate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<CalendarScheduleView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const shown = snapshot ?? schedule;
  const { toast } = useToast();
  const cache = useQueryClient();
  const path = `/outlook-calendar/schedules/${encodeURIComponent(shown.id)}`;
  const query = useQuery<OutlookScheduleReceipt>({
    queryKey: ["outlook-calendar", "schedule", shown.id, shown.version],
    queryFn: async ({ signal }) =>
      readCalendarReceipt(await request<unknown>(path, { signal }), true),
    enabled: open,
    retry: false,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: OutlookScheduleActionInput["action"]) => {
      if (!query.data || query.isFetching || query.isError || actionError)
        throw new Error(
          "Refresh the linked event and review the saved schedule before continuing.",
        );
      const input = calendarActionInput(action, shown, query.data);
      const result = await request<unknown>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return verifyCalendarActionReceipt(result, action);
    },
    onSuccess: (result, action) => {
      cache.invalidateQueries({ queryKey: ["outlook-calendar"] });
      onUpdate();
      toast({
        title:
          action === "cancel"
            ? result.remoteChanged
              ? "Personal hold and Lexy schedule cancelled"
              : "Lexy schedule cancelled; no linked hold was deleted"
            : action === "pull"
              ? result.event?.cancelled
                ? "Lexy schedule cancelled to match Outlook"
                : "Lexy timing refreshed from Outlook"
              : "Outlook hold confirmed",
        description: "No candidate invitation was sent.",
      });
      setOpen(false);
    },
    onError: (error) => {
      setActionError(
        `${error.message} Outlook may already have changed. Refresh both views before retrying.`,
      );
      cache.invalidateQueries({ queryKey: ["outlook-calendar"] });
      onUpdate();
      toast({
        title: "Calendar action not confirmed",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      actionLock.current = false;
    },
  });
  const stale = !shown.version || query.data?.scheduleVersion !== shown.version;
  const blocked =
    mutation.isPending ||
    query.isFetching ||
    query.isError ||
    !query.data ||
    stale ||
    Boolean(actionError);
  function apply(action: OutlookScheduleActionInput["action"]) {
    if (actionLock.current || blocked) return;
    const description =
      action === "cancel"
        ? query.data?.event
          ? "Cancel this Lexy schedule and delete its linked personal Outlook hold?"
          : "Cancel this Lexy schedule? No linked personal Outlook hold was found, so no calendar event will be deleted. Check Outlook separately for any unlinked meetings."
        : action === "pull"
          ? "Replace the Lexy schedule time with the linked Outlook event time?"
          : action === "update"
            ? "Replace the Outlook hold time with this Lexy schedule time?"
            : "Create a private hold in your own Outlook calendar?";
    if (
      window.confirm(
        `${description}\n\nNo candidate invitation will be sent. Meetings with guests must be managed in Outlook.`,
      )
    ) {
      actionLock.current = true;
      mutation.mutate(action);
    }
  }
  const closed = ["completed", "cancelled"].includes(shown.status);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setSnapshot({ ...schedule });
          setActionError(null);
          setOpen(true);
        }}
      >
        <Calendar className="w-4 h-4 mr-1" /> Outlook
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.isPending && !actionLock.current) setOpen(next);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Outlook interview hold</DialogTitle>
            <DialogDescription>
              Manage a private hold in your own calendar. No candidate or guest emails are sent.
              Native schedule buttons do not automatically update Outlook. Use these controls to
              keep both aligned. Outlook changes are pulled only with “Use Outlook timing”—not in
              the background.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm">
              Lexy: {localTime(shown.scheduledAt)} · {shown.durationMinutes} minutes
            </p>
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            {query.data && stale && (
              <div role="alert" className="space-y-2 text-sm">
                <p>
                  This Lexy schedule changed. Close this dialog and review the latest saved details
                  before making calendar changes.
                </p>
                <Button
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => {
                    onUpdate();
                    setOpen(false);
                  }}
                >
                  Close and reload schedule
                </Button>
              </div>
            )}
            {query.isFetching ? (
              <p>Checking linked event…</p>
            ) : query.isError ? (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>{query.error.message}</p>
                <Button variant="outline" onClick={() => query.refetch()}>
                  Retry
                </Button>
                <Link href="/recruiter/settings" className="block text-primary underline">
                  Connect or reconnect Calendar
                </Link>
              </div>
            ) : query.data ? (
              <>
                {query.data.event ? (
                  <div className="rounded-lg border p-3 text-sm space-y-2">
                    <p>
                      Outlook: {localTime(query.data.event.start)} ·{" "}
                      {query.data.event.durationMinutes} minutes
                      {query.data.event.cancelled ? " · Cancelled" : ""}
                    </p>
                    {query.data.event.webLink && (
                      <a
                        href={query.data.event.webLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        Open in Outlook
                      </a>
                    )}
                  </div>
                ) : (
                  <p className="text-sm">
                    No linked hold was found in your connected Outlook calendar.
                  </p>
                )}
                <div className="flex gap-2 flex-wrap">
                  {!query.data.event ? (
                    <>
                      <Button disabled={blocked || closed} onClick={() => apply("create")}>
                        Add private hold
                      </Button>
                      {!closed && (
                        <Button
                          variant="destructive"
                          disabled={blocked}
                          onClick={() => apply("cancel")}
                        >
                          Cancel Lexy schedule only
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <Button disabled={blocked || closed} onClick={() => apply("update")}>
                        Use Lexy timing
                      </Button>
                      <Button
                        variant="outline"
                        disabled={blocked || closed}
                        onClick={() => apply("pull")}
                      >
                        Use Outlook timing
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={blocked || shown.status === "completed"}
                        onClick={() => apply("cancel")}
                      >
                        Cancel schedule and hold
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    disabled={mutation.isPending || query.isFetching}
                    onClick={() => {
                      setActionError(null);
                      void query.refetch();
                    }}
                  >
                    Refresh event
                  </Button>
                </div>
              </>
            ) : null}
            {mutation.isPending && <p role="status">Waiting for Outlook confirmation…</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
