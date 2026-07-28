/**
 * pages/recruiter/open-work-orders.tsx — Open Work Orders
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Agency-focused view of all open work orders (job placements the agency has
 * agreed to fill for clients). Each work order has a target headcount, a
 * deadline, a rate card, and a fulfillment progress bar.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   WorkOrderTable    — client name, role, headcount target, start date,
 *                       fill rate (placed / target), deadline indicator,
 *                       status (open / partial / filled / overdue)
 *   CreateModal       — new work order form: client, role, headcount, rate,
 *                       start date, notes
 *   FulfillmentPanel  — per work order: candidates in pipeline per stage,
 *                       placed candidates, remaining open slots
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/jobs?type=work_order         — work orders (jobs with type flag)
 *   POST /api/jobs                        — create new work order
 *   GET /api/analytics/work-order-health  — fulfillment stats
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/open-work-orders  (agency accounts)
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Briefcase, MapPin, Building2, Users, Send,
  Search, Loader2, Sparkles, CheckCircle2, ArrowRight,
  Radio, Star, Zap, Clock, AlertTriangle, RefreshCw,
} from "lucide-react";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn, pluralize } from "@/lib/utils";
import { Link } from "wouter";
import { apiFetch as sharedApiFetch } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Local JSON-returning convenience wrapper. Delegates to the shared
 * `apiFetch` in @/lib/api so cookie auth, the dev Bearer fallback, AND the
 * global 401 → session-end interceptor all apply. Note: the shared helper
 * merges caller headers OVER defaults, so Content-Type is preserved.
 * This page is behind ProtectedRoute — a 401 always means session expiry.
 */
async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await sharedApiFetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

const workTypeBadge: Record<string, string> = {
  remote:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  hybrid:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  onsite:  "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

const statusBadge: Record<string, string> = {
  active:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  paused:  "bg-amber-500/10 text-amber-400 border-amber-500/20",
  draft:   "bg-muted/50 text-muted-foreground border-border/40",
  closed:  "bg-red-500/10 text-red-400 border-red-500/20",
};

interface OpenJob {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  workType: string | null;
  employmentType: string | null;
  status: string;
  tenantId: string;
  tenantName: string | null;
  parentTenantId: string | null;
  parentTenantName: string | null;
  workOrderNumber: string | null;
  applicationCount: number;
  platformPushCount: number;
  platformRecommendationsEnabled: boolean;
  lastPushAt: string | null;
  updatedAt: string;
}

interface PlatformCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  currentTitle: string | null;
  location: string | null;
  experienceLevel: string | null;
}

interface PushState {
  job: OpenJob;
  candidateId: string;
  note: string;
}

/* ─── Push Modal ──────────────────────────────────────────────────────────── */
// Modal to attach a platform-pool candidate to a work order (with an optional note).
function PushModal({
  job,
  onClose,
}: {
  job: OpenJob;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [candidateId, setCandidateId] = useState("");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [pushed, setPushed] = useState(false);

  const { data: candidatesData, isLoading: candidatesLoading } = useQuery<{ candidates: PlatformCandidate[] }>({
    queryKey: ["platform-candidates-for-push"],
    queryFn: () => apiFetch("/candidates?pool=platform&limit=200"),
    staleTime: 30_000,
  });

  const candidates = candidatesData?.candidates ?? [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c =>
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      (c.currentTitle ?? "").toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q)
    );
  }, [candidates, search]);

  const selected = candidates.find(c => c.id === candidateId);

  const pushMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/candidates/${candidateId}/push-to-client`, {
        method: "POST",
        body: JSON.stringify({
          clientTenantId: job.tenantId,
          jobPostingId: job.id,
          note: note || undefined,
        }),
      }),
    onSuccess: () => {
      setPushed(true);
      qc.invalidateQueries({ queryKey: ["open-work-orders"] });
      toast({ title: "Candidate pushed", description: `${selected?.firstName} ${selected?.lastName} has been recommended to ${job.tenantName} for ${job.title}.` });
    },
    onError: (err: any) => {
      const msg = err.message ?? "Push failed";
      toast({ title: "Push failed", description: msg, variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-violet-400" />
            Push Platform Candidate
          </DialogTitle>
        </DialogHeader>

        {pushed ? (
          <div className="py-8 text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <p className="font-semibold text-foreground">Candidate Pushed!</p>
            <p className="text-sm text-muted-foreground">
              {selected?.firstName} {selected?.lastName} now appears in{" "}
              <span className="text-foreground font-medium">{job.tenantName}</span>'s candidate pool for{" "}
              <span className="text-foreground font-medium">{job.title}</span>.
            </p>
            <Button variant="outline" onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/30 border border-border/40 p-3 text-sm space-y-0.5">
              <p className="font-medium text-foreground">{job.title}</p>
              <p className="text-muted-foreground text-xs">
                {job.tenantName} {job.workOrderNumber ? `· ${job.workOrderNumber}` : ""} {job.location ? `· ${job.location}` : ""}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Select Platform Candidate</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8 h-8 text-sm"
                  placeholder="Search candidates…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>

              {candidatesLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1 rounded-md border border-border/40 bg-muted/20 p-1">
                  {filtered.length === 0 ? (
                    <p className="text-xs text-center text-muted-foreground py-4">No platform candidates found.</p>
                  ) : filtered.map(c => (
                    <button
                      key={c.id}
                      onClick={() => setCandidateId(c.id)}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-md transition-all text-sm flex items-center gap-3",
                        candidateId === c.id
                          ? "bg-violet-500/10 border border-violet-500/30 text-foreground"
                          : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Avatar className="w-7 h-7 shrink-0">
                        <AvatarFallback className="bg-gradient-to-br from-violet-600 to-primary text-white text-[10px] font-bold">
                          {`${c.firstName?.[0] ?? ""}${c.lastName?.[0] ?? ""}`}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{c.firstName} {c.lastName}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{c.currentTitle ?? "—"} {c.location ? `· ${c.location}` : ""}</p>
                      </div>
                      {candidateId === c.id && <CheckCircle2 className="w-3.5 h-3.5 text-violet-400 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Note for client <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                rows={2}
                className="text-sm resize-none"
                placeholder="e.g. Strong match for senior frontend role — 6 years React…"
                value={note}
                onChange={e => setNote(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pushMutation.isPending}>Cancel</Button>
              <Button
                disabled={!candidateId || pushMutation.isPending}
                onClick={() => pushMutation.mutate()}
                className="gap-1.5 bg-violet-600 hover:bg-violet-500 border-0"
              >
                {pushMutation.isPending
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pushing…</>
                  : <><Send className="w-3.5 h-3.5" /> Push to Client</>
                }
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ScanStatus {
  scanInProgress: boolean;
  lastScanResult: {
    runAt: string;
    jobsScanned: number;
    candidatesEvaluated: number;
    newPushes: number;
    skippedAlreadyPushed: number;
    errors: number;
    autoPaused: number;
    details: Array<{ jobId: string; jobTitle: string; pushed: number; evaluated: number; errors: number }>;
  } | null;
}

/* ─── Main Page ───────────────────────────────────────────────────────────── */
// Open Work Orders page: agency view of placements to fill, with fulfillment stats.
export default function OpenWorkOrders() {
  const [search, setSearch] = useState("");
  const [pushTarget, setPushTarget] = useState<OpenJob | null>(null);
  const [isRunningAiScan, setIsRunningAiScan] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery<{ jobs: OpenJob[] }>({
    queryKey: ["open-work-orders"],
    queryFn: () => apiFetch("/platform/open-work-orders"),
    staleTime: 30_000,
  });

  const { data: scanStatus, refetch: refetchScanStatus } = useQuery<ScanStatus>({
    queryKey: ["recommendation-scan-status"],
    queryFn: () => apiFetch("/platform/recommendation-scan-status"),
    staleTime: 10_000,
    refetchInterval: isRunningAiScan ? 3_000 : false,
  });

  const runAiScan = async () => {
    if (isRunningAiScan) return;
    setIsRunningAiScan(true);
    try {
      const result = await apiFetch<{ ok: boolean; result: ScanStatus["lastScanResult"] }>(
        "/platform/run-recommendation-scan",
        { method: "POST" },
      );
      await qc.invalidateQueries({ queryKey: ["open-work-orders"] });
      await refetchScanStatus();
      const r = result.result!;
      toast({
        title: r.newPushes > 0 ? `AI Scan Complete — ${pluralize(r.newPushes, "new match", "new matches")} pushed` : "AI Scan Complete — No new matches found",
        description: `Evaluated ${pluralize(r.candidatesEvaluated, "candidate")} across ${pluralize(r.jobsScanned, "work order")}.${r.errors > 0 ? ` ${pluralize(r.errors, "error")}.` : ""}`,
      });
    } catch (err: any) {
      const msg = err.message ?? "Scan failed";
      toast({ title: "Scan failed", description: msg, variant: "destructive" });
    } finally {
      setIsRunningAiScan(false);
    }
  };

  const resumeMutation = useMutation({
    mutationFn: (jobId: string) =>
      apiFetch(`/jobs/${jobId}/platform-recommendations`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["open-work-orders"] });
      toast({ title: "Work order resumed", description: "The AI scan will include this work order in future runs." });
    },
    onError: () => toast({ title: "Failed to resume", variant: "destructive" }),
  });

  const jobs = data?.jobs ?? [];
  const activeJobs = useMemo(() => jobs.filter(j => j.platformRecommendationsEnabled), [jobs]);
  const pausedJobs  = useMemo(() => jobs.filter(j => !j.platformRecommendationsEnabled), [jobs]);

  const filterJob = (j: OpenJob, q: string) =>
    j.title.toLowerCase().includes(q) ||
    (j.tenantName ?? "").toLowerCase().includes(q) ||
    (j.department ?? "").toLowerCase().includes(q) ||
    (j.location ?? "").toLowerCase().includes(q) ||
    (j.workOrderNumber ?? "").toLowerCase().includes(q);

  const filteredActive = useMemo(() => {
    const q = search.toLowerCase();
    return q ? activeJobs.filter(j => filterJob(j, q)) : activeJobs;
  }, [activeJobs, search]);

  const filteredPaused = useMemo(() => {
    const q = search.toLowerCase();
    return q ? pausedJobs.filter(j => filterJob(j, q)) : pausedJobs;
  }, [pausedJobs, search]);

  function groupByTenant(list: OpenJob[]) {
    const map = new Map<string, { tenantName: string; parentTenantName: string | null; jobs: OpenJob[] }>();
    for (const j of list) {
      const key = j.tenantId;
      if (!map.has(key)) map.set(key, { tenantName: j.tenantName ?? j.tenantId, parentTenantName: j.parentTenantName ?? null, jobs: [] });
      map.get(key)!.jobs.push(j);
    }
    return Array.from(map.values());
  }

  const byTenantActive = useMemo(() => groupByTenant(filteredActive), [filteredActive]);
  const byTenantPaused = useMemo(() => groupByTenant(filteredPaused), [filteredPaused]);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Radio className="w-4 h-4 text-violet-400" />
              <span className="text-[11px] font-black tracking-widest text-violet-400 uppercase">Platform Admin</span>
            </div>
            <h1 className="page-title">Open Work Orders</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Work orders accepting platform candidate recommendations.
              Run the AI scan to automatically match platform candidates to open roles.
            </p>
          </div>
          <div className="shrink-0">
            <Button
              onClick={runAiScan}
              disabled={isRunningAiScan || scanStatus?.scanInProgress}
              className="gap-2 bg-violet-600 hover:bg-violet-500 border-0 shadow-md shadow-violet-900/30"
            >
              {isRunningAiScan || scanStatus?.scanInProgress
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Running AI Scan…</>
                : <><Zap className="w-4 h-4" /> Run AI Scan</>
              }
            </Button>
          </div>
        </div>

        {/* Last scan status */}
        {scanStatus?.lastScanResult && (
          <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>Last scan: <span className="text-foreground font-medium">{new Date(scanStatus.lastScanResult.runAt).toLocaleString()}</span></span>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="text-muted-foreground">{scanStatus.lastScanResult.jobsScanned} work orders</span>
              <span className="text-muted-foreground">{scanStatus.lastScanResult.candidatesEvaluated} evaluated</span>
              <span className={scanStatus.lastScanResult.newPushes > 0 ? "text-emerald-400 font-semibold" : "text-muted-foreground"}>
                {scanStatus.lastScanResult.newPushes} auto-matched
              </span>
              <span className="text-muted-foreground">{scanStatus.lastScanResult.skippedAlreadyPushed} already placed</span>
              {(scanStatus.lastScanResult.autoPaused ?? 0) > 0 && (
                <span className="text-amber-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />{scanStatus.lastScanResult.autoPaused} auto-paused
                </span>
              )}
              {scanStatus.lastScanResult.errors > 0 && (
                <span className="text-red-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />{pluralize(scanStatus.lastScanResult.errors, "error")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Active Scanning", value: activeJobs.length, icon: Zap, color: "text-violet-400" },
            { label: "Paused", value: pausedJobs.length, icon: Clock, color: "text-amber-400" },
            { label: "Tenants Enrolled", value: new Set(jobs.map(j => j.tenantId)).size, icon: Building2, color: "text-blue-400" },
            { label: "Pushes Made", value: jobs.reduce((s, j) => s + j.platformPushCount, 0), icon: Send, color: "text-emerald-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="border-border/40">
              <CardContent className="p-4 flex items-center gap-3">
                <div className={cn("w-8 h-8 rounded-lg bg-muted/40 flex items-center justify-center shrink-0", color)}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xl font-black tabular-nums">{isLoading ? "—" : value}</p>
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-9"
            placeholder="Search by title, tenant, location, work order number…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-20 rounded-xl bg-muted/30 animate-pulse" />)}
          </div>
        ) : isError ? (
          <Card className="border-red-500/20 bg-red-500/5">
            <CardContent className="p-6 text-center text-red-400 text-sm">
              Failed to load open work orders. Please refresh.
            </CardContent>
          </Card>
        ) : jobs.length === 0 ? (
          <div className="text-center py-24 space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mx-auto">
              <Radio className="w-7 h-7 text-violet-400" />
            </div>
            <p className="font-semibold text-foreground">No work orders yet</p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              When a tenant enables "Accept Platform Recommendations" on a work order,
              it will appear here and you can push candidates directly to that role.
            </p>
          </div>
        ) : filteredActive.length === 0 && filteredPaused.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-16">No results match your search.</p>
        ) : (
          <div className="space-y-8">

            {/* ── Active work orders ── */}
            {filteredActive.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-violet-400" />
                  <span className="text-xs font-black tracking-widest text-violet-400 uppercase">Active — AI Scanning</span>
                  <span className="text-[10px] text-muted-foreground/60 ml-1">{pluralize(filteredActive.length, "work order")}</span>
                </div>
                <div className="space-y-6">
                  {byTenantActive.map(({ tenantName, parentTenantName, jobs: tenantJobs }) => (
                    <div key={tenantName}>
                      <div className="flex items-center gap-2 mb-2">
                        <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{tenantName}</span>
                        {parentTenantName && (
                          <span className="text-[10px] text-muted-foreground/50 bg-muted/30 border border-border/30 rounded px-1.5 py-0.5">
                            via {parentTenantName}
                          </span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {tenantJobs.map(j => (
                          <Card key={j.id} className="border-border/40 hover:border-violet-500/30 transition-colors">
                            <CardContent className="p-4">
                              <div className="flex items-start gap-4">
                                <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                                  <Briefcase className="w-4.5 h-4.5 text-violet-400" />
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold text-foreground">{j.title}</span>
                                    {j.workOrderNumber && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono">{j.workOrderNumber}</Badge>
                                    )}
                                    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 capitalize", statusBadge[j.status] ?? "")}>
                                      {j.status}
                                    </Badge>
                                    {j.workType && (
                                      <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 capitalize", workTypeBadge[j.workType] ?? "")}>
                                        {j.workType}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    {j.department && <span>{j.department}</span>}
                                    {j.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{j.location}</span>}
                                    <span className="flex items-center gap-1"><Users className="w-3 h-3" />{pluralize(j.applicationCount, "applicant")}</span>
                                    {j.platformPushCount > 0 && (
                                      <span className="flex items-center gap-1 text-violet-400">
                                        <Star className="w-3 h-3" />{pluralize(j.platformPushCount, "platform push", "platform pushes")}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button size="sm" variant="outline" className="h-8 px-3 gap-1.5 text-xs" asChild>
                                    <Link href={`/jobs/${j.id}`}>View <ArrowRight className="w-3 h-3" /></Link>
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-8 px-3 gap-1.5 text-xs bg-violet-600 hover:bg-violet-500 border-0 shadow-md shadow-violet-900/30"
                                    onClick={() => setPushTarget(j)}
                                  >
                                    <Send className="w-3 h-3" /> Push Candidate
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Paused work orders ── */}
            {filteredPaused.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs font-black tracking-widest text-amber-400 uppercase">Paused</span>
                  <span className="text-[10px] text-muted-foreground/60 ml-1">{pluralize(filteredPaused.length, "work order")} — not included in AI scans</span>
                </div>
                <div className="space-y-6">
                  {byTenantPaused.map(({ tenantName, parentTenantName, jobs: tenantJobs }) => (
                    <div key={tenantName}>
                      <div className="flex items-center gap-2 mb-2">
                        <Building2 className="w-3.5 h-3.5 text-muted-foreground/50" />
                        <span className="text-xs font-bold text-muted-foreground/60 uppercase tracking-wider">{tenantName}</span>
                        {parentTenantName && (
                          <span className="text-[10px] text-muted-foreground/40 bg-muted/20 border border-border/20 rounded px-1.5 py-0.5">
                            via {parentTenantName}
                          </span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {tenantJobs.map(j => (
                          <Card key={j.id} className="border-border/20 bg-muted/5 opacity-70 hover:opacity-90 transition-opacity">
                            <CardContent className="p-4">
                              <div className="flex items-start gap-4">
                                <div className="w-10 h-10 rounded-xl bg-amber-500/5 border border-amber-500/15 flex items-center justify-center shrink-0">
                                  <Briefcase className="w-4.5 h-4.5 text-amber-400/60" />
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-semibold text-foreground/70">{j.title}</span>
                                    {j.workOrderNumber && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono opacity-60">{j.workOrderNumber}</Badge>
                                    )}
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-amber-500/10 text-amber-400 border-amber-500/20">
                                      Paused
                                    </Badge>
                                    {j.workType && (
                                      <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 capitalize opacity-50", workTypeBadge[j.workType] ?? "")}>
                                        {j.workType}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground/60">
                                    {j.department && <span>{j.department}</span>}
                                    {j.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{j.location}</span>}
                                    {j.platformPushCount > 0 && (
                                      <span className="flex items-center gap-1">
                                        <Star className="w-3 h-3" />{pluralize(j.platformPushCount, "push", "pushes")} made
                                      </span>
                                    )}
                                    {j.lastPushAt && (
                                      <span className="flex items-center gap-1">
                                        <Clock className="w-3 h-3" />Last push {new Date(j.lastPushAt).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button size="sm" variant="outline" className="h-8 px-3 gap-1.5 text-xs opacity-60" asChild>
                                    <Link href={`/jobs/${j.id}`}>View <ArrowRight className="w-3 h-3" /></Link>
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 px-3 gap-1.5 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                                    disabled={resumeMutation.isPending}
                                    onClick={() => resumeMutation.mutate(j.id)}
                                  >
                                    {resumeMutation.isPending
                                      ? <Loader2 className="w-3 h-3 animate-spin" />
                                      : <><RefreshCw className="w-3 h-3" /> Resume</>
                                    }
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {pushTarget && (
        <PushModal job={pushTarget} onClose={() => setPushTarget(null)} />
      )}
    </AppLayout>
  );
}
