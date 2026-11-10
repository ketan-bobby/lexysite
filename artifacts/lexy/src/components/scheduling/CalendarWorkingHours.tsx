import { useEffect, useMemo, useRef, useState } from "react";
import {
  getGetCalendarWorkingHoursQueryKey,
  useGetCalendarWorkingHours,
  useSaveCalendarWorkingHours,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

type Win = { day: number; start: string; end: string };
type Stored = { version: string | null; timeZone: string | null; windows: Win[] };
type Interval = { start: string; end: string };
type Draft = {
  baseVersion: string | null;
  mode: "default" | "custom";
  zone: string;
  days: Interval[][];
  confirm: boolean;
  touched: boolean;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const START_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const END_RE = /^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function zoneValid(z: string) {
  if (!z || z.length > 100 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(z)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function parseStored(raw: unknown): Stored | null {
  const r = raw as Partial<Stored> | null;
  if (!r || typeof r !== "object") return null;
  if (
    r.version !== null &&
    (typeof r.version !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.version))
  )
    return null;
  if (r.timeZone !== null && typeof r.timeZone !== "string") return null;
  if (!Array.isArray(r.windows) || r.windows.length > 14) return null;
  for (const w of r.windows) {
    if (
      !w ||
      !Number.isInteger(w.day) ||
      w.day < 0 ||
      w.day > 6 ||
      !START_RE.test(w.start) ||
      !END_RE.test(w.end)
    )
      return null;
    if (mins(w.start) >= mins(w.end)) return null;
  }
  if (r.timeZone === null && r.windows.length > 0) return null;
  if (r.version === null && r.timeZone !== null) return null;
  if (r.timeZone !== null && !zoneValid(r.timeZone as string)) return null;
  const sorted = sortWins(r.windows);
  if (
    sorted.some(
      (w, i) => i > 0 && sorted[i - 1].day === w.day && mins(sorted[i - 1].end) > mins(w.start),
    )
  )
    return null;
  return {
    version: r.version as string | null,
    timeZone: r.timeZone as string | null,
    windows: r.windows,
  };
}

const sortWins = (w: Win[]) =>
  [...w].sort((a, b) => a.day - b.day || mins(a.start) - mins(b.start));
const key = (zone: string | null, w: Win[]) =>
  JSON.stringify([zone, sortWins(w).map((x) => [x.day, x.start, x.end])]);

function toDays(windows: Win[]): Interval[][] {
  const d: Interval[][] = [[], [], [], [], [], [], []];
  for (const w of sortWins(windows)) d[w.day].push({ start: w.start, end: w.end });
  return d;
}

function draftFrom(s: Stored): Draft {
  return {
    baseVersion: s.version,
    mode: s.timeZone === null ? "default" : "custom",
    zone: s.timeZone ?? "",
    days: toDays(s.windows),
    confirm: false,
    touched: false,
  };
}

function draftWindows(d: Draft): Win[] {
  return d.days.flatMap((list, day) => list.map((i) => ({ day, start: i.start, end: i.end })));
}

function validate(d: Draft): string[] {
  const errs: string[] = [];
  if (d.mode === "default") return errs;
  if (!zoneValid(d.zone.trim()))
    errs.push("Enter a valid IANA time zone, for example Europe/London.");
  if (draftWindows(d).length > 14) errs.push("At most 14 intervals are allowed in total.");
  d.days.forEach((list, day) => {
    const s = [...list].sort((a, b) => mins(a.start) - mins(b.start));
    s.forEach((i, n) => {
      if (mins(i.start) >= mins(i.end))
        errs.push(`${DAYS[day]}: an interval must end after it starts.`);
      else if (
        n > 0 &&
        mins(s[n - 1].end) > mins(i.start) &&
        mins(s[n - 1].start) < mins(s[n - 1].end)
      )
        errs.push(`${DAYS[day]}: intervals overlap.`);
    });
  });
  return errs;
}

function timeOptions(kind: "start" | "end", current: string) {
  const out: string[] = [];
  for (let m = 0; m <= (kind === "end" ? 1440 : 1425); m += 15) {
    out.push(
      m === 1440
        ? "24:00"
        : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
    );
  }
  if (current && !out.includes(current)) {
    out.push(current);
    out.sort();
  }
  return out;
}

function summary(s: Stored) {
  if (s.timeZone === null) return "No custom hours. Only your calendar is checked.";
  if (s.windows.length === 0)
    return `Closed all week (${s.timeZone}). You will not be suggested for any panel time.`;
  const d = toDays(s.windows);
  return (
    d
      .map((l, i) =>
        l.length
          ? `${DAYS[i].slice(0, 3)} ${l.map((x) => `${x.start}-${x.end}`).join(", ")}`
          : null,
      )
      .filter(Boolean)
      .join("; ") + ` (${s.timeZone})`
  );
}

export function CalendarWorkingHours() {
  const { user } = useAuth();
  return user ? <Inner key={user.id} userId={user.id} /> : null;
}

function Inner({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const qk = [...getGetCalendarWorkingHoursQueryKey(), userId];
  const query = useGetCalendarWorkingHours({
    query: {
      queryKey: qk,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchInterval: 120_000,
      retry: false,
    },
  });
  const save = useSaveCalendarWorkingHours({ mutation: { retry: false } });
  const lock = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [reloading, setReloading] = useState(false);

  const stored = useMemo(
    () => (query.data === undefined ? null : parseStored(query.data)),
    [query.data],
  );
  const readFailed = query.isError || (query.data !== undefined && !stored);

  useEffect(() => {
    if (!stored) return;
    setDraft((d) =>
      !d || (!d.touched && d.baseVersion !== stored.version) ? draftFrom(stored) : d,
    );
  }, [stored]);

  const stale = !!(stored && draft && draft.touched && draft.baseVersion !== stored.version);
  const errs = draft ? validate(draft) : [];
  const closing = !!draft && draft.mode === "custom" && draftWindows(draft).length === 0;
  const clearing = !!draft && draft.mode === "default" && !!stored && stored.timeZone !== null;
  const needsConfirm = closing || clearing;
  const locked = pending || recovery || stale || readFailed || query.isFetching || reloading;

  function edit(fn: (d: Draft) => Draft) {
    setDraft((d) => (d ? { ...fn(d), touched: true, confirm: false } : d));
  }

  async function reload() {
    setReloading(true);
    try {
      const r = await query.refetch();
      const s = r.data === undefined ? null : parseStored(r.data);
      if (r.isError || !s) {
        setError("Saved hours could not be reloaded. Nothing was changed and nothing was retried.");
      } else {
        setDraft(draftFrom(s));
        setRecovery(false);
        setError(null);
      }
    } finally {
      setReloading(false);
    }
  }

  async function submit() {
    if (
      lock.current ||
      !draft ||
      !stored ||
      locked ||
      errs.length ||
      (needsConfirm && !draft.confirm)
    )
      return;
    lock.current = true;
    setPending(true);
    setError(null);
    const timeZone = draft.mode === "default" ? null : draft.zone.trim();
    const windows = draft.mode === "default" ? [] : sortWins(draftWindows(draft));
    try {
      const res = await save.mutateAsync({
        data: { expectedVersion: stored.version, timeZone, windows },
      });
      const got = parseStored(res);
      if (
        !got ||
        got.version === null ||
        got.version === stored.version ||
        key(got.timeZone, got.windows) !== key(timeZone, windows)
      ) {
        throw new Error("unconfirmed");
      }
      await qc.cancelQueries({ queryKey: qk });
      qc.setQueryData(qk, got);
      setDraft(draftFrom(got));
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 409) {
        setRecovery(true);
        setError(
          "Your hours were changed elsewhere, so this save was rejected. Reload the saved hours to continue. Your draft is kept until you reload.",
        );
      } else if (status === 400 || status === 422) {
        const m = (e as { data?: { error?: unknown } })?.data?.error;
        setError(
          `${typeof m === "string" ? m : "The hours were not accepted."} Nothing was saved; your draft is kept.`,
        );
      } else {
        setRecovery(true);
        setError(
          "Lexy could not confirm whether this was saved. Reload the saved hours to check. Nothing was retried automatically.",
        );
      }
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "";
    }
  }, []);
  const zones = useMemo(() => {
    try {
      return (
        (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
          "timeZone",
        ) ?? []
      );
    } catch {
      return [];
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-4 h-4 text-primary" /> Panel working hours
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Optional and private to you. When set, a suggested panel time is only offered if the whole
          meeting plus buffers fits inside these hours in your time zone, daylight saving included.
          Without them, only your calendar is checked. These hours do not publish times, opt you in,
          reserve your calendar, move appointments or send invitations, and candidates never see
          them. Saved panels are rechecked against your latest hours when saved or confirmed.
        </p>

        {readFailed ? (
          <div role="alert" className="text-sm text-destructive space-y-2">
            <p>
              Your working hours could not be loaded. This does not mean no hours are set, and
              editing is disabled.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
              data-testid="button-hours-reload-failed"
            >
              Reload hours
            </Button>
          </div>
        ) : !stored || !draft ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border p-3 space-y-1" data-testid="text-hours-saved">
              <Badge variant="outline">
                {stored.timeZone === null
                  ? "Not configured"
                  : stored.windows.length
                    ? "Custom hours"
                    : "Closed all week"}
              </Badge>
              <p className="text-sm">{summary(stored)}</p>
            </div>

            {(stale || recovery) && (
              <div
                role="alert"
                className="text-sm text-amber-300 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
              >
                <p>
                  {stale
                    ? "Saved hours changed in another session. Reload before editing; your unsaved draft will be discarded."
                    : "Editing is paused until you reload the saved hours."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reloading}
                  onClick={() => void reload()}
                  data-testid="button-hours-reload"
                >
                  {reloading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />} Reload saved
                  hours
                </Button>
              </div>
            )}

            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              aria-busy={pending}
            >
              <fieldset disabled={locked} className="space-y-4 min-w-0">
                <legend className="text-sm font-medium mb-2">Edit hours</legend>
                <div className="flex gap-4 flex-wrap text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="hours-mode"
                      checked={draft.mode === "default"}
                      onChange={() => edit((d) => ({ ...d, mode: "default" }))}
                      data-testid="radio-hours-default"
                    />
                    No custom hours (calendar only)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="hours-mode"
                      checked={draft.mode === "custom"}
                      onChange={() =>
                        edit((d) => ({ ...d, mode: "custom", zone: d.zone || browserZone }))
                      }
                      data-testid="radio-hours-custom"
                    />
                    Set my own hours
                  </label>
                </div>

                {draft.mode === "custom" && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label htmlFor="hours-zone" className="text-sm font-medium">
                        Time zone
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        <input
                          id="hours-zone"
                          list="hours-zone-list"
                          value={draft.zone}
                          onChange={(e) => edit((d) => ({ ...d, zone: e.target.value }))}
                          aria-invalid={!zoneValid(draft.zone.trim())}
                          className="h-9 rounded-md border bg-background px-2 text-sm min-w-[14rem]"
                          data-testid="input-hours-zone"
                        />
                        <datalist id="hours-zone-list">
                          {zones.map((z) => (
                            <option key={z} value={z} />
                          ))}
                        </datalist>
                        {browserZone && browserZone !== draft.zone && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => edit((d) => ({ ...d, zone: browserZone }))}
                            data-testid="button-hours-browser-zone"
                          >
                            Use browser zone ({browserZone})
                          </Button>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      For an overnight shift, end the first day at 24:00 and start the next day at
                      00:00. Split shifts are allowed. A day with no intervals is off.
                    </p>
                    <ul className="space-y-2">
                      {DAYS.map((name, day) => {
                        const list = draft.days[day];
                        const setList = (fn: (l: Interval[]) => Interval[]) =>
                          edit((d) => ({
                            ...d,
                            days: d.days.map((l, i) => (i === day ? fn(l) : l)),
                          }));
                        return (
                          <li
                            key={name}
                            className="rounded-lg border p-2 space-y-2"
                            data-testid={`row-hours-day-${day}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">
                                {name}{" "}
                                {list.length === 0 && (
                                  <span className="text-xs text-muted-foreground font-normal">
                                    Off
                                  </span>
                                )}
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={locked || draftWindows(draft).length >= 14}
                                onClick={() =>
                                  setList((l) => [...l, { start: "09:00", end: "17:00" }])
                                }
                                aria-label={`Add interval on ${name}`}
                                data-testid={`button-hours-add-${day}`}
                              >
                                <Plus className="w-4 h-4 mr-1" /> Add
                              </Button>
                            </div>
                            {list.map((iv, n) => (
                              <div key={n} className="flex items-center gap-2 flex-wrap">
                                <select
                                  aria-label={`${name} interval ${n + 1} start`}
                                  value={iv.start}
                                  onChange={(e) =>
                                    setList((l) =>
                                      l.map((x, i) =>
                                        i === n ? { ...x, start: e.target.value } : x,
                                      ),
                                    )
                                  }
                                  className="h-8 rounded-md border bg-background px-1 text-sm"
                                  data-testid={`select-hours-start-${day}-${n}`}
                                >
                                  {timeOptions("start", iv.start).map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                                <span className="text-xs text-muted-foreground">to</span>
                                <select
                                  aria-label={`${name} interval ${n + 1} end`}
                                  value={iv.end}
                                  onChange={(e) =>
                                    setList((l) =>
                                      l.map((x, i) =>
                                        i === n ? { ...x, end: e.target.value } : x,
                                      ),
                                    )
                                  }
                                  className="h-8 rounded-md border bg-background px-1 text-sm"
                                  data-testid={`select-hours-end-${day}-${n}`}
                                >
                                  {timeOptions("end", iv.end).map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={locked}
                                  onClick={() => setList((l) => l.filter((_, i) => i !== n))}
                                  aria-label={`Remove ${name} interval ${n + 1}`}
                                  data-testid={`button-hours-remove-${day}-${n}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            ))}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {closing && (
                  <p
                    role="alert"
                    className="text-sm text-amber-300 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
                  >
                    No intervals are set. Saving marks you as closed all week, so you will not be
                    suggested for any panel time.
                  </p>
                )}
                {clearing && (
                  <p
                    role="alert"
                    className="text-sm text-amber-300 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
                  >
                    This removes your custom hours. Only your calendar will be checked. Your sharing
                    choice is not changed.
                  </p>
                )}
                {needsConfirm && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.confirm}
                      onChange={(e) =>
                        setDraft((d) => (d ? { ...d, confirm: e.target.checked } : d))
                      }
                      className="mt-1"
                      data-testid="checkbox-hours-confirm"
                    />
                    {closing
                      ? "I understand this blocks all my availability."
                      : "I understand my custom hours will be removed."}
                  </label>
                )}
              </fieldset>

              {errs.length > 0 && (
                <ul
                  role="alert"
                  className="text-sm text-destructive list-disc pl-5"
                  data-testid="text-hours-errors"
                >
                  {Array.from(new Set(errs)).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}

              <div className="flex gap-2 flex-wrap">
                <Button
                  type="submit"
                  size="sm"
                  data-testid="button-hours-save"
                  disabled={
                    locked || !draft.touched || errs.length > 0 || (needsConfirm && !draft.confirm)
                  }
                >
                  {pending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                  {pending ? "Saving…" : "Save working hours"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={locked || !draft.touched}
                  onClick={() => setDraft(draftFrom(stored))}
                  data-testid="button-hours-discard"
                >
                  Discard changes
                </Button>
              </div>
            </form>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid="text-hours-error">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
