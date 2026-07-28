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
 *   /recruiter/coordinator
 */
import { useState } from "react";
import { pluralize } from "@/lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { apiBase, authHeaders } from "@/lib/api";
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

const BASE = apiBase;

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
    credentials: "include",
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
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
  time: "10:00",
  durationMinutes: 60,
  interviewerName: "",
  location: "",
  notes: "",
};

function ScheduleDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [search, setSearch] = useState("");

  const { data: applications = [], isLoading: appsLoading } = useQuery<any[]>({
    queryKey: ["applications-for-schedule"],
    queryFn: () => apiFetch("/applications"),
    enabled: open,
  });

  const filteredApps = applications.filter((app) => {
    const name = app.candidate?.name ?? "";
    const title = app.job?.title ?? "";
    const q = search.toLowerCase();
    return name.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  });

  const mutation = useMutation({
    mutationFn: async (data: ScheduleForm) => {
      const scheduledAt = new Date(`${data.date}T${data.time}:00`).toISOString();
      return apiFetch("/coordinator/schedules", {
        method: "POST",
        body: JSON.stringify({
          applicationId: data.applicationId,
          interviewerName: data.interviewerName || null,
          location: data.location || null,
          scheduledAt,
          durationMinutes: data.durationMinutes,
          type: data.interviewType,
          notes: data.notes || null,
        }),
      });
    },
    onSuccess: () => {
      toast({ title: "Interview scheduled", description: "The interview has been added to the calendar." });
      setForm(EMPTY_FORM);
      setSearch("");
      onCreated();
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Failed to schedule", description: err.message ?? "Please try again.", variant: "destructive" });
    },
  });

  function field(key: keyof ScheduleForm, val: any) {
    setForm(f => ({ ...f, [key]: val }));
  }

  const canSubmit = form.applicationId && form.interviewType && form.date && form.time;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
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
            ) : (
              <div className="border rounded-lg divide-y divide-border max-h-48 overflow-y-auto">
                {filteredApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No applications found</p>
                ) : filteredApps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Date <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={form.date}
                min={new Date().toISOString().split("T")[0]}
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

function ScheduleActions({ schedule, onUpdate }: { schedule: any; onUpdate: () => void }) {
  const { toast } = useToast();

  async function patch(status: string) {
    try {
      await apiFetch(`/coordinator/schedules/${schedule.id}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      onUpdate();
      toast({ title: status === "confirmed" ? "Interview confirmed" : "Interview cancelled" });
    } catch {
      toast({ title: "Action failed", variant: "destructive" });
    }
  }

  if (schedule.status === "pending" || schedule.status === "scheduled") {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => patch("confirmed")} className="gap-1 text-green-600 border-green-200 hover:bg-green-50">
          <Check className="w-3.5 h-3.5" /> Confirm
        </Button>
        <Button size="sm" variant="outline" onClick={() => patch("cancelled")} className="gap-1 text-red-500 border-red-200 hover:bg-red-50">
          <X className="w-3.5 h-3.5" /> Cancel
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

  const { data: schedules = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["coordinator-schedules"],
    queryFn: () => apiFetch("/coordinator/schedules"),
    refetchInterval: 60_000,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["coordinator-schedules"] });
    refetch();
  }

  const grouped = groupByDate(schedules);
  const sortedDates = Object.keys(grouped).sort();

  const pending  = schedules.filter((s) => s.status === "pending" || s.status === "scheduled").length;
  const confirmed = schedules.filter((s) => s.status === "confirmed").length;

  return (
    <AppLayout>
      <ScheduleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} />

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title">Interview Coordinator</h1>
          <p className="text-muted-foreground mt-1">Manage and track all scheduled interviews.</p>
        </div>
        <div className="flex gap-3">
          <Button onClick={() => setDialogOpen(true)} className="gap-2">
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
              <p className="text-2xl font-bold">{schedules.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-green-100 text-green-700 rounded-xl">
              <Check className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Confirmed</p>
              <p className="text-2xl font-bold">{confirmed}</p>
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
              <p className="text-2xl font-bold">{pending}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Schedule list */}
      {isLoading ? (
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
            <Button onClick={() => setDialogOpen(true)} className="gap-2 mt-2">
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
                  <Card key={schedule.id} className="hover-elevate border-border/60 group">
                    <CardContent className="p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-4 min-w-0">
                          {/* Time block */}
                          <div className="hidden md:flex flex-col items-center justify-center w-20 h-16 rounded-xl bg-muted/60 text-center shrink-0">
                            <Clock className="w-4 h-4 text-muted-foreground mb-1" />
                            <p className="text-sm font-bold">
                              {schedule.scheduledAt ? format(parseISO(schedule.scheduledAt), "HH:mm") : "TBD"}
                            </p>
                            <p className="text-[10px] text-muted-foreground">{schedule.durationMinutes ?? 60}m</p>
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
                                {schedule.status}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {schedule.jobTitle || "Open Role"} &bull; {schedule.type?.replace(/_/g, " ")}
                            </p>
                            <div className="flex items-center flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
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
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <ScheduleActions schedule={schedule} onUpdate={refresh} />
                          <Button size="icon" variant="ghost" aria-label="More actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>

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
