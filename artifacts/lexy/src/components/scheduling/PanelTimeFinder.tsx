import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSavedSchedulePanelQueryKey,
  getGetSchedulePanelMembersQueryKey,
  useFindSchedulePanelTimes,
  useGetSavedSchedulePanel,
  useGetSchedulePanelMembers,
  useSaveSchedulePanel,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, Loader2 } from "lucide-react";
import { formatInterviewInstant } from "@/lib/interview-time-display";
import { localScheduleFields, localWorkWindow } from "@/lib/calendar-slots";
import type { ScheduleEditRecord } from "@/lib/schedule-edit";
import { useAuth } from "@/lib/auth-context";

const ELIGIBLE = ["pending", "scheduled", "rescheduled", "confirmed"];
const MAX_PANEL_REFRESHES = 10;
interface Slot {
  start: string;
  end: string;
}
interface Found {
  checkedAt: string;
  panelSize: number;
  slots: Slot[];
  ids: string[];
  buffer: number;
}
interface Saved {
  scheduleId: string;
  version: string;
  scheduledAt: string;
  durationMinutes: number;
  members: { id: string; name: string }[];
  bufferMinutes: number;
  provider?: string | null;
  calendarReserved: false;
  invitationSent: false;
}

function parseSaved(v: unknown, scheduleId: string): Saved | null {
  const r = v as Partial<Saved> | undefined;
  if (
    !r ||
    r.scheduleId !== scheduleId ||
    !(
      r.provider === undefined ||
      r.provider === null ||
      r.provider === "outlook" ||
      r.provider === "google"
    ) ||
    typeof r.version !== "string" ||
    !r.version ||
    typeof r.scheduledAt !== "string" ||
    !Number.isFinite(Date.parse(r.scheduledAt)) ||
    !Array.isArray(r.members) ||
    r.members.length > 5 ||
    !r.members.every(
      (m) => m && typeof m.id === "string" && !!m.id && typeof m.name === "string",
    ) ||
    new Set(r.members.map((m) => m.id)).size !== r.members.length ||
    !Number.isInteger(r.bufferMinutes) ||
    r.bufferMinutes! < 0 ||
    r.bufferMinutes! > 60 ||
    r.calendarReserved !== false ||
    r.invitationSent !== false
  )
    return null;
  return r as Saved;
}

export function canFindPanelTimes(s: ScheduleEditRecord) {
  const t = Date.parse(s.scheduledAt);
  return (
    ELIGIBLE.includes(s.status) && s.type !== "ai_interview" && Number.isFinite(t) && t > Date.now()
  );
}

export function PanelTimeFinder({ schedule }: { schedule: ScheduleEditRecord }) {
  const { user } = useAuth();
  if (!user || !canFindPanelTimes(schedule)) return null;
  return (
    <PanelTimeFinderInner
      key={`${user.id}:${schedule.id}:${schedule.version}`}
      schedule={schedule}
      userId={user.id}
    />
  );
}

function PanelTimeFinderInner({
  schedule,
  userId,
}: {
  schedule: ScheduleEditRecord;
  userId: string;
}) {
  const [open, setOpen] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date, setDate] = useState(() => localScheduleFields(schedule.scheduledAt).date);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [buffer, setBuffer] = useState("15");
  const [picked, setPicked] = useState<string[]>([]);
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lock = useRef(false);
  const writeLock = useRef(false);
  const mounted = useRef(true);
  const gen = useRef(0);
  const [polls, setPolls] = useState(0);
  const [savedPolls, setSavedPolls] = useState(0);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const savedKey = [...getGetSavedSchedulePanelQueryKey(schedule.id), userId];
  const savedQ = useGetSavedSchedulePanel(schedule.id, {
    query: {
      queryKey: savedKey,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchInterval: () => (savedPolls < MAX_PANEL_REFRESHES ? 30_000 : false),
    },
  });
  const savePanel = useSaveSchedulePanel({ mutation: { retry: false } });
  useEffect(() => {
    if (savedQ.dataUpdatedAt) setSavedPolls((n) => n + 1);
  }, [savedQ.dataUpdatedAt]);
  const saved = parseSaved(savedQ.data, schedule.id);
  const forbidden = (savedQ.error as { status?: number } | null)?.status === 403;
  const googleSaved = saved?.provider === "google";
  const savedMismatch = !!saved && saved.version !== schedule.version;
  const draftTouched = useRef(false);
  const initializedSaved = useRef(false);

  const membersKey = [...getGetSchedulePanelMembersQueryKey(schedule.id), userId];
  const members = useGetSchedulePanelMembers(schedule.id, {
    query: {
      queryKey: membersKey,
      enabled: open,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchInterval: () => (polls < MAX_PANEL_REFRESHES ? 30_000 : false),
    },
  });
  const find = useFindSchedulePanelTimes({ mutation: { retry: false } });
  useEffect(() => {
    if (members.dataUpdatedAt) setPolls((n) => n + 1);
  }, [members.dataUpdatedAt]);

  const data = members.data as unknown as
    | { scheduleId?: string; version?: string; members?: { id: string; name: string }[] }
    | undefined;
  const dataOk =
    !!data &&
    data.scheduleId === schedule.id &&
    Array.isArray(data.members) &&
    typeof data.version === "string" &&
    data.members.every(
      (m) => m && typeof m.id === "string" && !!m.id && typeof m.name === "string",
    ) &&
    new Set(data.members.map((m) => m.id)).size === data.members.length;
  const stale = dataOk && data!.version !== schedule.version;
  const roster = useMemo(() => (dataOk && !stale ? data!.members! : []), [dataOk, stale, data]);
  const rosterKey = roster.map((m) => m.id).join("|");
  useEffect(() => {
    if (initializedSaved.current || draftTouched.current || !saved || !dataOk || stale) return;
    initializedSaved.current = true;
    if (saved.members.length) {
      const allAvailable = saved.members.every((m) => roster.some((r) => r.id === m.id));
      setPicked(allAvailable ? saved.members.map((m) => m.id) : []);
      setBuffer(String(saved.bufferMinutes));
    }
  }, [saved, dataOk, stale, rosterKey]);

  function reset() {
    gen.current++;
    setSaveMsg(null);
    setSaveErr(null);
    lock.current = false;
    setBusy(false);
    setFound(null);
    setError(null);
    setNote(null);
  }
  // Roster change: drop selections no longer present and clear old results.
  useEffect(() => {
    setPicked((p) => p.filter((id) => rosterKey.split("|").includes(id)));
    reset();
  }, [rosterKey]);
  useEffect(() => {
    if (open && (members.isFetching || members.isError)) reset();
  }, [open, members.isFetching, members.isError]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      gen.current++;
    };
  }, []);

  function toggle(id: string) {
    if (writeLock.current) return;
    draftTouched.current = true;
    reset();
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 5 ? p : [...p, id]));
  }

  async function search() {
    if (
      lock.current ||
      writeLock.current ||
      !dataOk ||
      stale ||
      members.isError ||
      members.isFetching
    )
      return;
    setError(null);
    let win;
    try {
      win = localWorkWindow(date, from, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the working hours.");
      return;
    }
    if (Date.parse(win.end) - Date.parse(win.start) > 25 * 3600_000) {
      setError("Choose a window of 25 hours or less.");
      return;
    }
    const b = Number(buffer);
    if (!Number.isInteger(b) || b < 0 || b > 60) {
      setError("Buffer must be a whole number from 0 to 60 minutes.");
      return;
    }
    if (picked.length < 1 || picked.length > 5) {
      setError("Select between 1 and 5 panel members.");
      return;
    }
    lock.current = true;
    const mine = ++gen.current;
    setBusy(true);
    setFound(null);
    try {
      const r = (await find.mutateAsync({
        scheduleId: schedule.id,
        data: {
          expectedVersion: schedule.version,
          userIds: picked,
          start: win.start,
          end: win.end,
          bufferMinutes: b,
        },
      })) as unknown as {
        scheduleId?: string;
        version?: string;
        checkedAt?: unknown;
        panelSize?: number;
        durationMinutes?: number;
        slots?: Slot[];
      };
      if (mine !== gen.current) return;
      const checked = typeof r?.checkedAt === "string" ? r.checkedAt : "";
      if (
        r?.scheduleId !== schedule.id ||
        r.version !== schedule.version ||
        !Number.isFinite(Date.parse(checked)) ||
        r.panelSize !== picked.length ||
        r.durationMinutes !== schedule.durationMinutes ||
        !Array.isArray(r.slots) ||
        r.slots.length > 40 ||
        r.slots.some(
          (s) =>
            !s ||
            typeof s.start !== "string" ||
            typeof s.end !== "string" ||
            !Number.isFinite(Date.parse(s.start)) ||
            !Number.isFinite(Date.parse(s.end)) ||
            Date.parse(s.end) - Date.parse(s.start) !== schedule.durationMinutes * 60000 ||
            Date.parse(s.start) < Date.parse(win.start) ||
            Date.parse(s.end) > Date.parse(win.end),
        )
      )
        throw new Error("unconfirmed");
      setFound({
        checkedAt: checked,
        panelSize: r.panelSize,
        ids: [...picked],
        buffer: b,
        slots: r.slots.slice(0, 40).map((s) => ({
          start: new Date(s.start).toISOString(),
          end: new Date(s.end).toISOString(),
        })),
      });
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

  async function copy(s: Slot) {
    const text = `${formatInterviewInstant(s.start)} – ${formatInterviewInstant(s.end)}`;
    try {
      await navigator.clipboard.writeText(text);
      setNote("Time copied.");
    } catch {
      window.prompt("Copy this time:", text);
    }
  }

  async function save(slot: string, ids: string[], buf: number, label: string) {
    if (
      lock.current ||
      writeLock.current ||
      !saved ||
      googleSaved ||
      savedQ.isError ||
      savedMismatch ||
      savedQ.isFetching ||
      members.isFetching ||
      forbidden
    )
      return;
    if (ids.length < (label === "remove" ? 0 : 1) || ids.length > 5) {
      setSaveErr("Select between 1 and 5 panel members.");
      return;
    }
    if (!Number.isInteger(buf) || buf < 0 || buf > 60) {
      setSaveErr("Buffer must be a whole number from 0 to 60 minutes.");
      return;
    }
    writeLock.current = true;
    setSaveErr(null);
    setSaveMsg(null);
    setSaveBusy(true);
    const mine = ++gen.current;
    try {
      const r = await savePanel.mutateAsync({
        scheduleId: schedule.id,
        data: {
          expectedVersion: schedule.version,
          userIds: ids,
          scheduledAt: slot,
          bufferMinutes: buf,
        },
      } as never);
      const out = parseSaved(r, schedule.id);
      if (
        !out ||
        Date.parse(out.scheduledAt) !== Date.parse(slot) ||
        out.bufferMinutes !== buf ||
        out.members.length !== ids.length ||
        !out.members.every((m) => ids.includes(m.id)) ||
        out.version === schedule.version
      )
        throw new Error("unconfirmed");
      queryClient.setQueryData(savedKey, out);
      void queryClient.invalidateQueries({
        queryKey: getGetSavedSchedulePanelQueryKey(schedule.id),
      });
      void queryClient.invalidateQueries({ queryKey: ["coordinator-schedules"] });
      if (mine !== gen.current || !mounted.current) return;
      setPicked(out.members.map((m) => m.id));
      setBuffer(String(out.bufferMinutes));
      setFound(null);
      setSaveMsg(
        label === "remove"
          ? "Saved panel removed. The interview time did not move."
          : "Saved. The candidate must reconfirm this time. No calendar was reserved and no invitation was sent.",
      );
    } catch (e) {
      if (mine !== gen.current || !mounted.current) return;
      const status = (e as { status?: number })?.status;
      const msg = (e as { data?: { error?: unknown } })?.data?.error;
      setSaveErr(
        status && [400, 403, 404, 409].includes(status) && typeof msg === "string"
          ? msg
          : "Lexy could not confirm the save, so it may not have been saved. Reload the saved panel before trying again. Your selection was kept.",
      );
    } finally {
      writeLock.current = false;
      if (mounted.current) setSaveBusy(false);
    }
  }
  function removePanel() {
    if (!saved) return;
    if (
      window.confirm(
        "Remove the saved panel? The interview time will stay exactly as saved. No calendar or invitation will change.",
      )
    )
      void save(saved.scheduledAt, [], 0, "remove");
  }
  const canSave =
    !!saved &&
    !googleSaved &&
    !savedQ.isError &&
    !savedMismatch &&
    !savedQ.isFetching &&
    !saveBusy &&
    !busy &&
    !forbidden;

  const noRoster = dataOk && !stale && roster.length === 0;
  const change = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    if (writeLock.current) return;
    reset();
    set(e.target.value);
  };

  return (
    <Card className="mb-8" data-testid={`card-panel-times-${schedule.id}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4 text-primary" /> Find common panel times
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Suggests times when the selected staff are all free, for the saved{" "}
          {schedule.durationMinutes}-minute interview. Only staff who opted in under Settings are
          listed. Individual events and busy periods are never shown.
        </p>
        <div
          className="rounded-lg border p-3 text-sm space-y-2"
          data-testid={`panel-saved-${schedule.id}`}
        >
          <p className="font-medium">Saved panel</p>
          {savedQ.isLoading ? (
            <p className="text-muted-foreground">Loading saved panel…</p>
          ) : savedQ.isError || !saved ? (
            <div role="alert" className="space-y-2">
              <p>
                {forbidden
                  ? "You cannot view or change the saved panel for this schedule."
                  : "The saved panel could not be loaded. This does not mean no panel is saved."}
              </p>
              {!forbidden && (
                <Button variant="outline" size="sm" onClick={() => void savedQ.refetch()}>
                  Reload saved panel
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <p data-testid={`text-saved-panel-${schedule.id}`}>
                {saved.members.length
                  ? saved.members.map((m) => m.name).join(", ")
                  : "No panel saved."}
                {saved.members.length > 0 && ` (buffer ${saved.bufferMinutes} min)`}
              </p>
              <p className="text-xs text-muted-foreground">
                Saved time {formatInterviewInstant(saved.scheduledAt)}. A saved panel is not proof
                of availability and reserves no calendar.
              </p>
              {googleSaved && (
                <p
                  role="status"
                  className="text-xs"
                  data-testid={`text-google-panel-readonly-${schedule.id}`}
                >
                  This is a Google panel. It is read-only here and cannot be changed or removed with
                  Outlook controls. Use the Google panel card to manage it.
                </p>
              )}
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
                      void queryClient.invalidateQueries({ queryKey: ["coordinator-schedules"] });
                      void savedQ.refetch();
                    }}
                  >
                    Reload schedule
                  </Button>
                </div>
              )}
              {!forbidden && !googleSaved && saved.members.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSave}
                  onClick={removePanel}
                  data-testid="button-remove-saved-panel"
                >
                  Remove saved panel
                </Button>
              )}
            </div>
          )}
          {saveMsg && (
            <p role="status" className="text-xs" data-testid="text-save-panel-result">
              {saveMsg}
            </p>
          )}
          {saveErr && (
            <p role="alert" className="text-xs text-destructive">
              {saveErr}
            </p>
          )}
        </div>
        {!open ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPolls(0);
              setOpen(true);
            }}
            data-testid="button-open-panel-times"
          >
            Check panel availability
          </Button>
        ) : members.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading panel…
          </p>
        ) : members.isError || (!!data && !dataOk) ? (
          <div role="alert" className="text-sm space-y-2">
            <p>The panel directory could not be loaded. This does not mean nobody has opted in.</p>
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              Reload panel
            </Button>
          </div>
        ) : stale ? (
          <div role="alert" className="text-sm space-y-2">
            <p>
              This schedule changed since the panel directory was loaded. Refresh the schedule, then
              reload the panel.
            </p>
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              Reload panel
            </Button>
          </div>
        ) : noRoster ? (
          <p className="text-sm text-muted-foreground" role="status">
            No one in scope has opted in yet. Each person must turn on panel sharing in Settings
            before they appear here.
          </p>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Panel members (1 to 5)</legend>
              <div className="flex flex-wrap gap-2">
                {roster.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(m.id)}
                      disabled={busy || saveBusy || (!picked.includes(m.id) && picked.length >= 5)}
                      onChange={() => toggle(m.id)}
                      data-testid={`checkbox-panel-${m.id}`}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </fieldset>
            {saved && saved.members.some((m) => !roster.some((r) => r.id === m.id)) && (
              <p role="alert" className="text-sm text-destructive">
                Some saved panel members are no longer available to select. Review the saved names
                above and deliberately choose a replacement panel before saving.
              </p>
            )}
            <div
              className="grid grid-cols-2 md:grid-cols-4 gap-3"
              onChangeCapture={() => {
                draftTouched.current = true;
              }}
            >
              <div className="space-y-1">
                <Label htmlFor={`pf-date-${schedule.id}`}>Date</Label>
                <Input
                  id={`pf-date-${schedule.id}`}
                  type="date"
                  value={date}
                  onChange={change(setDate)}
                  disabled={busy || saveBusy}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`pf-from-${schedule.id}`}>From</Label>
                <Input
                  id={`pf-from-${schedule.id}`}
                  type="time"
                  value={from}
                  onChange={change(setFrom)}
                  disabled={busy || saveBusy}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`pf-to-${schedule.id}`}>Until</Label>
                <Input
                  id={`pf-to-${schedule.id}`}
                  type="time"
                  value={to}
                  onChange={change(setTo)}
                  disabled={busy || saveBusy}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`pf-buf-${schedule.id}`}>Buffer (min)</Label>
                <Input
                  id={`pf-buf-${schedule.id}`}
                  type="number"
                  min={0}
                  max={60}
                  value={buffer}
                  onChange={change(setBuffer)}
                  disabled={busy || saveBusy}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Times use {tz}.</p>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={busy || saveBusy || members.isFetching || picked.length === 0}
                onClick={() => void search()}
                data-testid="button-search-panel-times"
              >
                {busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                {busy ? "Checking…" : "Find common times"}
              </Button>
              {!forbidden && !googleSaved && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSave || members.isFetching || picked.length === 0}
                  onClick={() => void save(schedule.scheduledAt, picked, Number(buffer), "current")}
                  data-testid="button-save-panel-current-time"
                >
                  Save panel at current time
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || saveBusy || members.isFetching}
                onClick={() => void members.refetch()}
              >
                Reload panel
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {found && (
          <div className="space-y-2" role="status">
            {found.slots.length === 0 ? (
              <p className="text-sm">
                No common times were found in this window. Try other hours, a smaller buffer or a
                different panel.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {found.slots.map((s) => (
                  <li
                    key={s.start}
                    className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 text-sm"
                  >
                    <span>
                      {formatInterviewInstant(s.start)} – {formatInterviewInstant(s.end)}
                    </span>
                    <span className="flex gap-1 flex-wrap">
                      <Button size="sm" variant="ghost" onClick={() => void copy(s)}>
                        Copy time
                      </Button>
                      {!forbidden && !googleSaved && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canSave}
                          onClick={() => void save(s.start, found.ids, found.buffer, "slot")}
                          data-testid={`button-save-slot-${s.start}`}
                        >
                          {saveBusy ? "Saving…" : "Save panel and time"}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Checked {formatInterviewInstant(found.checkedAt)} for {found.panelSize}{" "}
              {found.panelSize === 1 ? "person" : "people"}. This is a momentary suggestion, not a
              reservation. Nothing was saved unless you choose Save panel and time; no times were
              published to the candidate and no invitation was sent. Showing up to 40 times.
            </p>
            {note && <p className="text-xs">{note}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
