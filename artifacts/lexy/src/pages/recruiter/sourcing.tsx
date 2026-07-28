/**
 * pages/recruiter/sourcing.tsx — Candidate Sourcing Control Panel
 *
 * Two ways to source:
 *   1. "Select a Job" tab    — pick a work order, run the multi-source
 *                              search using its ICP (existing flow).
 *   2. "Describe What You Need" tab — type a conversational query like
 *                              "Java developers in NYC with 8 years
 *                              experience"; OpenAI parses it into a
 *                              structured search context, we hit the
 *                              internal talent pool + the same external
 *                              sources, and you can attach any result to
 *                              a work order in one click.
 *
 * Backend endpoints used:
 *   POST /api/sourcing/search       (job-driven, ICP-aware)
 *   POST /api/sourcing/nl-search    (conversational, NL-driven)
 *   POST /api/applications          (attach a sourced candidate to a job)
 *   GET  /api/sourcing/status       (connector availability for the cards)
 *   GET  /api/sourcing/candidates   (previously-sourced cache)
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { authHeaders } from "@/lib/api";
import { pluralize } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Search, Zap, Github, Linkedin, Database, Globe, Download, MapPin, Building, CheckCircle2, XCircle, RefreshCw, AlertCircle, Star, Users, Sparkles, Code2, MessageSquare, Briefcase, Plus, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Hotspot } from "@/lib/tour/Hotspot";
import { startSimulatedRun } from "@/lib/agent-runs";
import { SourcingRunPanel } from "@/components/agents/SourcingRunPanel";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// Local fetch helper: prefixes /api, attaches the bearer token, and throws on
// non-2xx so react-query can surface the error.
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// Display metadata (name, icon, colours, blurb) for each sourcing connector
// shown as availability cards.
const SOURCE_META: Record<string, { name: string; icon: any; color: string; border: string; desc: string }> = {
  internal:    { name: "Talent Pool",      icon: Users,     color: "text-violet-400 bg-violet-500/15", border: "border-violet-500/30", desc: "Existing candidates in your database" },
  github:      { name: "GitHub",           icon: Github,    color: "text-slate-300 bg-slate-500/15",   border: "border-slate-500/30",  desc: "Engineering roles only" },
  pdl:         { name: "People Data Labs", icon: Database,  color: "text-blue-400 bg-blue-500/15",     border: "border-blue-500/30",   desc: "500M+ professional profiles" },
  serp:        { name: "Web Search",       icon: Globe,     color: "text-green-400 bg-green-500/15",   border: "border-green-500/30",  desc: "Google search of LinkedIn profiles" },
  enrichlayer: { name: "EnrichLayer",      icon: Sparkles,  color: "text-fuchsia-300 bg-fuchsia-500/15", border: "border-fuchsia-500/30", desc: "Real LinkedIn profile enrichment" },
  linkedin:    { name: "LinkedIn",         icon: Linkedin,  color: "text-sky-400 bg-sky-500/15",       border: "border-sky-500/30",    desc: "Coming soon" },
};

/* A source can report a `skipped` reason for two very different situations:
 *  - an intentional skip (key not configured, source disabled for this role,
 *    nothing upstream to enrich) — informational, not a problem; and
 *  - a real upstream failure (HTTP error, fetch error, non-OK response) — the
 *    search silently returned zero from that source and the recruiter needs to
 *    know it was a failure, not an empty result.
 * classifySkip() separates the two so the UI can surface failures loudly. */
function classifySkip(reason?: string): "error" | "info" | null {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (/(http|error|non-ok|failed|timeout|timed out|exception)/.test(r)) return "error";
  return "info";
}

/* Rotating example prompts for the empty NL textarea — shown as placeholder
 * so the recruiter knows what kind of query is expected. */
const NL_EXAMPLES = [
  "Find Java developers in NYC with 8 years of experience",
  "Senior product designers in London who've worked at fintech startups",
  "Salesforce admins in Texas, must be certified",
  "Data engineers remote in the US with Snowflake and dbt experience",
];

// Small horizontal match-score bar; colour bands by canonical fit strength.
// Sourcing scores are PRELIMINARY: they're a pre-intelligence estimate computed
// at discovery time, not the accrued candidate_job_intelligence verdict the
// pipeline board and candidate detail page show once a candidate is analysed.
// We label them "prelim" so recruiters don't mistake them for the final score.
function MatchBar({ score }: { score: number }) {
  const color = bandBy(score, { strong: "bg-emerald-500", good: "bg-primary", fair: "bg-orange-500" });
  return (
    <div className="flex items-center gap-2" title="Preliminary fit estimate — refined once the candidate is analysed">
      <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-sm font-bold ${bandBy(score, { strong: "text-emerald-400", good: "text-primary", fair: "text-orange-400" })}`}>{score}%</span>
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">prelim</span>
    </div>
  );
}

export default function Sourcing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"job" | "nl">("job");
  const [selectedJob, setSelectedJob] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [sourceSummary, setSourceSummary] = useState<any>(null);
  /* Enforced internal-first: the id of the job whose OWN internal talent the
   * recruiter has reviewed this session. External sourcing ("Go to Market") is
   * unlocked only once this === selectedJob. The server enforces the same gate
   * (409 INTERNAL_REVIEW_REQUIRED) so this is UX, not the security boundary. */
  const [internalReviewedJobId, setInternalReviewedJobId] = useState<string | null>(null);
  /* How many internal matches the review turned up, so the gate can be
   * PROPORTIONAL: strong bench → the recruiter can stop here; zero bench →
   * we say so plainly and let external proceed with a single click rather
   * than forcing a ceremony over an empty result. */
  const [internalMatchCount, setInternalMatchCount] = useState<number | null>(null);

  /* Active simulated ("demo") sourcing run — id to poll for the live feed.
   * `demoRunActive` tracks whether it's still in flight, so the completed feed
   * stays visible while the button re-enables for another run. */
  const [demoRunId, setDemoRunId] = useState<string | null>(null);
  const [demoRunActive, setDemoRunActive] = useState(false);

  /* Deep-link: `/sourcing?run=<id>` (from a work-order card, the detail page, or
   * the dashboard quick action) auto-opens that run's live feed. */
  const search$ = useSearch();
  useEffect(() => {
    const runParam = new URLSearchParams(search$).get("run");
    if (runParam) {
      setDemoRunId(runParam);
      setDemoRunActive(true);
    }
  }, [search$]);

  /* NL-tab state. nlAttachJobId is the work order chosen up-front for the
   * one-click "Add to Pipeline" buttons on each result row — it can be
   * empty (recruiter just exploring), in which case the per-row button
   * shows a job picker instead. */
  const [nlQuery, setNlQuery] = useState("");
  const [nlAttachJobId, setNlAttachJobId] = useState("");
  const nlPlaceholder = NL_EXAMPLES[Math.floor(Date.now() / 8000) % NL_EXAMPLES.length];

  /* Track which sourced candidates have already been attached so the
   * button can flip to a confirmed state without a full refetch. */
  const [attached, setAttached] = useState<Record<string, string>>({}); // candidateId → jobId

  const { data: jobs } = useQuery<any>({ queryKey: ["/api/jobs"], queryFn: () => apiFetch("/jobs") });
  const { data: status } = useQuery<any>({ queryKey: ["/api/sourcing/status"], queryFn: () => apiFetch("/sourcing/status") });
  const { data: savedData, refetch: refetchSaved } = useQuery<any>({ queryKey: ["/api/sourcing/candidates"], queryFn: () => apiFetch("/sourcing/candidates") });

  /* STEP 1 — internal-first review. Searches ONLY the tenant's own talent pool
   * (current employees + previously-saved candidates), never external providers
   * and never the platform pool. Running it records the server-side marker that
   * unlocks external sourcing spend for this requisition. */
  const internalMutation = useMutation({
    mutationFn: (jobId: string) => apiFetch<any>("/sourcing/internal", {
      method: "POST",
      body: JSON.stringify({ jobId, maxPerSource: 15 }),
    }),
    onSuccess: (data, jobId) => {
      setResults(data.candidates || []);
      setSourceSummary(data);
      setInternalReviewedJobId(jobId);
      setInternalMatchCount(data.total ?? (data.candidates?.length ?? 0));
      refetchSaved();
      queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
      toast({
        title: data.total > 0
          ? `${pluralize(data.total, "internal match")} in your talent pool`
          : "No internal matches for this role",
        description: data.icpMissing
          ? "Run the ICP agent first for sharper internal matching. You can now go to market if needed."
          : "Reviewed your own talent first — you can now source externally if you need to.",
      });
    },
    onError: () => toast({ title: "Internal search failed", variant: "destructive" }),
  });

  const searchMutation = useMutation({
    mutationFn: (jobId: string) => apiFetch<any>("/sourcing/search", {
      method: "POST",
      body: JSON.stringify({ jobId, sources: ["internal", "github", "pdl", "serp", "enrichlayer"], maxPerSource: 15 }),
    }),
    onSuccess: (data, jobId) => {
      setResults(data.candidates || []);
      setSourceSummary(data);
      refetchSaved();
      queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      queryClient.invalidateQueries({ queryKey: ["intelligence", "job", jobId] });
      const failedCount = Object.values((data.queries ?? {}) as Record<string, any>)
        .filter((q: any) => classifySkip(q?.skipped) === "error").length;
      const desc = data.icpMissing
        ? "Run the ICP agent for this job first — sourcing accuracy will be much higher."
        : `Internal: ${data.bySource.internal} · GH: ${data.bySource.github} · PDL: ${data.bySource.pdl} · Web: ${data.bySource.serp} · EnrichLayer: ${data.bySource.enrichlayer ?? 0}`;
      toast({
        title: `Found ${pluralize(data.total, "candidate")}`,
        description: failedCount > 0 ? `${desc} — ${pluralize(failedCount, "source")} failed (see banner)` : desc,
        variant: failedCount > 0 ? "destructive" : undefined,
      });
    },
    onError: (err: any) => {
      /* Server-side internal-first gate (safety net — the button is normally
       * disabled until step 1 runs). Reset the marker and steer them back. */
      if (String(err?.message ?? "").includes("INTERNAL_REVIEW_REQUIRED")) {
        setInternalReviewedJobId(null);
        setInternalMatchCount(null);
        toast({
          title: "Review your internal talent first",
          description: "Run the internal search for this role before going to market.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Sourcing failed", variant: "destructive" });
    },
  });

  /* Simulated ("demo") sourcing run. Kicks off a ~20s server-side sequence that
   * emits live events AND creates real demo-flagged candidates so the pipeline,
   * funnel and approvals populate. The SourcingRunPanel below polls the run. */
  const demoMutation = useMutation({
    mutationFn: (jobId: string) => startSimulatedRun(jobId),
    onSuccess: (runId) => {
      setDemoRunId(runId);
      setDemoRunActive(true);
      toast({ title: "Demo sourcing run started", description: "Watch the live progress below." });
    },
    onError: (err: any) => toast({ title: "Could not start demo run", description: err?.message ?? "", variant: "destructive" }),
  });

  /* When a demo run finishes, refresh the surfaces it populated. */
  function handleDemoRunDone() {
    setDemoRunActive(false);
    refetchSaved();
    // Header live-agent count is derived from active runs — refresh it so the
    // dashboard falls back to "System Ready" once this run finishes.
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
    if (selectedJob) {
      queryClient.invalidateQueries({ queryKey: ["pipeline-stages", selectedJob] });
      queryClient.invalidateQueries({ queryKey: ["intelligence", "job", selectedJob] });
    }
    toast({ title: "Demo run complete", description: "Shortlisted candidates added to the pipeline." });
  }

  /* Conversational sourcing mutation. Same response shape as searchMutation
   * so the existing results UI doesn't have to branch. */
  const nlMutation = useMutation({
    mutationFn: () => apiFetch<any>("/sourcing/nl-search", {
      method: "POST",
      body: JSON.stringify({
        query: nlQuery.trim(),
        jobId: nlAttachJobId || undefined,
        sources: ["internal", "github", "pdl", "serp", "enrichlayer"],
        maxPerSource: 15,
      }),
    }),
    onSuccess: (data) => {
      setResults(data.candidates || []);
      setSourceSummary(data);
      const failedCount = Object.values((data.queries ?? {}) as Record<string, any>)
        .filter((q: any) => classifySkip(q?.skipped) === "error").length;
      const base = data.interpretation || `Internal: ${data.bySource.internal} · External: ${(data.bySource.github + data.bySource.pdl + data.bySource.serp + (data.bySource.enrichlayer ?? 0))}`;
      toast({
        title: `Found ${pluralize(data.total, "candidate")}`,
        description: failedCount > 0 ? `${base} — ${pluralize(failedCount, "source")} failed (see banner)` : base,
        variant: failedCount > 0 ? "destructive" : undefined,
      });
    },
    onError: (err: any) => {
      /* Internal-first gate when the NL search is tied to a requisition. */
      if (String(err?.message ?? "").includes("INTERNAL_REVIEW_REQUIRED")) {
        toast({
          title: "Review your internal talent first",
          description: "Switch to the \u201cSelect a Job\u201d tab and run the internal search for this role before sourcing externally.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Search failed", description: err?.message ?? "", variant: "destructive" });
    },
  });

  /* Attach a sourced candidate to a work order. Backend creates an
   * application row and auto-triggers the screening agent. */
  const attachMutation = useMutation({
    mutationFn: ({ candidateId, jobId }: { candidateId: string; jobId: string }) =>
      apiFetch<any>("/applications", {
        method: "POST",
        body: JSON.stringify({ jobId, candidateId, stage: "applied" }),
      }),
    onSuccess: (_data, vars) => {
      setAttached((m) => ({ ...m, [vars.candidateId]: vars.jobId }));
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-stages", vars.jobId] });
      toast({ title: "Attached to work order", description: "Screening agent has been queued." });
    },
    onError: (err: any) => toast({ title: "Attach failed", description: err?.message ?? "", variant: "destructive" }),
  });

  const jobList = (jobs as any)?.jobs || [];
  const connectors = status?.connectors || {};
  const displayCandidates = results.length > 0 ? results : ((savedData as any) || []).map((s: any) => ({
    ...s,
    ...(s.rawData || {}),
    matchScore: s.rawData?.matchScore || Math.round((s.mergeConfidence || 0.5) * 100),
    source: s.source,
  }));

  /* Helper for the per-row attach UI on the NL tab: if the recruiter
   * pre-picked an attach job, show a single-click button; otherwise show a
   * compact inline job picker so they can choose right at the row. */
  function AttachButton({ candidateId }: { candidateId: string | undefined }) {
    const cid = candidateId;
    if (!cid) {
      /* External sources return profiles without a candidates-table id.
       * Persisting them is a separate workflow (Save → review → attach);
       * make the constraint visible rather than offering a button that
       * can't fire. */
      return (
        <Button
          size="sm" variant="outline" className="gap-1.5 h-8 text-xs" disabled
          title="External profiles must be saved to your candidate pool first, then attached from the candidate page."
        >
          Save to attach
        </Button>
      );
    }
    const attachedToJob = attached[cid];
    if (attachedToJob) {
      const jobTitle = jobList.find((j: any) => j.id === attachedToJob)?.title;
      return (
        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs border-emerald-500/30 text-emerald-400 bg-emerald-500/5" disabled>
          <Check className="w-3.5 h-3.5" /> Added{jobTitle ? ` to ${jobTitle}` : ""}
        </Button>
      );
    }
    if (nlAttachJobId) {
      return (
        <Button
          size="sm" variant="outline"
          className="gap-1.5 h-8 text-xs"
          disabled={attachMutation.isPending}
          onClick={() => attachMutation.mutate({ candidateId: cid, jobId: nlAttachJobId })}
        >
          <Plus className="w-3.5 h-3.5" /> Add to Pipeline
        </Button>
      );
    }
    /* No pre-picked job → inline picker */
    return (
      <Select onValueChange={(jobId) => attachMutation.mutate({ candidateId: cid, jobId })}>
        <SelectTrigger className="h-8 w-44 text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /><SelectValue placeholder="Add to job…" />
        </SelectTrigger>
        <SelectContent>
          {jobList.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No open jobs</div>}
          {jobList.map((j: any) => (
            <SelectItem key={j.id} value={j.id} className="text-xs">{j.title}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 data-tour="sourcing-page-title" className="page-title">Sourcing Engine</h1>
          <p className="text-muted-foreground mt-1">AI-powered candidate discovery from your talent pool, GitHub, PDL, web search and more.</p>
        </div>
      </div>

      {/* Connector status — 6 cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
        {Object.entries(SOURCE_META).map(([id, meta]) => {
          const Icon = meta.icon;
          const conn = connectors[id];
          const isLive = conn?.available;
          const hasKey = conn?.apiKey;
          return (
            <Card key={id} className={`border ${isLive ? meta.border : "border-white/10"} transition-all`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isLive ? meta.color : "bg-white/5 text-white/30"}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex items-center gap-1">
                    {isLive
                      ? <><CheckCircle2 className="w-3 h-3 text-emerald-400" /><span className="text-[10px] text-emerald-400 font-semibold">Live</span></>
                      : <><XCircle className="w-3 h-3 text-white/30" /><span className="text-[10px] text-white/30 font-semibold">Offline</span></>
                    }
                  </div>
                </div>
                <p className="font-semibold text-xs">{meta.name}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{meta.desc}</p>
                {id === "internal" && <p className="text-[10px] text-violet-400/80 mt-2">Always available</p>}
                {id === "github" && <p className="text-[10px] text-emerald-500/80 mt-2">No key required</p>}
                {id !== "internal" && id !== "github" && !hasKey && isLive && (
                  <p className="text-[10px] text-yellow-500/80 mt-2 flex items-center gap-1"><AlertCircle className="w-2.5 h-2.5" /> API key needed</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Two-mode input: Select a Job vs Describe What You Need */}
      <Card className="mb-6 border-primary/20 bg-primary/5">
        <CardContent className="p-5">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "job" | "nl")}>
            <TabsList className="mb-4">
              <TabsTrigger value="job" className="gap-2"><Briefcase className="w-3.5 h-3.5" /> Select a Job</TabsTrigger>
              <TabsTrigger value="nl" className="gap-2"><MessageSquare className="w-3.5 h-3.5" /> Describe What You Need</TabsTrigger>
            </TabsList>

            {/* ─── Job-driven — enforced internal-first, two-step ──────────── */}
            <TabsContent value="job" className="mt-0">
              {(() => {
                const internalDone = !!selectedJob && internalReviewedJobId === selectedJob;
                // Proportional gate: distinguish "reviewed, has bench" from
                // "reviewed, empty bench". On an empty bench we drop the
                // ceremony and make external the obvious one-click next step.
                const internalEmpty = internalDone && internalMatchCount === 0;
                const internalHasBench = internalDone && (internalMatchCount ?? 0) > 0;
                // No-ICP fallback: when the role has no computed ICP the internal
                // search still runs — it matches your pool on job title + skills.
                // So an empty result means "we looked and found none", never "we
                // couldn't look". We surface that distinction + an ICP prompt.
                const internalIcpMissing = internalDone && !!sourceSummary?.icpMissing;
                return (
                  <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      <div className="flex-1">
                        <h3 className="font-semibold mb-1">Source Candidates for a Job</h3>
                        <p className="text-sm text-muted-foreground">Internal talent first: review who's already in your own talent pool, then go to market only if you need to. Run the ICP agent first for best results.</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <Select
                          value={selectedJob}
                          onValueChange={(v) => { setSelectedJob(v); setInternalReviewedJobId(null); setInternalMatchCount(null); }}
                        >
                          <SelectTrigger className="w-52 h-9 text-sm">
                            <SelectValue placeholder="Select a job..." />
                          </SelectTrigger>
                          <SelectContent>
                            {jobList.map((j: any) => (
                              <SelectItem key={j.id} value={j.id} className="text-sm">{j.title}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          className="gap-2 shrink-0"
                          disabled={!selectedJob || demoMutation.isPending || demoRunActive}
                          onClick={() => selectedJob && demoMutation.mutate(selectedJob)}
                          title="Run a simulated sourcing sequence that creates demo candidates and shows live progress"
                        >
                          {demoMutation.isPending || demoRunActive
                            ? <><RefreshCw className="w-4 h-4 animate-spin" /> Running…</>
                            : <><Sparkles className="w-4 h-4" /> Demo Run</>
                          }
                        </Button>
                      </div>
                    </div>

                    {/* Two enforced steps: (1) internal review, (2) external market. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Step 1 — internal talent pool (always available) */}
                      <div className={`rounded-lg border p-4 transition-colors ${internalDone ? "border-violet-500/30 bg-violet-500/5" : "border-primary/20 bg-primary/5"}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-violet-500/20 text-violet-300 text-[11px] font-bold">1</span>
                          <span className="font-semibold text-sm">Review internal talent</span>
                          {internalDone && <Check className="w-4 h-4 text-violet-400 ml-auto" />}
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">Searches only your own talent pool — current employees and candidates already in your database. No external spend, fully private.</p>
                        {internalHasBench && (
                          <p className="text-xs font-medium text-violet-300 mb-3 flex items-center gap-1.5">
                            <Check className="w-3.5 h-3.5" />
                            {pluralize(internalMatchCount ?? 0, "internal match")} found — review below before spending on external.
                          </p>
                        )}
                        {internalEmpty && (
                          <p className="text-xs font-medium text-amber-300/90 mb-3 flex items-start gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>
                              {internalIcpMissing
                                ? "We searched your pool on job title and skills and found no internal matches. Generate an ICP for sharper matching, or source externally on the right."
                                : "No internal matches for this role — external sourcing is unlocked on the right."}
                            </span>
                          </p>
                        )}
                        <div className="relative inline-block">
                          <Button
                            className="gap-2 shrink-0"
                            disabled={!selectedJob || internalMutation.isPending}
                            onClick={() => selectedJob && internalMutation.mutate(selectedJob)}
                          >
                            {internalMutation.isPending
                              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Searching…</>
                              : internalDone
                                ? <><Users className="w-4 h-4" /> Search Again</>
                                : <><Users className="w-4 h-4" /> Search Internal</>
                            }
                          </Button>
                          <Hotspot id="sourcing-run" tooltip="Pick a job, then review your internal talent first" />
                        </div>
                      </div>

                      {/* Step 2 — external market (locked until step 1 runs) */}
                      <div className={`rounded-lg border p-4 transition-colors ${internalEmpty ? "border-primary/40 bg-primary/10" : internalDone ? "border-primary/20 bg-primary/5" : "border-white/10 bg-white/[0.02] opacity-70"}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold ${internalDone ? "bg-primary/20 text-primary" : "bg-white/10 text-white/40"}`}>2</span>
                          <span className="font-semibold text-sm">Go to market</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">
                          {!internalDone
                            ? "Unlocks once you've reviewed your internal talent for this role."
                            : internalEmpty
                              ? "No one internal fits — searching externally is the right call. One click below."
                              : internalHasBench
                                ? "Reviewed your bench and still need more reach? Search GitHub, PDL and the web using the job's ICP."
                                : "Searches GitHub, PDL and the web using the job's ICP."}
                        </p>
                        <p className="text-[11px] font-medium text-amber-300/90 mb-3 flex items-center gap-1.5">
                          <Zap className="w-3 h-3 shrink-0" />
                          This searches external sources and uses credits.
                        </p>
                        <Button
                          className="gap-2 shrink-0"
                          variant={internalDone ? "default" : "outline"}
                          disabled={!internalDone || searchMutation.isPending}
                          onClick={() => selectedJob && searchMutation.mutate(selectedJob)}
                          title={internalDone ? "Search external sources — uses credits" : "Review your internal talent first"}
                        >
                          {searchMutation.isPending
                            ? <><RefreshCw className="w-4 h-4 animate-spin" /> Sourcing…</>
                            : <><Zap className="w-4 h-4" /> Proceed to External Sourcing</>
                          }
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </TabsContent>

            {/* ─── Conversational (new) ──────────────────────────────────── */}
            <TabsContent value="nl" className="mt-0">
              <div className="space-y-3">
                <div>
                  <h3 className="font-semibold mb-1">Describe the candidate you're looking for</h3>
                  <p className="text-sm text-muted-foreground">Type it like you'd ask a colleague. Our AI parses your description, then searches your talent pool and external sources.</p>
                </div>
                <Textarea
                  value={nlQuery}
                  onChange={(e) => setNlQuery(e.target.value)}
                  placeholder={nlPlaceholder}
                  rows={3}
                  className="resize-none text-sm"
                  onKeyDown={(e) => {
                    /* Cmd/Ctrl+Enter to submit — saves a click for power users. */
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && nlQuery.trim().length >= 3 && !nlMutation.isPending) {
                      nlMutation.mutate();
                    }
                  }}
                />
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 justify-between">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Briefcase className="w-3.5 h-3.5" />
                    <span>Attach matches to:</span>
                    <Select
                      value={nlAttachJobId || "__none__"}
                      onValueChange={(v) => setNlAttachJobId(v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger className="w-52 h-8 text-xs">
                        <SelectValue placeholder="(optional — pick later)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__" className="text-xs">No work order (pick per row)</SelectItem>
                        {jobList.map((j: any) => (
                          <SelectItem key={j.id} value={j.id} className="text-xs">{j.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="gap-2"
                    disabled={nlQuery.trim().length < 3 || nlMutation.isPending}
                    onClick={() => nlMutation.mutate()}
                  >
                    {nlMutation.isPending
                      ? <><RefreshCw className="w-4 h-4 animate-spin" /> Searching…</>
                      : <><Sparkles className="w-4 h-4" /> Source Now</>
                    }
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {sourceSummary && (
            <div className="mt-4 pt-4 border-t border-primary/20 flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Total: <strong className="text-foreground">{sourceSummary.total}</strong></span>
              <span className="text-muted-foreground text-violet-400">Talent Pool: <strong className="text-violet-300">{sourceSummary.bySource?.internal ?? 0}</strong></span>
              <span className="text-muted-foreground">GitHub: <strong className="text-foreground">{sourceSummary.bySource?.github}</strong></span>
              <span className="text-muted-foreground">PDL: <strong className="text-foreground">{sourceSummary.bySource?.pdl}</strong></span>
              <span className="text-muted-foreground">Web: <strong className="text-foreground">{sourceSummary.bySource?.serp}</strong></span>
              <span className="text-muted-foreground text-fuchsia-300">EnrichLayer: <strong className="text-fuchsia-200">{sourceSummary.bySource?.enrichlayer ?? 0}</strong></span>
              {sourceSummary.saved > 0 && <span className="text-muted-foreground">Saved: <strong className="text-emerald-400">{sourceSummary.saved}</strong></span>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live sourcing run feed — shown while a demo run is active/complete. */}
      {demoRunId && (
        <SourcingRunPanel runId={demoRunId} isSimulated onDone={handleDemoRunDone} />
      )}

      {/* Source-failure banner — a real upstream error (not an intentional
          skip) means that source returned zero because it broke, not because
          there were no matches. Surface it loudly so "0 results" isn't read as
          "no candidates exist". */}
      {sourceSummary?.queries && (() => {
        const failed = Object.entries(sourceSummary.queries as Record<string, any>)
          .filter(([, q]: [string, any]) => classifySkip(q?.skipped) === "error")
          .map(([src, q]: [string, any]) => ({
            name: SOURCE_META[src as keyof typeof SOURCE_META]?.name || src,
            reason: q.skipped as string,
          }));
        if (failed.length === 0) return null;
        return (
          <div className="mb-4 p-4 rounded-xl border border-rose-500/40 bg-rose-500/10 flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="text-sm flex-1 min-w-0">
              <p className="font-semibold text-rose-300">
                {failed.length === 1 ? "1 source failed" : `${failed.length} sources failed`} — these returned 0 because of an error, not because no one matched
              </p>
              <ul className="mt-1.5 space-y-1">
                {failed.map((f) => (
                  <li key={f.name} className="text-rose-200/90 text-xs">
                    <span className="font-medium">{f.name}:</span> <span className="font-mono">{f.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })()}

      {/* NL interpretation banner — trust signal for the parsed query */}
      {sourceSummary?.mode === "nl" && sourceSummary?.interpretation && (
        <Card className="mb-4 border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{sourceSummary.interpretation}</p>
                {sourceSummary.parsed && (
                  <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
                    {sourceSummary.parsed.jobTitle && (
                      <Badge variant="outline" className="text-[10px]"><Briefcase className="w-2.5 h-2.5 mr-1" />{sourceSummary.parsed.jobTitle}</Badge>
                    )}
                    {sourceSummary.parsed.location && (
                      <Badge variant="outline" className="text-[10px]"><MapPin className="w-2.5 h-2.5 mr-1" />{sourceSummary.parsed.location}</Badge>
                    )}
                    {sourceSummary.parsed.minYearsExperience != null && (
                      <Badge variant="outline" className="text-[10px]">{sourceSummary.parsed.minYearsExperience}+ yrs</Badge>
                    )}
                    {sourceSummary.parsed.seniority && (
                      <Badge variant="outline" className="text-[10px] capitalize">{sourceSummary.parsed.seniority}</Badge>
                    )}
                    {(sourceSummary.parsed.requiredSkills || []).slice(0, 8).map((s: string) => (
                      <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ICP missing warning (job-mode only) */}
      {sourceSummary?.icpMissing && sourceSummary?.mode !== "nl" && (
        <div className="mb-4 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-300">No ICP for this job yet</p>
            <p className="text-muted-foreground mt-0.5">Sourcing is using only the job title and location. Generate an ICP first to unlock alternate titles, certifications, tools, and a domain-aware boolean search.</p>
          </div>
        </div>
      )}

      {/* ICP context summary (job-mode) */}
      {sourceSummary?.icpUsed && sourceSummary?.mode !== "nl" && (
        <Card className="mb-4 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold">ICP context applied</h4>
            </div>
            <div className="grid md:grid-cols-2 gap-3 text-xs">
              {sourceSummary.icpUsed.domain && (
                <div><span className="text-muted-foreground">Domain:</span> <span className="font-medium ml-1">{sourceSummary.icpUsed.domain}</span>{sourceSummary.icpUsed.subSpecialty ? <span className="text-muted-foreground"> · {sourceSummary.icpUsed.subSpecialty}</span> : null}</div>
              )}
              {sourceSummary.icpUsed.roleFamily && (
                <div><span className="text-muted-foreground">Role family:</span> <span className="font-medium ml-1">{sourceSummary.icpUsed.roleFamily}</span></div>
              )}
              {sourceSummary.icpUsed.alternateTitles?.length > 0 && (
                <div className="md:col-span-2"><span className="text-muted-foreground">Alt titles:</span> <span className="ml-1">{sourceSummary.icpUsed.alternateTitles.slice(0, 6).join(" · ")}</span></div>
              )}
              {sourceSummary.icpUsed.requiredCertifications?.length > 0 && (
                <div className="md:col-span-2"><span className="text-muted-foreground">Certifications:</span> <span className="ml-1">{sourceSummary.icpUsed.requiredCertifications.slice(0, 6).join(" · ")}</span></div>
              )}
              {sourceSummary.icpUsed.toolsAndSystems?.length > 0 && (
                <div className="md:col-span-2"><span className="text-muted-foreground">Tools/Systems:</span> <span className="ml-1">{sourceSummary.icpUsed.toolsAndSystems.slice(0, 6).join(" · ")}</span></div>
              )}
              {sourceSummary.icpUsed.negativeKeywords?.length > 0 && (
                <div className="md:col-span-2"><span className="text-muted-foreground">Excluded:</span> <span className="ml-1 text-rose-300">{sourceSummary.icpUsed.negativeKeywords.slice(0, 6).join(" · ")}</span></div>
              )}
              {sourceSummary.icpUsed.booleanSearchString && (
                <div className="md:col-span-2 mt-2 p-2 rounded-md bg-black/30 border border-white/5 font-mono text-[10px] text-emerald-300/90 overflow-x-auto whitespace-pre-wrap break-all"><Code2 className="w-3 h-3 inline mr-1.5 -mt-0.5" />{sourceSummary.icpUsed.booleanSearchString}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-source queries audit */}
      {sourceSummary?.queries && (
        <Card className="mb-6 border-white/10">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Search strings sent to each source</h4>
            </div>
            <div className="space-y-2">
              {Object.entries(sourceSummary.queries as Record<string, any>).map(([src, q]: [string, any]) => {
                const meta = SOURCE_META[src as keyof typeof SOURCE_META];
                const Icon = meta?.icon || Globe;
                return (
                  <div key={src} className="flex items-start gap-2 text-[11px]">
                    <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-foreground/80">{meta?.name || src}:</span>{" "}
                      {q.skipped ? (
                        <span className={classifySkip(q.skipped) === "error" ? "text-rose-400 italic font-medium" : "text-amber-400/80 italic"}>{q.skipped}</span>
                      ) : (
                        <span className="font-mono text-emerald-300/80 break-all">{q.query || "(empty)"}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            {results.length > 0 ? `${results.length} Candidates Found` : "Sourced Candidates"}
          </CardTitle>
          <Button
            variant="outline" size="sm" className="gap-1.5"
            disabled={displayCandidates.length === 0}
            onClick={() => {
              /* Client-side CSV export of whatever's currently rendered.
               * Quotes every field and escapes embedded quotes so commas,
               * newlines and quoted titles round-trip cleanly into Excel. */
              const cols = [
                ["First Name",    (c: any) => c.firstName ?? ""],
                ["Last Name",     (c: any) => c.lastName ?? ""],
                ["Email",         (c: any) => c.email ?? ""],
                ["Current Title", (c: any) => c.currentTitle ?? ""],
                ["Company",       (c: any) => c.currentCompany ?? ""],
                ["Location",      (c: any) => c.location ?? ""],
                ["Skills",        (c: any) => (c.skills ?? []).join("; ")],
                ["Source",        (c: any) => c.source ?? ""],
                ["Match Score",   (c: any) => c.matchScore ?? ""],
                ["LinkedIn",      (c: any) => c.linkedinUrl ?? ""],
                ["GitHub",        (c: any) => c.githubProfile ?? ""],
              ] as const;
              const esc = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
              const rows = [
                cols.map(([h]) => esc(h)).join(","),
                ...displayCandidates.map((c: any) => cols.map(([, fn]) => esc(fn(c))).join(",")),
              ];
              const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `sourced-candidates-${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              toast({ title: `Exported ${pluralize(displayCandidates.length, "candidate")}` });
            }}
          >
            <Download className="w-3.5 h-3.5" /> Export
          </Button>
        </CardHeader>
        <CardContent>
          {displayCandidates.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Search className="w-8 h-8 text-primary/60" />
              </div>
              <h3 className="font-semibold mb-1">No candidates sourced yet</h3>
              <p className="text-sm text-muted-foreground">{tab === "nl" ? "Describe the candidate you're looking for, then click Source Now." : "Select a job and click Source Now to search your talent pool, GitHub, PDL and the web."}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {displayCandidates.map((c: any, i: number) => {
                const src = SOURCE_META[c.source as keyof typeof SOURCE_META];
                const Icon = src?.icon || Globe;
                const isInternal = c.source === "internal";
                const cid = c.candidateId || (isInternal ? undefined : c.normalizedCandidateId);
                return (
                  <div key={c.id || i} className={`flex items-center justify-between p-4 rounded-xl border transition-all group ${isInternal ? "border-violet-500/25 bg-violet-500/5 hover:border-violet-500/50" : "border-border/50 hover:border-primary/30"}`}>
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${isInternal ? "bg-violet-500/20 text-violet-300" : "bg-primary/10 text-primary"}`}>
                        {c.firstName?.charAt(0)}{c.lastName?.charAt(0)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <p className="font-semibold group-hover:text-primary transition-colors">{c.firstName} {c.lastName}</p>
                          <Badge variant="outline" className={`text-[10px] gap-1 py-0 ${isInternal ? "border-violet-500/30 text-violet-400 bg-violet-500/10" : ""}`}>
                            <Icon className="w-2.5 h-2.5" /> {src?.name || c.source}
                          </Badge>
                          {isInternal && !c.isCurrentEmployee && (
                            <Badge variant="outline" className="text-[10px] py-0 border-violet-500/30 text-violet-400 bg-violet-500/10">In your DB</Badge>
                          )}
                          {c.isCurrentEmployee && (
                            <Badge variant="outline" className="text-[10px] py-0 border-emerald-500/40 text-emerald-300 bg-emerald-500/10 gap-1">
                              <Building className="w-2.5 h-2.5" /> Current employee
                            </Badge>
                          )}
                          {c.followers > 100 && (
                            <Badge variant="secondary" className="text-[10px] gap-1 py-0">
                              <Star className="w-2.5 h-2.5" /> {c.followers} followers
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                          {c.currentTitle && <span className="flex items-center gap-1"><Building className="w-3 h-3" />{c.currentTitle}{c.currentCompany ? ` at ${c.currentCompany}` : ""}</span>}
                          {c.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{c.location}</span>}
                          {c.locationFlag && (
                            <Badge variant="outline" className="text-[10px] py-0 gap-1 border-amber-500/40 text-amber-400 bg-amber-500/10">
                              <MapPin className="w-2.5 h-2.5" /> {c.locationFlag}
                            </Badge>
                          )}
                        </p>
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          {(c.skills || []).slice(0, 5).map((s: string) => (
                            <Badge key={s} variant="secondary" className="text-[10px] h-5">{s}</Badge>
                          ))}
                        </div>
                        {c.matchReason && (
                          <p className={`text-xs mt-2 leading-snug ${isInternal ? "text-violet-200/80" : "text-muted-foreground"}`}>
                            <span className="font-medium">Fit:</span> {c.matchReason}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {c.matchScore != null && <MatchBar score={c.matchScore} />}
                      <div className="flex items-center gap-1.5">
                        {isInternal && cid ? (
                          <>
                            <AttachButton candidateId={cid} />
                            <Link href={`/candidates/${cid}`}>
                              <Button size="sm" variant="ghost" className="gap-1.5 h-8 text-xs">
                                <Users className="w-3.5 h-3.5" /> View
                              </Button>
                            </Link>
                          </>
                        ) : (
                          <AttachButton candidateId={cid} />
                        )}
                        {c.githubProfile && (
                          <a href={c.githubProfile} target="_blank" rel="noopener noreferrer" aria-label="View GitHub profile">
                            <Button size="icon" variant="ghost" className="w-8 h-8" tabIndex={-1} aria-hidden="true"><Github className="w-4 h-4" /></Button>
                          </a>
                        )}
                        {c.linkedinUrl && (
                          <a href={c.linkedinUrl.startsWith("http") ? c.linkedinUrl : `https://${c.linkedinUrl}`} target="_blank" rel="noopener noreferrer" aria-label="View LinkedIn profile">
                            <Button size="icon" variant="ghost" className="w-8 h-8" tabIndex={-1} aria-hidden="true"><Linkedin className="w-4 h-4" /></Button>
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* PDL Key notice */}
      {!connectors.pdl?.apiKey && (
        <div className="mt-4 p-4 rounded-xl border border-yellow-500/20 bg-yellow-500/5 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-yellow-400">PDL not connected</p>
            <p className="text-muted-foreground mt-0.5">Add your <code className="text-xs bg-white/10 px-1 rounded">PDL_API_KEY</code> environment variable to unlock People Data Labs (500M+ profiles). Your talent pool, GitHub and web search are active in the meantime.</p>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
