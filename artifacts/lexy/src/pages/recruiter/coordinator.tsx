/**
 * pages/recruiter/coordinator.tsx — Interview Scheduling Coordinator
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Calendar and scheduling dashboard for coordinating AI and human interviews.
 * Shows the recruiter's upcoming interview schedule, pending invites, and
 * allows them to bulk-send interview invitations or reschedule sessions.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   Schedule Overview     — weekly / monthly calendar view of interview sessions
 *   Pending Invites       — candidates who have been sent an invite but haven't
 *                           opened/accepted it yet (with "Resend" action)
 *   Completed Today       — sessions completed today with quick access to reports
 *   Bulk Send Panel       — select multiple candidates → send interview invites
 *                           in bulk (POST /api/interviews/bulk-invite)
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/interviews?status=pending  — pending invites
 *   GET /api/interviews?status=completed&date=today — today's completions
 *   POST /api/interviews/bulk-invite    — bulk invite
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /coordinator (also /recruiter/coordinator)
 */
import { useEffect, useRef, useState } from "react";
import { useSearch } from "wouter";
import { pluralize } from "@/lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { apiBase, apiFetch as authenticatedFetch } from "@/lib/api";
import { saveScheduleDraft, type ScheduleSaveState } from "@/lib/schedule-save";
import type { ScheduleCreateResult } from "@workspace/api-client-react";
import { readNativeSchedules, readUpdatedSchedule, requireScheduleVersion, type ScheduleEditRecord } from "@/lib/schedule-edit";
import { canReschedule } from "@/lib/schedule-reschedule";
import { hasScheduleApplication, parseScheduleApplications } from "@/lib/schedule-applications";
import { OfferedTimesDialog } from "@/components/scheduling/OfferedTimesDialog";
import { canOfferTimes } from "@/lib/offered-times";
import { COORDINATOR_REFRESH_INTERVAL, nativeScheduleStatusLabel } from "@/lib/native-schedule-status";
import { formatInterviewInstant, interviewTimeOffset } from "@/lib/interview-time-display";
import { RescheduleScheduleDialog } from "@/components/scheduling/RescheduleScheduleDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Calendar, Clock, Video, User, Check, X, MoreHorizontal, Plus, Loader2, MapPin, Briefcase,
} from "lucide-react";
import { format, parseISO, isToday, isTomorrow } from "date-fns";
import { useToast } from "@workspace/react-hooks/use-toast";
import { OutlookAvailabilityCard, OutlookScheduleControls } from "@/components/OutlookCalendar";
import { GooglePanelTimeFinder } from "@/components/scheduling/GooglePanelTimeFinder";
import { PanelTimeFinder } from "@/components/scheduling/PanelTimeFinder";
import { OutlookCandidateInvitation } from "@/components/scheduling/OutlookCandidateInvitation";
import { GoogleInterviewInvitation } from "@/components/scheduling/GoogleInterviewInvitation";
import { GoogleInvitationOperation } from "@/components/scheduling/GoogleInvitationOperation";
import { StaffZoomLink } from "@/components/scheduling/StaffZoomLink";
import { StaffNativeZoom } from "@/components/scheduling/StaffNativeZoom";
import { OutlookPanelInvitation } from "@/components/scheduling/OutlookPanelInvitation";
import { TimeChangeRequest } from "@/components/scheduling/TimeChangeRequest";
import { availableInterviewSlots, localScheduleFields, scheduleDraftInstant, type InterviewSlot } from "@/lib/calendar-slots";

const BASE = apiBase;

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await authenticatedFetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(
      [400, 403, 404, 409].includes(res.status) && body && typeof body.error === "string"
        ? body.error
        : "The server did not confirm this request.",
    ), { status: res.status });
  }
  return res.json();
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function groupByDate(schedules: any[]) {
  const groups: Record<string, any[]> = {};
  schedules.forEach((s) => {
    const dateKey = s.scheduledAt ? format(parseISO(s.scheduledAt), "yyyy-MM-dd") : "unknown";
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(s);
  });
  return groups;
}

function getDayLabel(dateStr: string) {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return "Today";
    if (isTomorrow(date)) return "Tomorrow";
    return format(date, "EEEE, MMMM d");
  } catch {
    return dateStr;
  }
}

const STATUS_COLORS: Record<string, string> = {
  pending:     "bg-yellow-100 text-yellow-700 border-yellow-200",
  scheduled:   "bg-blue-100 text-blue-700 border-blue-200",
  confirmed:   "bg-green-100 text-green-700 border-green-200",
  rescheduled: "bg-orange-100 text-orange-700 border-orange-200",
  cancelled:   "bg-red-100 text-red-700 border-red-200",
  completed:   "bg-slate-100 text-slate-600 border-slate-200",
};

const INTERVIEW_TYPES = [
  { value: "technical",    label: "Technical" },
  { value: "behavioral",   label: "Behavioral" },
  { value: "culture_fit",  label: "Culture Fit" },
  { value: "portfolio",    label: "Portfolio Review" },
  { value: "ai_interview", label: "AI Screening" },
  { value: "final",        label: "Final Round" },
];

const DURATIONS = [
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1.5 hours" },
  { value: 120, label: "2 hours" },
];

/* ── Schedule Interview Dialog ────────────────────────────────────────────── */

interface ScheduleForm {
  applicationId: string;
  interviewType: string;
  date: string;
  time: string;
  durationMinutes: number;
  interviewerName: string;
  location: string;
  notes: string;
}

const EMPTY_FORM: ScheduleForm = {
  applicationId: "",
  interviewType: "technical",
  date: "",
  time: "",
  durationMinutes: 60,
  interviewerName: "",
  location: "",
  notes: "",
};

function ScheduleDialog({ open, onClose, onCreated, initialSlot }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  initialSlot: (InterviewSlot & { bufferMinutes: number }) | null;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ScheduleForm>(() => initialSlot
    ? { ...EMPTY_FORM, ...localScheduleFields(initialSlot.start), durationMinutes: initialSlot.durationMinutes }
    : EMPTY_FORM);
  const [search, setSearch] = useState("");
  const saveState = useRef<ScheduleSaveState | null>(null);

  const { data: applications = [], isLoading: appsLoading, isError: appsError, isFetching: appsFetching, refetch: reloadApplications } = useQuery({
    queryKey: ["applications-for-schedule"],
    queryFn: async ({ signal }) => parseScheduleApplications(await apiFetch<unknown>("/applications", { signal })),
    enabled: open,
  });

  const filteredApps = applications.filter((app) => {
    if (!app.candidate || !app.job) return false;
    const name = app.candidate?.name ?? "";
    const title = app.job?.title ?? "";
    const q = search.toLowerCase();
    return name.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  });

  const mutation = useMutation({
    retry: false,
    mutationFn: async (data: ScheduleForm) => {
      if (appsError || appsLoading || !hasScheduleApplication(applications, data.applicationId))
        throw new Error("Reload candidates and select an available candidate and role before saving.");
      const scheduledAt = scheduleDraftInstant(data.date, data.time, initialSlot?.start);
      saveState.current ??= { requestId: crypto.randomUUID(), attemptedPayload: null };
      return saveScheduleDraft(saveState.current, {
        applicationId: data.applicationId,
        interviewerName: data.interviewerName || null,
        location: data.location || null,
        scheduledAt,
        durationMinutes: data.durationMinutes,
        type: data.interviewType,
        notes: data.notes || null,
      }, {
        find: async (requestId) => {
          try {
            return await apiFetch<ScheduleCreateResult>(`/coordinator/schedules/requests/${requestId}`);
          } catch (error) {
            if (error instanceof Error && "status" in error && error.status === 404) return null;
            throw error;
          }
        },
        preflight: async () => {
          const local = localScheduleFields(scheduledAt);
          if (local.date !== data.date || local.time !== data.time || Date.parse(scheduledAt) <= Date.now())
            throw new Error("Choose a valid future interview time.");
          if (!initialSlot) return;
        const end = new Date(Date.parse(scheduledAt) + data.durationMinutes * 60_000).toISOString();
        const buffer = initialSlot.bufferMinutes * 60_000;
        const checked = await apiFetch<unknown>(`/outlook-calendar/availability?${new URLSearchParams({
          start: new Date(Date.parse(scheduledAt) - buffer).toISOString(),
          end: new Date(Date.parse(end) + buffer).toISOString(),
        })}`);
        const slots = availableInterviewSlots(checked, {
          start: scheduledAt, end, durationMinutes: data.durationMinutes,
          bufferMinutes: initialSlot.bufferMinutes, now: Date.now(),
        });
        if (!slots.length) throw new Error("Your Outlook availability changed or the time is too soon. Choose another time.");
        },
        create: (body) => apiFetch<ScheduleCreateResult>("/coordinator/schedules", {
        method: "POST",
          body: JSON.stringify(body),
        }),
      });
    },
    onSuccess: (result) => {
      toast({
        title: result.replayed ? "Existing schedule recovered" : "Interview scheduled in Lexy",
        description: result.replayed
          ? `The existing ${result.status} schedule was recovered; no second interview, Outlook hold or candidate invitation was created.`
          : "No Outlook hold or candidate invitation was created. Use the schedule’s Outlook controls to add a personal hold.",
      });
      setForm(EMPTY_FORM);
      setSearch("");
      onCreated();
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Schedule not confirmed", description: `${err.message ?? "The request failed."} Refresh the schedule list before retrying a save.`, variant: "destructive" });
    },
  });

  function field(key: keyof ScheduleForm, val: any) {
    setForm(f => ({ ...f, [key]: val }));
  }

  const canSubmit = !appsError && !appsLoading && hasScheduleApplication(applications, form.applicationId) && form.interviewType && form.date && form.time;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !mutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            Schedule Interview
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">

          {/* Application / Candidate picker */}
          <div className="space-y-2">
            <Label>Candidate & Role <span className="text-destructive">*</span></Label>
            <Input
              placeholder="Search candidate or job title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-1"
            />
            {appsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading candidates…
              </div>
            ) : appsError ? (
              <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
                <p>Could not load candidates and roles. Your draft has been kept; reload the list before saving.</p>
                <Button type="button" variant="outline" size="sm" disabled={appsFetching} onClick={() => void reloadApplications()}>
                  {appsFetching ? "Reloading…" : "Reload candidates"}
                </Button>
              </div>
            ) : (
              <div className="border rounded-lg divide-y divide-border max-h-48 overflow-y-auto">
                {filteredApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No applications found</p>
                ) : filteredApps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => { field("applicationId", app.id); setSearch(app.candidate?.name ?? ""); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/60 transition-colors ${form.applicationId === app.id ? "bg-primary/8 border-l-2 border-primary" : ""}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold shrink-0">
                      {(app.candidate?.name || "?").charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{app.candidate?.name ?? "Unknown"}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Briefcase className="w-3 h-3 inline" /> {app.job?.title ?? "Open Role"}
                        <Badge variant="outline" className="ml-1 text-[9px] py-0">{app.stage}</Badge>
                      </p>
                    </div>
                    {form.applicationId === app.id && <Check className="w-4 h-4 text-primary shrink-0" />}
                  </button>
                ))}
              </div>
            )}
            {!appsLoading && !appsError && form.applicationId && !hasScheduleApplication(applications, form.applicationId) && (
              <p role="alert" className="text-sm text-destructive">The selected candidate and role are no longer available. Select another before saving.</p>
            )}
          </div>

          {/* Interview type */}
          <div className="space-y-2">
            <Label>Interview Type <span className="text-destructive">*</span></Label>
            <Select value={form.interviewType} onValueChange={(v) => field("interviewType", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVIEW_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date + Time */}
          {initialSlot && <p className="text-sm text-muted-foreground">
            Draft from your Outlook availability. Your calendar is checked again when saving.
            This does not check other interviewers or create an Outlook hold.
          </p>}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Date <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={form.date}
                min={localScheduleFields(new Date().toISOString()).date}
                onChange={(e) => field("date", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Time <span className="text-destructive">*</span></Label>
              <Input
                type="time"
                value={form.time}
                onChange={(e) => field("time", e.target.value)}
              />
            </div>
          </div>

          {/* Duration */}
          <div className="space-y-2">
            <Label>Duration</Label>
            <Select value={String(form.durationMinutes)} onValueChange={(v) => field("durationMinutes", Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map(d => (
                  <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Interviewer */}
          <div className="space-y-2">
            <Label>Interviewer Name</Label>
            <Input
              placeholder="e.g. Alex Rivera"
              value={form.interviewerName}
              onChange={(e) => field("interviewerName", e.target.value)}
            />
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label>Location / Meeting Link</Label>
            <Input
              placeholder="e.g. Zoom, Google Meet, or room number"
              value={form.location}
              onChange={(e) => field("location", e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              placeholder="Any preparation notes or special instructions..."
              rows={2}
              value={form.notes}
              onChange={(e) => field("notes", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate(form)}
            disabled={!canSubmit || mutation.isPending}
            className="gap-2"
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
            Schedule Interview
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Confirm / Cancel actions ─────────────────────────────────────────────── */

function ScheduleActions({ schedule, onSaved, onUpdate, onReschedule }: {
  schedule: ScheduleEditRecord;
  onSaved: (saved: ScheduleEditRecord) => Promise<void>;
  onUpdate: () => void;
  onReschedule: () => void;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  async function patch(status: string) {
    if (pending) return;
    setPending(true);
    try {
      const saved = await readUpdatedSchedule(await authenticatedFetch(`${BASE}/coordinator/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, expectedVersion: requireScheduleVersion(schedule) }),
      }), schedule.id);
      if (saved.applicationId !== schedule.applicationId || saved.status !== status)
        throw new Error("The requested schedule status was not confirmed. Review the latest saved details.");
      await onSaved(saved);
      toast({
        title: status === "confirmed" ? "Schedule confirmed in Lexy" : "Schedule cancelled in Lexy",
        description: "No candidate invitation or Outlook event was changed.",
      });
    } catch (error) {
      onUpdate();
      toast({ title: "Action not confirmed", description: error instanceof Error ? error.message : "Review the latest schedule before retrying.", variant: "destructive" });
    } finally { setPending(false); }
  }

  if (canReschedule(schedule)) {
    return (
      <>
        <Button size="sm" variant="outline" disabled={pending} onClick={onReschedule}>Reschedule in Lexy</Button>
        {schedule.status !== "confirmed" && <Button size="sm" variant="outline" disabled={pending} onClick={() => patch("confirmed")} className="gap-1 text-green-600 border-green-200 hover:bg-green-50">
          <Check className="w-3.5 h-3.5" /> Confirm
        </Button>}
        <Button size="sm" variant="outline" disabled={pending} onClick={() => patch("cancelled")} className="gap-1 text-red-500 border-red-200 hover:bg-red-50">
          <X className="w-3.5 h-3.5" /> Cancel in Lexy
        </Button>
      </>
    );
  }
  return null;
}

/* ── Main page ────────────────────────────────────────────────────────────── */

export default function Coordinator() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [initialSlot, setInitialSlot] = useState<(InterviewSlot & { bufferMinutes: number }) | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleEditRecord | null>(null);
  const [suggestedStart, setSuggestedStart] = useState<string | null>(null);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  function openSchedule(slot: (InterviewSlot & { bufferMinutes: number }) | null = null) {
    setInitialSlot(slot);
    setDraftKey((key) => key + 1);
    setDialogOpen(true);
  }

  const { data: schedules = [], isLoading, isError, isFetching, dataUpdatedAt, refetch } = useQuery<ScheduleEditRecord[]>({
    queryKey: ["coordinator-schedules"],
    queryFn: async ({ signal }) => readNativeSchedules(await authenticatedFetch(`${BASE}/coordinator/schedules`, { signal })),
    refetchInterval: COORDINATOR_REFRESH_INTERVAL,
    refetchOnWindowFocus: "always",
    refetchOnMount: "always",
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["coordinator-schedules"] });
  }

  async function recordSaved(saved: ScheduleEditRecord) {
    // Abort older polling responses before installing the authoritative receipt.
    await queryClient.cancelQueries({ queryKey: ["coordinator-schedules"] });
    queryClient.setQueryData<ScheduleEditRecord[]>(["coordinator-schedules"], (rows) =>
      rows?.map((row) => row.id === saved.id ? { ...row, ...saved } : row));
    refresh();
  }

  const grouped = groupByDate(schedules);
  const sortedDates = Object.keys(grouped).sort();
  const requestedSchedule = new URLSearchParams(useSearch()).get("schedule");
  const targetVisible = schedules.some((schedule) => schedule.id === requestedSchedule);
  useEffect(() => {
    if (!requestedSchedule || !targetVisible || isLoading || isError) return;
    const element = document.getElementById(`schedule-${requestedSchedule}`);
    element?.scrollIntoView({ block: "center" });
    element?.focus({ preventScroll: true });
  }, [requestedSchedule, targetVisible, isLoading, isError]);

  const pending  = schedules.filter((s) => ["pending", "scheduled", "rescheduled"].includes(s.status)).length;
  const confirmed = schedules.filter((s) => s.status === "confirmed").length;

  return (
    <AppLayout>
      {requestedSchedule && !isLoading && !isError && !targetVisible && (
        <p role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
          This interview is no longer available in your current schedule view. Reload or ask your administrator to check its assignment.
        </p>
      )}
      <ScheduleDialog key={draftKey} initialSlot={initialSlot} open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} />
      {editingSchedule && <RescheduleScheduleDialog key={`${editingSchedule.id}:${suggestedStart ?? ""}`} schedule={editingSchedule} suggestedStart={suggestedStart}
        onSaved={recordSaved} onClose={() => { setEditingSchedule(null); setSuggestedStart(null); }} />}

      {offeringId && <OfferedTimesDialog key={offeringId} scheduleId={offeringId} onClose={() => setOfferingId(null)} onPublished={refresh} />}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title">Interview Coordinator</h1>
          <p className="text-muted-foreground mt-1">Manage interview records in Lexy. Calendar reservations and invitations are managed separately.</p>
          <p className="text-xs text-muted-foreground mt-2" role="status" aria-live="polite">
            {isFetching
              ? "Refreshing schedule…"
              : isError
                ? "Schedule refresh failed. Reload before relying on these details."
                : dataUpdatedAt > 0
                  ? `Last checked ${format(new Date(dataUpdatedAt), "PP p")}.`
                  : "Schedule not loaded yet."}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Refreshes about every 30 seconds while this page is visible. Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={isFetching} onClick={() => void refetch()} className="gap-2">
            {isFetching && <Loader2 className="w-4 h-4 animate-spin" />}
            {isFetching ? "Refreshing…" : "Refresh schedule"}
          </Button>
          <Button onClick={() => openSchedule()} className="gap-2">
            <Plus className="w-4 h-4" /> Schedule Interview
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card className="hover-elevate">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-blue-100 text-blue-700 rounded-xl">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Scheduled</p>
              <p className="text-2xl font-bold">{isLoading || isError ? "—" : schedules.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-green-100 text-green-700 rounded-xl">
              <Check className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Confirmed in Lexy</p>
              <p className="text-2xl font-bold">{isLoading || isError ? "—" : confirmed}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-yellow-100 text-yellow-700 rounded-xl">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Awaiting Confirmation</p>
              <p className="text-2xl font-bold">{isLoading || isError ? "—" : pending}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <OutlookAvailabilityCard onChooseSlot={openSchedule} />

      {/* Schedule list */}
      {isError ? (
        <Card><CardContent className="p-6 space-y-3" role="alert">
          <p>The schedule list could not be loaded. This does not mean there are no interviews.</p>
          <Button variant="outline" onClick={() => void refetch()}>Reload schedule</Button>
        </CardContent></Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading schedule…
        </div>
      ) : sortedDates.length === 0 ? (
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="p-4 bg-muted rounded-2xl">
              <Calendar className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-lg">No interviews scheduled yet</p>
              <p className="text-muted-foreground text-sm mt-1">Click "Schedule Interview" to add the first one.</p>
            </div>
            <Button onClick={() => openSchedule(null)} className="gap-2 mt-2">
              <Plus className="w-4 h-4" /> Schedule Interview
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {sortedDates.map((dateStr) => (
            <div key={dateStr}>
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                  {getDayLabel(dateStr)}
                </h2>
                <div className="flex-1 h-px bg-border" />
                <Badge variant="outline">{pluralize(grouped[dateStr].length, "interview")}</Badge>
              </div>
              <div className="space-y-3">
                {grouped[dateStr].map((schedule: any) => (
                  <Card key={schedule.id} id={`schedule-${schedule.id}`} tabIndex={-1}
                    className={`hover-elevate border-border/60 group ${schedule.id === requestedSchedule ? "ring-2 ring-primary" : ""}`}>
                    <CardContent className="p-5">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-4 min-w-0">
                          {/* Time block */}
                          <div title={formatInterviewInstant(schedule.scheduledAt)} className="hidden md:flex flex-col items-center justify-center w-20 h-20 rounded-xl bg-muted/60 text-center shrink-0">
                            <Clock className="w-4 h-4 text-muted-foreground mb-1" />
                            <p className="text-sm font-bold">
                              {schedule.scheduledAt ? format(parseISO(schedule.scheduledAt), "HH:mm") : "TBD"}
                            </p>
                            <p className="text-[10px] text-muted-foreground">{schedule.durationMinutes ?? 60}m</p>
                            <p className="text-[10px] text-muted-foreground">{interviewTimeOffset(schedule.scheduledAt)}</p>
                          </div>

                          {/* Avatar */}
                          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold shrink-0">
                            {(schedule.candidateName || "?").charAt(0)}
                          </div>

                          {/* Info */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold">{schedule.candidateName || "Unknown Candidate"}</p>
                              <Badge className={`text-[10px] border ${STATUS_COLORS[schedule.status] ?? STATUS_COLORS.scheduled}`}>
                                {nativeScheduleStatusLabel(schedule.status)}
                              </Badge>
                            </div>
                            {schedule.status === "confirmed" && (
                              <p className="text-xs text-muted-foreground mt-1">
                                This status does not verify an Outlook reservation or invitation.
                              </p>
                            )}
                            <p className="text-sm text-muted-foreground">
                              {schedule.jobTitle || "Open Role"} &bull; {schedule.type?.replace(/_/g, " ")}
                            </p>
                            <div className="flex items-center flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1 md:hidden">
                                <Clock className="w-3 h-3" />
                                {format(parseISO(schedule.scheduledAt), "p")} {interviewTimeOffset(schedule.scheduledAt)} · {schedule.durationMinutes}m
                              </span>
                              {schedule.interviewerName && (
                                <span className="flex items-center gap-1">
                                  <User className="w-3 h-3" /> {schedule.interviewerName}
                                </span>
                              )}
                              {schedule.location && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3" /> {schedule.location}
                                </span>
                              )}
                              {!schedule.interviewerName && !schedule.location && (
                                <span className="text-muted-foreground/50 italic">No interviewer or location set</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto min-w-0 max-w-full">
                          <OutlookScheduleControls schedule={schedule} onUpdate={refresh} />
                          <OutlookCandidateInvitation schedule={schedule} />
                          <OutlookPanelInvitation schedule={schedule} />
                          {schedule.type !== "ai_interview" && <GoogleInterviewInvitation schedule={schedule} />}
                          {schedule.type !== "ai_interview" && <GoogleInvitationOperation schedule={schedule} />}
                          {schedule.type !== "ai_interview" && <StaffZoomLink schedule={schedule} />}
                          {schedule.type !== "ai_interview" && <StaffNativeZoom schedule={schedule} />}
                          <TimeChangeRequest staff scheduleId={schedule.id} />
                          <ScheduleActions schedule={schedule} onUpdate={refresh} onSaved={recordSaved}
                            onReschedule={() => { setSuggestedStart(null); setEditingSchedule({ ...schedule }); }} />
                          {canOfferTimes(schedule) && <Button size="sm" variant="outline" onClick={() => setOfferingId(schedule.id)}>Offer times</Button>}
                          <Button size="icon" variant="ghost" aria-label="More actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3"><PanelTimeFinder schedule={schedule} /><GooglePanelTimeFinder schedule={schedule} /></div>
                      {schedule.notes && (
                        <p className="mt-3 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2 border border-border/40">
                          {schedule.notes}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
