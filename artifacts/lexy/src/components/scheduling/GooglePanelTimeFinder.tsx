import { useEffect, useMemo, useRef, useState } from "react";
import {
  getGetGooglePanelMembersQueryKey,
  getGetSavedGoogleSchedulePanelQueryKey,
  getGetSavedSchedulePanelQueryKey,
  useFindGooglePanelTimes,
  useGetGooglePanelMembers,
  useGetSavedGoogleSchedulePanel,
  useSaveGoogleSchedulePanel,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, Loader2 } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import { localScheduleFields, localWorkWindow } from "@/lib/calendar-slots";
import type { ScheduleEditRecord } from "@/lib/schedule-edit";
import { useAuth } from "@/lib/auth-context";
import {
  RESULT_TTL_MS,
  STAFF_SEARCH_ROLES,
  parseMembers,
  parseSavedPanel,
  parseTimes,
} from "@/lib/google-panel";

const ELIGIBLE = ["pending", "scheduled", "rescheduled", "confirmed"];
export function canFindGooglePanelTimes(s: ScheduleEditRecord) {
  const t = Date.parse(s.scheduledAt);
  return (
    ELIGIBLE.includes(s.status) && s.type !== "ai_interview" && Number.isFinite(t) && t > Date.now()
  );
}

interface Review {
  start: string;
  ids: string[];
  buffer: number;
  expires: number;
}
export function GooglePanelTimeFinder({ schedule }: { schedule: ScheduleEditRecord }) {
  const { user } = useAuth();
  if (!user || !STAFF_SEARCH_ROLES.includes(user.role) || !canFindGooglePanelTimes(schedule))
    return null;
  return (
    <Inner
      key={`${user.id}:${user.role}:${schedule.id}:${schedule.version}:${schedule.scheduledAt}:${schedule.durationMinutes}`}
      schedule={schedule}
      userId={user.id}
      role={user.role}
    />
  );
}

interface Found {
  checkedAt: string;
  slots: { start: string; end: string }[];
  ids: string[];
  expires: number;
}

function Inner({
  schedule,
  userId,
  role,
}: {
  schedule: ScheduleEditRecord;
  userId: string;
  role: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => localScheduleFields(schedule.scheduledAt).date);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [buffer, setBuffer] = useState("15");
  const [picked, setPicked] = useState<string[]>([]);
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const writeLock = useRef(false);
  const touched = useRef(false);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const gen = useRef(0);
  const lock = useRef(false);
  const ctl = useRef<AbortController | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const key = [...getGetGooglePanelMembersQueryKey(schedule.id), userId, role];
  const members = useGetGooglePanelMembers(schedule.id, {
    query: {
      queryKey: key,
      enabled: open,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  // Saved panel loads on mount, independent of directory health.
  const savedKey = [...getGetSavedGoogleSchedulePanelQueryKey(schedule.id), userId, role];
  const savedQ = useGetSavedGoogleSchedulePanel(schedule.id, {
    query: {
      queryKey: savedKey,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  const savePanel = useSaveGoogleSchedulePanel({ mutation: { retry: false } });
  const saved = parseSavedPanel(savedQ.data, {
    scheduleId: schedule.id,
    durationMinutes: schedule.durationMinutes,
  });
  const savedBad = !savedQ.isError && savedQ.data !== undefined && !saved;
  const forbidden = (savedQ.error as { status?: number } | null)?.status === 403;
  const savedMismatch = !!saved && saved.version !== schedule.version;
  const outlookSaved = !!saved && saved.provider === "outlook" && saved.members.length > 0;
  const googleSaved = !!saved && saved.provider === "google" && saved.members.length > 0;
  const savedReady =
    !!saved &&
    !savedMismatch &&
    !savedQ.isError &&
    !savedQ.isFetching &&
    !forbidden &&
    !outlookSaved;
  const find = useFindGooglePanelTimes({ mutation: { retry: false } });
  const dir = parseMembers(members.data, schedule.id);
  const stale = !!dir && dir.version !== schedule.version;
  const roster = useMemo(() => (dir && !stale ? dir.members : []), [dir, stale]);
  const rosterKey = roster.map((m) => m.id).join("|");

  useEffect(() => {
    if (initialized.current || touched.current || !googleSaved || !saved || !dir || stale) return;
    initialized.current = true;
    if (saved.members.every((m) => roster.some((r) => r.id === m.id))) {
      setPicked(saved.members.map((m) => m.id));
      setBuffer(String(saved.bufferMinutes));
    }
  }, [googleSaved, saved, dir, stale, roster]);

  function reset() {
    gen.current++;
    // A background refresh must not disturb a write that is already in flight.
    if (!writeLock.current) setReview(null);
    lock.current = false;
    setBusy(false);
    setFound(null);
    setError(null);
  }
  useEffect(() => {
    setPicked((p) => p.filter((id) => rosterKey.split("|").includes(id)));
    reset();
  }, [rosterKey]);
  useEffect(() => {
    if (open && (members.isFetching || members.isError)) reset();
  }, [open, members.isFetching, members.isError]);
  useEffect(
    () => () => {
      mounted.current = false;
      gen.current++;
      ctl.current?.abort();
    },
    [],
  );

  const change = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    if (writeLock.current) return;
    touched.current = true;
    reset();
    set(e.target.value);
  };
  function toggle(id: string) {
    if (writeLock.current) return;
    touched.current = true;
    reset();
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 5 ? p : [...p, id]));
  }

  async function search() {
    if (lock.current || !dir || stale || members.isError || members.isFetching) return;
    setError(null);
    let win;
    try {
      win = localWorkWindow(date, from, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the hours.");
      return;
    }
    const span = Date.parse(win.end) - Date.parse(win.start);
    if (span > 25 * 3600_000) return setError("Choose a window of 25 hours or less.");
    if (Date.parse(win.end) <= Date.now() + 15 * 60_000)
      return setError("Choose a window that ends at least 15 minutes from now.");
    if (Date.parse(win.start) > Date.now() + 90 * 86400_000)
      return setError("Choose a date within the next 90 days.");
    const b = Number(buffer);
    if (!Number.isInteger(b) || b < 0 || b > 60)
      return setError("Buffer must be a whole number from 0 to 60 minutes.");
    if (picked.length < 1 || picked.length > 5)
      return setError("Select between 1 and 5 panel members.");
    lock.current = true;
    const mine = ++gen.current;
    const ids = [...picked];
    setBusy(true);
    setFound(null);
    try {
      const r = await find.mutateAsync({
        scheduleId: schedule.id,
        data: {
          expectedVersion: schedule.version,
          userIds: ids,
          start: win.start,
          end: win.end,
          bufferMinutes: b,
        },
      });
      if (mine !== gen.current) return;
      const ok = parseTimes(r, {
        scheduleId: schedule.id,
        version: schedule.version,
        durationMinutes: schedule.durationMinutes,
        panelSize: ids.length,
        start: win.start,
        end: win.end,
        now: Date.now(),
      });
      if (!ok) throw new Error("unconfirmed");
      setFound({ ...ok, ids, expires: Date.now() + RESULT_TTL_MS });
    } catch (e) {
      if (mine !== gen.current) return;
      const status = (e as { status?: number })?.status;
      const msg = (e as { data?: { error?: unknown } })?.data?.error;
      if (status === 409) void members.refetch();
      setError(
        status && [400, 403, 404, 409].includes(status) && typeof msg === "string"
          ? msg
          : "Lexy could not confirm panel availability. This does not mean calendars are free. Search again when ready.",
      );
    } finally {
      if (mine === gen.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }

  function use(slot: { start: string }) {
    if (writeLock.current) return;
    if (!found || Date.now() > found.expires) {
      reset();
      return setError("These results expired. Search again.");
    }
    const cur = parseMembers(qc.getQueryData(key), schedule.id);
    if (
      members.isFetching ||
      members.isError ||
      !cur ||
      cur.version !== schedule.version ||
      !found.ids.every((id) => cur.members.some((m) => m.id === id))
    ) {
      reset();
      return setError("The panel changed. Reload and search again.");
    }
    if (Date.parse(slot.start) < Date.now() + 15 * 60_000) {
      reset();
      return setError("That time is too soon. Search again.");
    }
    // Review only: nothing is written until staff press Save panel and time.
    setSaveErr(null);
    setSaveMsg(null);
    setReview({
      start: slot.start,
      ids: [...found.ids],
      buffer: Number(buffer),
      expires: found.expires,
    });
  }

  function httpMessage(e: unknown) {
    const status = (e as { status?: number })?.status;
    const msg = (e as { data?: { error?: unknown } })?.data?.error;
    return {
      status,
      msg: status && [400, 403, 404, 409].includes(status) && typeof msg === "string" ? msg : null,
    };
  }

  async function commit(kind: "save" | "remove", slot: string, ids: string[], buf: number) {
    if (writeLock.current || !savedReady || needsReload || !saved) return;
    if (kind === "save") {
      const cur = parseMembers(qc.getQueryData(key), schedule.id);
      if (
        !review ||
        Date.now() > review.expires ||
        members.isFetching ||
        members.isError ||
        !cur ||
        cur.version !== schedule.version ||
        !ids.every((id) => cur.members.some((m) => m.id === id)) ||
        ids.length < 1 ||
        ids.length > 5 ||
        !Number.isInteger(buf) ||
        buf < 0 ||
        buf > 60 ||
        Date.parse(slot) < Date.now() + 15 * 60_000
      ) {
        setSaveErr(
          "This review is out of date. Reload the panel and search again. Nothing was saved.",
        );
        return;
      }
    }
    writeLock.current = true;
    const mine = ++gen.current;
    setSaveErr(null);
    setSaveMsg(null);
    setSaveBusy(true);
    try {
      const r = await savePanel.mutateAsync({
        scheduleId: schedule.id,
        data: {
          expectedVersion: schedule.version,
          userIds: ids,
          scheduledAt: slot,
          bufferMinutes: buf,
        },
      });
      const out = parseSavedPanel(r, {
        scheduleId: schedule.id,
        durationMinutes: schedule.durationMinutes,
      });
      const okShape =
        !!out &&
        out.version !== schedule.version &&
        Date.parse(out.scheduledAt) === Date.parse(slot) &&
        out.bufferMinutes === buf &&
        (kind === "save"
          ? out.provider === "google" &&
            out.members.length === ids.length &&
            out.members.every((m) => ids.includes(m.id))
          : out.provider === null && out.members.length === 0);
      if (!okShape) throw new Error("unconfirmed");
      qc.setQueryData(savedKey, r);
      void qc.invalidateQueries({ queryKey: ["coordinator-schedules"] });
      void qc.invalidateQueries({ queryKey: getGetSavedGoogleSchedulePanelQueryKey(schedule.id) });
      void qc.invalidateQueries({ queryKey: getGetSavedSchedulePanelQueryKey(schedule.id) });
      void qc.invalidateQueries({ queryKey: getGetGooglePanelMembersQueryKey(schedule.id) });
      if (!mounted.current) return;
      setReview(null);
      setFound(null);
      setConfirmRemove(false);
      if (kind === "save") {
        setPicked(out!.members.map((m) => m.id));
        setBuffer(String(out!.bufferMinutes));
      } else setPicked([]);
      setSaveMsg(
        kind === "remove"
          ? "Saved Google panel removed. The interview time did not move. The candidate must reconfirm. No calendar was changed and no invitation or email was sent."
          : "Saved. The candidate must reconfirm this time. No calendar was reserved and no invitation or email was sent.",
      );
    } catch (e) {
      if (!mounted.current) return;
      const { status, msg } = httpMessage(e);
      if (msg) {
        setSaveErr(`${msg} Your selection was kept.`);
        if (status === 409) {
          void qc.invalidateQueries({ queryKey: ["coordinator-schedules"] });
          void savedQ.refetch();
        }
      } else {
        setNeedsReload(true);
        setSaveErr(
          "Lexy could not confirm the save, so it may or may not have been saved. Reload the saved panel before trying again. Your selection was kept.",
        );
      }
    } finally {
      writeLock.current = false;
      if (mounted.current) setSaveBusy(false);
      void mine;
    }
  }

  async function reloadSaved() {
    const r = await savedQ.refetch();
    if (r.isSuccess && mounted.current) setNeedsReload(false);
  }

  const disabled = busy || saveBusy;
  return (
    <Card className="mb-8" data-testid={`card-google-panel-times-${schedule.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4 text-primary" /> Find common Google panel times
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Read-only suggestions for the {schedule.durationMinutes}-minute interview from staff who
          opted in to Google sharing. Searching saves nothing. After review, Save panel and time
          stores the panel and time in Lexy only. Saving marks the interview pending for candidate
          reconfirmation; it does not reserve calendars, send invitations or publish candidate
          choices.
        </p>
        <div
          className="rounded-lg border p-3 text-sm space-y-2"
          data-testid={`google-saved-panel-${schedule.id}`}
        >
          <p className="font-medium">Saved Google panel</p>
          {savedQ.isLoading ? (
            <p className="text-muted-foreground">Loading saved panel…</p>
          ) : savedQ.isError || savedBad ? (
            <div role="alert" className="space-y-2">
              <p>
                {forbidden
                  ? "You cannot view or change the saved panel for this schedule."
                  : "The saved panel could not be loaded. This does not mean no panel is saved."}
              </p>
              {!forbidden && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void reloadSaved()}
                  data-testid="button-reload-saved-google-panel"
                >
                  Reload saved panel
                </Button>
              )}
            </div>
          ) : saved ? (
            <div className="space-y-2">
              {outlookSaved ? (
                <div
                  role="alert"
                  data-testid="text-google-panel-outlook-blocked"
                  className="space-y-1"
                >
                  <p>
                    An Outlook panel is saved for this interview:{" "}
                    {saved.members.map((m) => m.name).join(", ")}. Google and Outlook panels cannot
                    be mixed, and this card will not overwrite it.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Remove the Outlook panel with the Outlook panel controls first, then save a
                    Google panel here.
                  </p>
                </div>
              ) : (
                <p data-testid={`text-saved-google-panel-${schedule.id}`}>
                  {googleSaved
                    ? `${saved.members.map((m) => m.name).join(", ")} (buffer ${saved.bufferMinutes} min)`
                    : "No Google panel saved."}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Saved time {formatInterviewInstant(saved.scheduledAt)}. A saved panel is not proof
                of availability and reserves no calendar.
              </p>
              {savedMismatch && (
                <div role="alert" className="text-xs space-y-2">
                  <p>
                    The saved panel belongs to a different schedule revision. Reload the schedule
                    before saving.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void qc.invalidateQueries({ queryKey: ["coordinator-schedules"] });
                      void savedQ.refetch();
                    }}
                  >
                    Reload schedule
                  </Button>
                </div>
              )}
              {googleSaved && !confirmRemove && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!savedReady || saveBusy || needsReload}
                  onClick={() => setConfirmRemove(true)}
                  data-testid="button-remove-google-panel"
                >
                  Remove saved panel
                </Button>
              )}
              {googleSaved && confirmRemove && (
                <div
                  role="alertdialog"
                  aria-label="Confirm panel removal"
                  className="rounded-lg border p-3 space-y-2"
                  data-testid="google-remove-confirm"
                >
                  <p>
                    Remove the saved Google panel? The interview time stays exactly as saved, the
                    interview becomes pending and the candidate must reconfirm. No calendar,
                    invitation or email will change.
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!savedReady || saveBusy || needsReload}
                      onClick={() => void commit("remove", saved.scheduledAt, [], 0)}
                      data-testid="button-confirm-remove-google-panel"
                    >
                      {saveBusy ? "Removing…" : "Yes, remove panel"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saveBusy}
                      onClick={() => setConfirmRemove(false)}
                      data-testid="button-cancel-remove-google-panel"
                    >
                      Keep panel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {needsReload && (
            <Button
              size="sm"
              variant="outline"
              disabled={savedQ.isFetching}
              onClick={() => void reloadSaved()}
              data-testid="button-reload-after-unconfirmed"
            >
              Reload saved panel before retrying
            </Button>
          )}
          {saveMsg && (
            <p role="status" className="text-xs" data-testid="text-google-save-result">
              {saveMsg}
            </p>
          )}
          {saveErr && (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="text-google-save-error"
            >
              {saveErr}
            </p>
          )}
        </div>
        {!open ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            data-testid="button-open-google-panel"
          >
            Check Google panel availability
          </Button>
        ) : members.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading panel…
          </p>
        ) : members.isError || (members.data !== undefined && !dir) ? (
          <div role="alert" className="text-sm space-y-2">
            <p>
              The Google panel directory could not be loaded. This does not mean nobody has opted
              in.
            </p>
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              Reload panel
            </Button>
          </div>
        ) : stale ? (
          <div role="alert" className="text-sm space-y-2">
            <p>
              This schedule changed since the panel was loaded. Refresh the schedule, then reload
              the panel.
            </p>
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              Reload panel
            </Button>
          </div>
        ) : roster.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            No one in scope has opted in to Google panel sharing yet.
          </p>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Panel members (1 to 5)</legend>
              <div className="flex flex-wrap gap-2">
                {roster.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(m.id)}
                      disabled={disabled || (!picked.includes(m.id) && picked.length >= 5)}
                      onChange={() => toggle(m.id)}
                      data-testid={`checkbox-google-panel-${m.id}`}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`gp-date-${schedule.id}`}>Date</Label>
                <Input
                  id={`gp-date-${schedule.id}`}
                  type="date"
                  value={date}
                  onChange={change(setDate)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`gp-from-${schedule.id}`}>From</Label>
                <Input
                  id={`gp-from-${schedule.id}`}
                  type="time"
                  value={from}
                  onChange={change(setFrom)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`gp-to-${schedule.id}`}>Until</Label>
                <Input
                  id={`gp-to-${schedule.id}`}
                  type="time"
                  value={to}
                  onChange={change(setTo)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`gp-buf-${schedule.id}`}>Buffer (min)</Label>
                <Input
                  id={`gp-buf-${schedule.id}`}
                  type="number"
                  min={0}
                  max={60}
                  value={buffer}
                  onChange={change(setBuffer)}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Times use {tz}. Each person's own hours and buffers are applied by Lexy.
            </p>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={busy || members.isFetching || picked.length === 0}
                onClick={() => void search()}
                data-testid="button-search-google-panel"
              >
                {busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                {busy ? "Checking…" : "Find common times"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || members.isFetching}
                onClick={() => void members.refetch()}
              >
                Reload panel
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="text-google-panel-search-error"
          >
            {error}
          </p>
        )}
        {found && (
          <div className="space-y-2" role="status" data-testid="google-panel-results">
            {found.slots.length === 0 ? (
              <p className="text-sm">
                No common times were found. Try other hours, a smaller buffer or a different panel.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {found.slots.map((s) => (
                  <li
                    key={s.start}
                    className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 break-words">
                      {formatInterviewInstant(s.start)} – {formatInterviewInstant(s.end)}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => use(s)}
                      data-testid={`button-use-google-time-${s.start}`}
                    >
                      Review time
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Checked {formatInterviewInstant(found.checkedAt)} for {found.ids.length}{" "}
              {found.ids.length === 1 ? "person" : "people"}. A momentary suggestion: not a
              reservation. Nothing is saved until you review and save; no invitation is sent.
              Showing up to 40 times.
            </p>
          </div>
        )}
        {review && (
          <div
            className="rounded-lg border p-3 space-y-2 text-sm"
            data-testid="google-panel-review"
          >
            <p className="font-medium">Review before saving</p>
            <p>
              {formatInterviewInstant(review.start)} for the {schedule.durationMinutes}-minute
              interview, with{" "}
              {review.ids
                .map((id) => roster.find((m) => m.id === id)?.name ?? "Unknown")
                .join(", ")}{" "}
              (buffer {review.buffer} min).
            </p>
            <p className="text-xs text-muted-foreground">
              Saving replaces any saved Google panel and moves the interview to this time. The
              interview becomes pending and the candidate must reconfirm. No calendar is reserved
              and no invitation or email is sent.
            </p>
            {outlookSaved && (
              <p role="alert" className="text-xs text-destructive">
                An Outlook panel is saved. Remove it with the Outlook controls before saving a
                Google panel.
              </p>
            )}
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={!savedReady || saveBusy || needsReload || members.isFetching}
                onClick={() => void commit("save", review.start, review.ids, review.buffer)}
                data-testid="button-save-google-panel"
              >
                {saveBusy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                {saveBusy ? "Saving…" : "Save panel and time"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saveBusy}
                onClick={() => setReview(null)}
                data-testid="button-cancel-google-review"
              >
                Cancel review
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
