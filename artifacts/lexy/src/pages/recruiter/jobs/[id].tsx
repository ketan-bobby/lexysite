/**
 * pages/recruiter/jobs/[id].tsx — Job Detail & Pipeline Management
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The main workspace for a single open job. Lets the recruiter configure the
 * ICP, view pipeline board, run sourcing, trigger screening, launch outreach
 * campaigns, and manage interview scheduling — all from one page.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   Overview      — job details, status controls, analytics summary
 *   ICP           — view / edit / regenerate the Ideal Candidate Profile
 *   Pipeline      — Kanban-style board: candidate cards per pipeline stage
 *   Talent        — talent match scores for all matched candidates
 *   Sourcing      — trigger sourcing run, view sourced candidates
 *   Outreach      — active campaigns + enrollment stats
 *   Interviews    — scheduled sessions for this job
 *   Settings      — pipeline stage configuration, email templates, policies
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetJob()         — job row + metadata
 *   useGetJobIcp()      — ICP record for this job
 *   useGenerateIcp()    — POST /api/jobs/:id/icp (AI ICP generation)
 *   useListCandidates() — candidates filtered to this jobId
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/jobs/:id
 */
import { authHeaders } from "@/lib/api";
import { useState, useEffect, useRef } from "react";
import { useRoute, useSearch } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetJob,
  useGetJobIcp,
  getGetJobIcpQueryKey,
  useListCandidates,
  getListCandidatesQueryKey,
} from "@workspace/api-client-react";
import { LinxStatusBadge, EngageLinxDialog, useLinxRequest } from "@/components/linx/engage-linx";
import { Handshake as HandshakeIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MapPin,
  Briefcase,
  DollarSign,
  Calendar,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ArrowRight,
  Send,
  Brain,
  Zap,
  Link2,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  UserPlus,
  UploadCloud,
  FileText,
  X,
  Loader2,
  Ghost,
  RefreshCw,
  ShieldAlert,
  Activity,
  UserX,
  Mail,
  User,
  UserCog,
  Edit,
  Save,
  Share2,
  Radio,
  Globe,
  ChevronsUpDown,
  Check,
  Clock,
  Search,
  Hourglass,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COUNTRIES, getCitiesForCountry, getStatesForCountry } from "@/lib/countries-data";
import { formatDate, cn, pluralize } from "@/lib/utils";
import { ScoreBadge } from "@/components/ui-custom/Badges";
import JobFunnel from "@/components/jobs/JobFunnel";
import {
  ConnectionStrengthBadge,
  ConnectionStrengthPanel,
} from "@/components/ui-custom/ConnectionStrengthBadge";
import { Link } from "wouter";
import { useSourcingTrigger } from "@/lib/agent-runs";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  canApproveWorkOrder,
  isHmCreated,
  buildApprovePayload,
  ASSIGN_ON_APPROVE_ROLES,
} from "@/lib/work-order-approval";
import { IntelligencePanel } from "@/components/intelligence/IntelligencePanel";
import { RoleContextPanel } from "@/components/ai-intel/RoleContextPanel";
import { AgentPanel } from "@/components/agents/AgentPanel";
import { PipelinePanel } from "@/components/agents/PipelinePanel";
import { WorkflowCanvas } from "@/components/agents/WorkflowCanvas";
import { RunHistoryPanel } from "@/components/agents/RunHistoryPanel";
import { JobOutreachPanel } from "@/components/agents/JobOutreachDrafts";
import { ExecutiveJobView } from "@/components/intelligence/ExecutiveJobView";
import { CsvImportDialog } from "@/components/candidates/CsvImportDialog";
import { ShareAndEmbedPanel } from "@/components/jobs/ShareAndEmbedPanel";
import { copyToClipboard } from "@/lib/clipboard";
import { NurtureSequenceEditor } from "@/components/agents/NurtureSequenceEditor";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Authed JSON fetch helper (session cookie; DEV-only Bearer via authHeaders) for this page's API calls.
async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    ...opts,
  });
  if (!res.ok) {
    /* Surface the server's human-readable error (e.g. "candidate has opted
     * out of contact") instead of an opaque status code. */
    let message = `API ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON body — keep the status-code message */
    }
    throw new Error(message);
  }
  return res.json();
}

interface AntiGhostSummary {
  jobId: string;
  openAlerts: number;
  critical: number;
  high: number;
  medium: number;
  healthScore: number;
  byType: {
    interview_no_show: number;
    outreach_dropout: number;
    stale_pipeline: number;
    offer_limbo: number;
    interview_stale?: number;
  };
}

// Big numeric health readout for anti-ghost score with a colour-coded status label.
// Pipeline-health (anti-ghost) score bands — 4 tiers on their own cutoffs, not the match band.
const HEALTH_STRONG = 80,
  HEALTH_WATCH = 60,
  HEALTH_RISK = 40;
function HealthRing({ score }: { score: number }) {
  const color =
    score >= HEALTH_STRONG
      ? "text-green-400"
      : score >= HEALTH_WATCH
        ? "text-yellow-400"
        : score >= HEALTH_RISK
          ? "text-orange-400"
          : "text-red-400";
  const label =
    score >= HEALTH_STRONG
      ? "Healthy"
      : score >= HEALTH_WATCH
        ? "Watch"
        : score >= HEALTH_RISK
          ? "At Risk"
          : "Critical";
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`text-5xl font-bold tabular-nums ${color}`}>{score}</div>
      <div className="text-xs text-muted-foreground uppercase tracking-widest">/ 100</div>
      <Badge variant="outline" className={`text-xs ${color} border-current`}>
        {label}
      </Badge>
    </div>
  );
}

/* ── Platform Recommendations compact header button ─────────────────────── */
// Header toggle to enable/disable platform-pool candidate recommendations for the job.
function PlatformRecsHeaderButton({ job }: { job: any }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [toggling, setToggling] = useState(false);
  const enabled: boolean = !!job.platformRecommendationsEnabled;

  const toggle = async () => {
    setToggling(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${job.id}/platform-recommendations`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      await qc.invalidateQueries({ queryKey: [`/api/jobs/${job.id}`] });
      toast({
        title: !enabled ? "Platform recommendations enabled" : "Platform recommendations disabled",
        description: !enabled
          ? "Platform admins can now push candidates directly to this work order."
          : "This work order will no longer receive platform-recommended candidates.",
      });
    } catch {
      toast({
        title: "Failed to update",
        description: "Could not toggle platform recommendations.",
        variant: "destructive",
      });
    } finally {
      setToggling(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className={`hover-elevate gap-2 ${
        enabled
          ? "border-violet-500/40 text-violet-400 bg-violet-500/8 hover:bg-violet-500/15"
          : "border-border/60 text-muted-foreground hover:text-foreground"
      }`}
      onClick={toggle}
      disabled={toggling}
      title={
        enabled
          ? "Platform recommendations are ON — click to disable"
          : "Enable platform candidate recommendations for this work order"
      }
    >
      {toggling ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Radio className="w-3.5 h-3.5" />
      )}
      Platform Recs {enabled ? "On" : "Off"}
    </Button>
  );
}

/* ── Platform Recommendations Toggle Card ────────────────────────────────── */
// Full card variant of the platform-recommendations toggle with explanatory copy.
function PlatformRecommendationsCard({ job }: { job: any }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [toggling, setToggling] = useState(false);
  const enabled: boolean = !!job.platformRecommendationsEnabled;

  const toggle = async () => {
    setToggling(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${job.id}/platform-recommendations`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      await qc.invalidateQueries({ queryKey: [`/api/jobs/${job.id}`] });
      toast({
        title: !enabled ? "Platform recommendations enabled" : "Platform recommendations disabled",
        description: !enabled
          ? "Platform admins can now push candidates directly to this work order."
          : "This work order will no longer receive platform-recommended candidates.",
      });
    } catch {
      toast({
        title: "Failed to update",
        description: "Could not toggle platform recommendations.",
        variant: "destructive",
      });
    } finally {
      setToggling(false);
    }
  };

  return (
    <Card
      className={
        enabled ? "border-violet-500/30 bg-violet-500/5 shadow-sm" : "border-border/40 shadow-sm"
      }
    >
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${enabled ? "bg-violet-500/15 border border-violet-500/25" : "bg-muted/40 border border-border/40"}`}
          >
            <Radio className={`w-4 h-4 ${enabled ? "text-violet-400" : "text-muted-foreground"}`} />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground text-sm">
                Accept Platform Recommendations
              </span>
              {enabled && (
                <Badge className="text-[10px] px-2 py-0 h-4 bg-violet-500/15 text-violet-400 border border-violet-500/25">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
              When enabled, platform admins can push pre-vetted candidates from the platform pool
              directly into this work order's candidate list. Pushed candidates appear automatically
              — no sourcing action needed by your team.
            </p>
            {enabled && (
              <p className="text-[11px] text-violet-400 font-medium mt-1">
                ✓ This work order is visible to platform admins for candidate recommendations.
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant={enabled ? "outline" : "default"}
            className={
              enabled
                ? "shrink-0 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                : "shrink-0 bg-violet-600 hover:bg-violet-500 border-0 text-white"
            }
            disabled={toggling}
            onClick={toggle}
          >
            {toggling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : enabled ? (
              "Turn Off"
            ) : (
              "Enable"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// "Anti-ghosting" tab: surfaces stale-pipeline / no-show alerts and health for the job.
function AntiGhostTab({ jobId }: { jobId: string }) {
  const { toast } = useToast();

  const {
    data: summary,
    isLoading,
    refetch,
  } = useQuery<AntiGhostSummary>({
    queryKey: ["anti-ghost-job-summary", jobId],
    queryFn: () => apiFetch(`/ghosting/job/${jobId}/summary`),
    enabled: !!jobId,
    staleTime: 30_000,
  });

  const [scanning, setScanning] = useState(false);

  async function runScan() {
    setScanning(true);
    try {
      const result = await apiFetch<any>("/ghosting/scan", {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast({
        title: "Scan complete",
        description: `${result.total} new alert(s) detected for this tenant.`,
      });
      refetch();
    } catch {
      toast({
        title: "Scan failed",
        description: "Could not run detection scan.",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }

  if (isLoading) {
    return (
      <Card className="shadow-sm">
        <CardContent className="py-20 text-center">
          <div className="animate-spin w-10 h-10 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Anti-Ghost data…</p>
        </CardContent>
      </Card>
    );
  }

  const s = summary ?? {
    openAlerts: 0,
    critical: 0,
    high: 0,
    medium: 0,
    healthScore: 100,
    byType: {
      interview_no_show: 0,
      outreach_dropout: 0,
      stale_pipeline: 0,
      offer_limbo: 0,
      interview_stale: 0,
    },
  };

  const alertTypes = [
    { key: "interview_no_show", label: "No-Shows", icon: UserX, color: "text-red-400" },
    { key: "outreach_dropout", label: "Outreach Dropouts", icon: Mail, color: "text-orange-400" },
    { key: "stale_pipeline", label: "Stale Pipeline", icon: Activity, color: "text-yellow-400" },
    { key: "offer_limbo", label: "Offer Limbo", icon: ShieldAlert, color: "text-purple-400" },
    { key: "interview_stale", label: "Interview Stall", icon: Hourglass, color: "text-amber-400" },
  ] as const;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Ghost className="w-5 h-5 text-primary" /> Anti-Ghost Agent
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Monitors candidates in this work order for ghosting risk — no-shows, outreach dropouts,
            stale pipeline, and offer limbo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runScan}
            disabled={scanning}
            className="gap-1.5"
          >
            {scanning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {scanning ? "Scanning…" : "Run Scan"}
          </Button>
          <Link href={`/anti-ghost?jobId=${jobId}`}>
            <Button size="sm" className="gap-1.5 hover-elevate">
              <Ghost className="w-3.5 h-3.5" /> Open Dashboard
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="shadow-sm col-span-1 flex flex-col items-center justify-center py-6">
          <HealthRing score={s.healthScore} />
          <p className="text-xs text-muted-foreground mt-3">Pipeline Health</p>
        </Card>

        <Card className="shadow-sm col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Open Alerts — This Work Order
            </CardTitle>
          </CardHeader>
          <CardContent>
            {s.openAlerts === 0 ? (
              <div className="flex items-center gap-3 py-4 text-green-400">
                <CheckCircle2 className="w-8 h-8" />
                <div>
                  <p className="font-semibold">No open alerts</p>
                  <p className="text-sm text-muted-foreground">
                    All candidates in this role are engaged.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {alertTypes.map(({ key, label, icon: Icon, color }) => {
                  const count = s.byType[key] ?? 0;
                  return (
                    <div
                      key={key}
                      className={`flex items-center gap-3 p-3 rounded-lg border ${count > 0 ? "border-border bg-muted/30" : "border-transparent opacity-40"}`}
                    >
                      <Icon className={`w-5 h-5 ${color}`} />
                      <div>
                        <p className="text-lg font-bold tabular-nums">{count}</p>
                        <p className="text-xs text-muted-foreground">{label}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Severity strip */}
      {s.openAlerts > 0 && (
        <Card className="shadow-sm">
          <CardContent className="py-4 flex items-center gap-6">
            <p className="text-sm font-medium text-muted-foreground mr-2">Severity breakdown:</p>
            {s.critical > 0 && (
              <div className="flex items-center gap-1.5 text-red-400">
                <AlertCircle className="w-4 h-4" />
                <span className="font-bold">{s.critical}</span>
                <span className="text-xs">Critical</span>
              </div>
            )}
            {s.high > 0 && (
              <div className="flex items-center gap-1.5 text-orange-400">
                <AlertCircle className="w-4 h-4" />
                <span className="font-bold">{s.high}</span>
                <span className="text-xs">High</span>
              </div>
            )}
            {s.medium > 0 && (
              <div className="flex items-center gap-1.5 text-yellow-400">
                <AlertCircle className="w-4 h-4" />
                <span className="font-bold">{s.medium}</span>
                <span className="text-xs">Medium</span>
              </div>
            )}
            <div className="ml-auto">
              <Link href={`/anti-ghost?jobId=${jobId}`}>
                <Button variant="ghost" size="sm" className="gap-1 text-primary">
                  View all alerts <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nurture Sequence Editor */}
      <Card className="shadow-sm">
        <CardContent className="p-6">
          <NurtureSequenceEditor jobId={jobId} />
        </CardContent>
      </Card>
    </div>
  );
}

/* Editable chip sections of the AI Generated Profile. Mirrors the read-only
   sections in the ICP tab and the editable fields the PATCH route accepts. */
const ICP_EDIT_SECTIONS: { key: string; label: string; placeholder: string }[] = [
  { key: "alternateTitles", label: "Alternate Titles", placeholder: "Add an alternate title…" },
  { key: "requiredSkills", label: "Required Skills", placeholder: "Add a required skill…" },
  { key: "preferredSkills", label: "Preferred Skills", placeholder: "Add a preferred skill…" },
  {
    key: "requiredCertifications",
    label: "Certifications & Licenses",
    placeholder: "Add a certification…",
  },
  { key: "toolsAndSystems", label: "Tools & Systems", placeholder: "Add a tool or system…" },
  { key: "compliance", label: "Compliance & Regulatory", placeholder: "Add a requirement…" },
  { key: "negativeKeywords", label: "Negative Keywords", placeholder: "Add a keyword to exclude…" },
  { key: "disqualifiers", label: "Disqualifiers", placeholder: "Add a disqualifier…" },
];

// A single editable chip list: removable badges + an input to add more.
function EditableChipField({
  label,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  placeholder: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!items.some((i) => i.toLowerCase() === v.toLowerCase())) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div>
      <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {label}
      </h4>
      <div className="flex flex-wrap gap-2 mb-2">
        {items.length === 0 && (
          <span className="text-xs italic text-muted-foreground/70">None yet — add one below.</span>
        )}
        {items.map((it) => (
          <Badge key={it} variant="outline" className="px-2.5 py-1 text-sm gap-1.5">
            {it}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== it))}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${it}`}
              data-testid={`button-remove-chip-${it}`}
            >
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="h-8 text-sm"
          data-testid={`input-add-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="h-8 shrink-0">
          Add
        </Button>
      </div>
    </div>
  );
}

// Inline editor for the AI Generated Profile chip sections.
function EditableIcpForm({
  icp,
  jobId,
  onCancel,
  onSaved,
}: {
  icp: any;
  jobId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string[]>>(() => {
    const d: Record<string, string[]> = {};
    for (const s of ICP_EDIT_SECTIONS)
      d[s.key] = Array.isArray(icp?.[s.key]) ? [...icp[s.key]] : [];
    return d;
  });
  const [location, setLocation] = useState<string>(
    typeof icp?.location === "string" ? icp.location : "",
  );

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/icp`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ ...draft, location: location.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        throw new Error(body?.message || body?.error || `Failed to save (HTTP ${res.status})`);
      }
      toast({
        title: "Profile updated",
        description: "Your changes to the candidate profile were saved.",
      });
      onSaved();
    } catch (err: any) {
      toast({
        title: "Could not save changes",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-medium flex items-center gap-1.5">
          <MapPin className="w-4 h-4 text-muted-foreground" /> Target Location
        </label>
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. San Francisco Bay Area, or Remote (US)"
          data-testid="input-icp-location"
        />
        <p className="text-xs text-muted-foreground">
          Where candidates should be based. Candidates outside this area are still shown but
          flagged. Leave blank for no location preference.
        </p>
      </div>
      {ICP_EDIT_SECTIONS.map((s) => (
        <EditableChipField
          key={s.key}
          label={s.label}
          placeholder={s.placeholder}
          items={draft[s.key]}
          onChange={(next) => setDraft((d) => ({ ...d, [s.key]: next }))}
        />
      ))}
      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          data-testid="button-cancel-icp-edit"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={saving}
          className="gap-2"
          data-testid="button-save-icp-edit"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{" "}
          Save Changes
        </Button>
      </div>
    </div>
  );
}

// Job/work-order detail page: tabbed view (intelligence, pipeline, anti-ghost, etc.).
export default function JobDetail() {
  const [, params] = useRoute("/jobs/:id");
  const jobId = params?.id || "";
  const { trigger: triggerSourcing, isPending: sourcingPending } = useSourcingTrigger();
  const search = useSearch();
  const urlTab = new URLSearchParams(search).get("tab") || "intelligence";
  const [activeTab, setActiveTab] = useState(urlTab);
  const { user } = useAuth() as any;
  const { data: job, isLoading: jobLoading } = useGetJob(jobId);
  const {
    data: icp,
    isLoading: icpLoading,
    isRefetching: icpRefetching,
  } = useGetJobIcp(jobId, {
    query: {
      queryKey: getGetJobIcpQueryKey(jobId),
      refetchInterval: (query: any) => (!query.state.data ? 3000 : false),
      staleTime: 0,
    },
  });
  const [editingIcp, setEditingIcp] = useState(false);
  // Poll every 20s + refetch on tab focus so server-driven changes (email DNC quick-replies,
  // inbound webhook classifications, recruiter actions in another tab) reflect without a manual refresh.
  const { data: candidatesData } = useListCandidates(
    { jobId },
    {
      query: {
        queryKey: getListCandidatesQueryKey({ jobId }),
        refetchInterval: 20_000,
        refetchOnWindowFocus: true,
      },
    },
  );
  // Fetch pipeline stages to resolve sourced-candidate names for the intelligence panel
  // (intelligence records store raw serp_xxx IDs, not normalized UUIDs)
  const { data: pipelineStages } = useQuery({
    queryKey: ["pipeline-stages", jobId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/pipeline-stages`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch pipeline stages");
      return res.json();
    },
    staleTime: 0,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled: !!user && !!jobId,
  });
  /* Candidates already on the pipeline board (application or sourced row) —
   * used to swap the row's "Move to Pipeline" action for an "In Pipeline"
   * label. Board rows carry the candidate under `candidate.id` (normalized)
   * or `candidateId` (application rows). */
  const onBoardCandidateIds = (() => {
    const ids = new Set<string>();
    const stages = (pipelineStages as any)?.stages ?? {};
    for (const rows of Object.values(stages) as any[][]) {
      for (const row of rows ?? []) {
        if (row?.candidate?.id) ids.add(row.candidate.id);
        if (row?.candidateId) ids.add(row.candidateId);
      }
    }
    return ids;
  })();
  const [movingToPipeline, setMovingToPipeline] = useState<Record<string, boolean>>({});
  const moveToPipeline = async (candidate: any) => {
    if (!jobId || movingToPipeline[candidate.id]) return;
    setMovingToPipeline((prev) => ({ ...prev, [candidate.id]: true }));
    try {
      /* Manual placement: land the candidate in the Applied lane without
       * re-firing the create-time screening automation (they were already
       * screened when linked to this job). */
      await apiFetch("/applications", {
        method: "POST",
        body: JSON.stringify({
          jobId,
          candidateId: candidate.id,
          stage: "applied",
          skipAutomation: true,
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pipeline-stages", jobId] }),
        queryClient.invalidateQueries({ queryKey: getListCandidatesQueryKey({ jobId }) }),
      ]);
      toast({
        title: "Moved to pipeline",
        description: `${candidate.firstName} ${candidate.lastName} is now on the Pipeline board (Applied).`,
      });
    } catch (e: any) {
      toast({
        title: "Could not move to pipeline",
        description: e?.message ?? "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setMovingToPipeline((prev) => ({ ...prev, [candidate.id]: false }));
    }
  };
  // ── Close work order + outcome feedback dialog ───────────────────────
  const [closeLoading, setCloseLoading] = useState(false);
  const [closeResult, setCloseResult] = useState<{
    autoHired: { applicationId: string; candidateId: string; candidateName: string }[];
    outcomeEligible: { applicationId: string; candidateId: string; candidateName: string }[];
  } | null>(null);
  const [outcomeResponses, setOutcomeResponses] = useState<Record<string, boolean | "skip">>({});
  const [outcomeSubmitting, setOutcomeSubmitting] = useState<Record<string, boolean>>({});

  /* Engage LINX on an in-flight role. Button shows only when there is no
   * ACTIVE request (pending/accepted block; declined/filled/closed history
   * doesn't) — mirrors the server's one-active-per-job rule. */
  const [linxDialogOpen, setLinxDialogOpen] = useState(false);
  const { data: linxReqData } = useLinxRequest(jobId);
  const linxActive = ["pending", "accepted"].includes(linxReqData?.request?.status ?? "");

  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [addCandidateOpen, setAddCandidateOpen] = useState(false);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [dupWarning, setDupWarning] = useState<{ existing: any; matchedOn: string[] } | null>(null);
  const [emailMatch, setEmailMatch] = useState<{
    existing: any;
    proposedChanges: { field: string; label: string; from: any; to: any }[];
  } | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  /* Multi-recruiter roster — first id is the primary/lead. */
  const [reassignRecruiterIds, setReassignRecruiterIds] = useState<string[]>([]);
  const [reassignPickerOpen, setReassignPickerOpen] = useState(false);
  const [reassignHm, setReassignHm] = useState("");
  const [reassignSaving, setReassignSaving] = useState(false);

  // ── Edit Work Order dialog ───────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    title: "",
    department: "",
    clientWorkOrderNumber: "",
    // Structured location fields. The flat \`location\` string sent to the API
    // is derived from these on save (see handleEditSave).
    locationCountry: "",
    locationState: "",
    locationCity: "",
    workType: "hybrid",
    employmentType: "full_time",
    salaryMin: "",
    salaryMax: "",
    description: "",
    isConfidential: false,
  });
  // Open-state for the three location comboboxes (kept outside editForm so we
  // don't trigger a form-wide re-render when only a popover toggles).
  const [editCountryOpen, setEditCountryOpen] = useState(false);
  const [editStateOpen, setEditStateOpen] = useState(false);
  const [editCityOpen, setEditCityOpen] = useState(false);
  // Free-text search box inside the Edit-dialog City popover — same long-tail
  // handling as the Create form: any typed city (e.g. "San Ramon") can be
  // chosen via the "Use '…'" option even if it's not in countries-data.ts.
  const [editCityQuery, setEditCityQuery] = useState("");
  /**
   * Best-effort parser for an existing freeform job.location string.
   * Recognises the formats this app produces ("City, State, Country" /
   * "City, Country" / "State, Country") by matching the LAST segment against
   * a known country name and the next-to-last against that country's states.
   * If nothing matches, all three fields stay empty so the user can pick
   * fresh — the original string is lost only when they save.
   */
  const parseLocation = (raw: string | null | undefined) => {
    const empty = { country: "", state: "", city: "" };
    if (!raw) return empty;
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return empty;
    const last = parts[parts.length - 1].toLowerCase();
    const country = COUNTRIES.find((c) => c.name.toLowerCase() === last);
    if (!country) return empty;
    if (parts.length === 1) return { country: country.name, state: "", city: "" };
    const states = country.states ?? [];
    if (parts.length >= 2) {
      const maybeState = parts[parts.length - 2].toLowerCase();
      const stateMatch = states.find((s) => s.name.toLowerCase() === maybeState);
      if (stateMatch) {
        const city = parts.slice(0, parts.length - 2).join(", ");
        return { country: country.name, state: stateMatch.name, city };
      }
    }
    // No state match — treat everything before the country as the city.
    const city = parts.slice(0, parts.length - 1).join(", ");
    return { country: country.name, state: "", city };
  };
  const openEditDialog = () => {
    if (!job) return;
    const parsed = parseLocation(job.location);
    setEditForm({
      title: job.title ?? "",
      department: job.department ?? "",
      clientWorkOrderNumber: job.clientWorkOrderNumber ?? "",
      locationCountry: parsed.country,
      locationState: parsed.state,
      locationCity: parsed.city,
      workType: job.workType ?? "hybrid",
      employmentType: job.employmentType ?? "full_time",
      salaryMin: job.salaryMin != null ? String(job.salaryMin) : "",
      salaryMax: job.salaryMax != null ? String(job.salaryMax) : "",
      description: job.description ?? "",
      isConfidential: !!job.isConfidential,
    });
    setEditOpen(true);
  };
  const handleEditSave = async () => {
    if (!editForm.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          title: editForm.title.trim(),
          department: editForm.department.trim() || null,
          clientWorkOrderNumber: editForm.clientWorkOrderNumber.trim() || null,
          location:
            [editForm.locationCity, editForm.locationState, editForm.locationCountry]
              .filter(Boolean)
              .join(", ") || null,
          workType: editForm.workType,
          employmentType: editForm.employmentType,
          salaryMin: editForm.salaryMin ? Number(editForm.salaryMin) : null,
          salaryMax: editForm.salaryMax ? Number(editForm.salaryMax) : null,
          description: editForm.description,
          isConfidential: editForm.isConfidential,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save");
      }
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      toast({ title: "Work order updated", description: "Your changes have been saved." });
      setEditOpen(false);
    } catch (e: any) {
      toast({
        title: "Could not save",
        description: e.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setEditSaving(false);
    }
  };

  // ── Approval flow state ────────────────────────────────────────────────
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  // TA "Approve & Assign Recruiter" dialog
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  /* Multi-recruiter roster assigned at approval — first id is the lead. */
  const [approveRecruiterIds, setApproveRecruiterIds] = useState<string[]>([]);
  const [approvePickerOpen, setApprovePickerOpen] = useState(false);

  // Is this a hiring-manager-initiated work order?
  const isHmCreatedJob = isHmCreated(job);
  // Candidate actions (add/import/source/outreach) are blocked until a work
  // order is approved. Mirrors the backend job-approval gate (PRE_APPROVAL_JOB_STATUSES).
  const jobApproved = !!job && !["draft", "pending_approval", "rejected"].includes(job.status);
  /* Can this user action the approval? Pure logic lives in
     @/lib/work-order-approval (unit-tested); mirrors the backend approve route:
     recruiter_admin may approve WOs in their data scope (self-approval is
     still blocked server-side). */
  const canApprove = canApproveWorkOrder(job, user);

  const handleSubmitForApproval = async () => {
    setApprovalLoading(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/submit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      const msg =
        user?.role === "hiring_manager"
          ? "Your work order has been sent to the Tenant Admin for review."
          : "The hiring manager will be notified to review this work order.";
      toast({ title: "Submitted for approval", description: msg });
    } catch (e: any) {
      toast({ title: "Could not submit", description: e.message, variant: "destructive" });
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleApprove = async (recruiterIds?: string[]) => {
    setApprovalLoading(true);
    const roster = (recruiterIds ?? []).filter(Boolean);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/approve`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(buildApprovePayload(roster)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      setApproveDialogOpen(false);
      const desc = roster.length
        ? `Work order is now active and ${pluralize(roster.length, "recruiter")} ${roster.length === 1 ? "has" : "have"} been assigned.`
        : "The work order is now active and open for sourcing.";
      toast({ title: "Work order approved", description: desc });
    } catch (e: any) {
      toast({ title: "Could not approve", description: e.message, variant: "destructive" });
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleCloseWorkOrder = async () => {
    setCloseLoading(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/close`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      if (json.autoHired?.length > 0) {
        toast({
          title: `${pluralize(json.autoHired.length, "candidate")} auto-marked as hired`,
          description: "Candidates with in-flight offers were automatically advanced to Hired.",
        });
      }
      if (json.outcomeEligible?.length > 0) {
        setCloseResult(json);
        setOutcomeResponses({});
      } else {
        toast({ title: "Work order closed", description: "The role has been closed." });
      }
    } catch (e: any) {
      toast({
        title: "Could not close work order",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setCloseLoading(false);
    }
  };

  const handleReopenWorkOrder = async () => {
    setCloseLoading(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/reopen`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      toast({ title: "Work order reopened", description: "The role is now active again." });
    } catch (e: any) {
      toast({ title: "Could not reopen", description: e.message, variant: "destructive" });
    } finally {
      setCloseLoading(false);
    }
  };

  const handleRoleOutcome = async (applicationId: string, succeeded: boolean) => {
    setOutcomeSubmitting((prev) => ({ ...prev, [applicationId]: true }));
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/role-outcome`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ applicationId, succeeded }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setOutcomeResponses((prev) => ({ ...prev, [applicationId]: succeeded }));
    } catch (e: any) {
      toast({ title: "Could not save outcome", description: e.message, variant: "destructive" });
    } finally {
      setOutcomeSubmitting((prev) => ({ ...prev, [applicationId]: false }));
    }
  };

  const handlePublishToCareerSite = async (unpublish = false) => {
    setApprovalLoading(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/publish`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(unpublish ? { unpublish: true } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      toast({
        title: unpublish ? "Removed from career site" : "Published to career site",
        description: unpublish
          ? "This work order is no longer visible on the public career page."
          : "Candidates can now find and apply for this role on the career site.",
      });
    } catch (e: any) {
      toast({
        title: unpublish ? "Could not unpublish" : "Could not publish",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setApprovalLoading(false);
    }
  };

  const handleReject = async () => {
    setApprovalLoading(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}/reject`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ note: rejectNote }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      const who = isHmCreatedJob ? "The hiring manager" : "The recruiter";
      toast({
        title: "Returned for revision",
        description: `${who} will see your feedback and can resubmit.`,
      });
      setRejectOpen(false);
      setRejectNote("");
    } catch (e: any) {
      toast({ title: "Could not reject", description: e.message, variant: "destructive" });
    } finally {
      setApprovalLoading(false);
    }
  };

  // Load tenant members for reassignment (only when dialog opens).
  // Fetch from the LOGGED-IN user's own agency (their tenantId) — NOT the job's
  // tenantId, because job.tenantId is the client company the WO is for.
  // Platform admins fall back to the job's tenantId.
  const teamTenantId =
    user?.role === "platform_admin" ? job?.tenantId || null : user?.tenantId || null;
  const { data: membersData } = useQuery({
    queryKey: ["tenant-members-reassign", teamTenantId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${teamTenantId}/members`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && !!teamTenantId && (reassignOpen || approveDialogOpen),
    staleTime: 60_000,
  });
  // Endpoint returns a raw array of members
  const members: any[] = Array.isArray(membersData) ? membersData : [];
  const recruiters = members.filter((m: any) => m.role === "recruiter");
  const hiringManagers = members.filter((m: any) => m.role === "hiring_manager");

  const handleReassignOpen = () => {
    /* Seed from the full roster (primary first); fall back to the single
       primary assignment on older payloads. */
    const rosterFromApi = (job as any)?.assignedRecruiterIds;
    const roster: string[] =
      Array.isArray(rosterFromApi) && rosterFromApi.length
        ? rosterFromApi
        : job?.assignedRecruiterId
          ? [job.assignedRecruiterId]
          : [];
    const ordered = job?.assignedRecruiterId
      ? [job.assignedRecruiterId, ...roster.filter((id: string) => id !== job.assignedRecruiterId)]
      : roster;
    setReassignRecruiterIds(ordered);
    setReassignHm(job?.assignedHiringManagerId ?? "none");
    setReassignOpen(true);
  };

  const handleReassignSave = async () => {
    setReassignSaving(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/${jobId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          assignedRecruiterId: reassignRecruiterIds[0] ?? null,
          assignedRecruiterIds: reassignRecruiterIds,
          assignedHiringManagerId: reassignHm && reassignHm !== "none" ? reassignHm : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save");
      }
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
      toast({ title: "Team updated", description: "Assignment saved successfully." });
      setReassignOpen(false);
    } catch {
      toast({
        title: "Error",
        description: "Could not update assignment.",
        variant: "destructive",
      });
    } finally {
      setReassignSaving(false);
    }
  };
  const [addForm, setAddForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    location: "",
    currentTitle: "",
    currentCompany: "",
    linkedinUrl: "",
    githubUrl: "",
  });
  const [addSaving, setAddSaving] = useState(false);
  const [cvParsing, setCvParsing] = useState(false);
  const [cvFileName, setCvFileName] = useState<string | null>(null);
  const [cvObjectPath, setCvObjectPath] = useState<string | null>(null);
  const [cvDragging, setCvDragging] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(search).get("tab");
    if (t) setActiveTab(t);
  }, [search]);

  // Deep-link from a work-order card's "Unassigned" chip: ?assign=1 opens the
  // assignment dialog once the job has loaded.
  useEffect(() => {
    if (!job) return;
    if (new URLSearchParams(search).get("assign") === "1") handleReassignOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, job?.id]);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  /* ICP regeneration is async on the server (POST returns 202, work runs in
   * the background, GET /icp/status reports progress). The proxy used to
   * cut us off at ~60s with a 504; polling avoids long-lived requests.
   *
   * Lifecycle: a regeneration started on this page should not surface a
   * toast or flip state on a different page after the user navigates away.
   * regenAbortRef carries an AbortController whose `.aborted` flag short-
   * circuits the poll loop on unmount. The background work on the server
   * continues regardless — the next visit will see the new ICP version. */
  const [isRegenerating, setIsRegenerating] = useState(false);
  const regenAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      regenAbortRef.current?.abort();
    };
  }, []);

  const handleGenerateIcp = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!jobId) {
      toast({
        title: "No job ID",
        description: "Cannot regenerate — job ID missing from URL.",
        variant: "destructive",
      });
      return;
    }
    if (isRegenerating) return;

    const abort = new AbortController();
    regenAbortRef.current?.abort();
    regenAbortRef.current = abort;
    setIsRegenerating(true);

    try {
      // Kick off generation. The server returns 202 almost immediately with
      // {status, previousVersion, startedAt}. We use previousVersion to
      // distinguish "background work completed" from "server lost track of
      // the job" (e.g. api-server restart between POST and first poll).
      const startResp = await fetch(`${BASE}/api/jobs/${jobId}/icp`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({}),
        signal: abort.signal,
      });
      if (!startResp.ok && startResp.status !== 202) {
        const body = await startResp.json().catch(() => ({}));
        throw new Error(
          body?.message || body?.error || `Failed to start generation (HTTP ${startResp.status})`,
        );
      }
      const startBody = await startResp.json().catch(() => ({}) as any);
      const previousVersion: number =
        typeof startBody?.previousVersion === "number" ? startBody.previousVersion : 0;

      // Poll until status === 'failed' OR ('idle' AND currentVersion advanced
      // past previousVersion). Cap at 5 minutes so a stuck job never spins
      // forever. Bail immediately if the page unmounted.
      const POLL_MS = 2500;
      const TIMEOUT_MS = 5 * 60_000;
      const startedAt = Date.now();
      let finalStatus: { status: string; error?: string; currentVersion?: number } | null = null;

      while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (abort.signal.aborted) return;
        const s = await apiFetch<{ status: string; error?: string; currentVersion?: number }>(
          `/jobs/${jobId}/icp/status`,
          { signal: abort.signal },
        );
        if (s.status === "failed") {
          finalStatus = s;
          break;
        }
        if (s.status === "idle") {
          // Only treat 'idle' as success if a new version actually landed.
          // If the version is unchanged, the server probably lost its
          // in-memory tracking (process restart); surface a recoverable
          // error instead of falsely toasting success.
          if (typeof s.currentVersion === "number" && s.currentVersion > previousVersion) {
            finalStatus = s;
            break;
          }
          throw new Error(
            "Generation status was lost (the server may have restarted). Please try again.",
          );
        }
      }

      if (abort.signal.aborted) return;
      if (!finalStatus) {
        throw new Error(
          "Generation is taking longer than expected. Refresh the page in a moment to see the result.",
        );
      }
      if (finalStatus.status === "failed") {
        throw new Error(finalStatus.error || "Generation failed. Please try again.");
      }
      await queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}/icp`] });
      toast({
        title: "ICP Generated Successfully",
        description: "AI has extracted the ideal candidate profile.",
      });
    } catch (err: any) {
      if (abort.signal.aborted || err?.name === "AbortError") return;
      console.error("[ICP regenerate] failed", err);
      const raw = err?.message || "Something went wrong. Please try again.";
      const clean = String(raw)
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const description = clean.length > 240 ? clean.slice(0, 240) + "…" : clean;
      toast({
        title: "Could not regenerate ICP",
        description: description || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      if (!abort.signal.aborted) setIsRegenerating(false);
    }
  };

  const submitCandidate = async (confirmDuplicate: boolean, mergeIntoExisting = false) => {
    const res = await fetch(`${BASE}/api/candidates`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        ...addForm,
        jobId,
        resumeObjectPath: cvObjectPath ?? undefined,
        confirmDuplicate,
        mergeIntoExisting,
      }),
    });
    return res;
  };

  const finishAddCandidateSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
    toast({
      title: "Candidate Added",
      description: `${addForm.firstName} ${addForm.lastName} has been added to this role.`,
    });
    setAddForm({
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      location: "",
      currentTitle: "",
      currentCompany: "",
      linkedinUrl: "",
      githubUrl: "",
    });
    setCvFileName(null);
    setCvObjectPath(null);
    setAddCandidateOpen(false);
    setDupWarning(null);
    setEmailMatch(null);
  };

  const handleAddCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.firstName.trim() || !addForm.lastName.trim()) return;
    setAddSaving(true);
    try {
      const res = await submitCandidate(false);
      if (res.status === 409) {
        const d = await res.json().catch(() => ({}));
        if (d.reason === "potential_duplicate" && d.existing) {
          // Soft duplicate — show confirm dialog so the recruiter can override.
          setDupWarning({
            existing: d.existing,
            matchedOn: Array.isArray(d.matchedOn) ? d.matchedOn : [],
          });
          setAddSaving(false);
          return;
        }
        if (d.reason === "email_match" && d.existing) {
          // Same email already on file — offer to merge the newer info into the
          // existing record rather than creating a second row.
          setEmailMatch({
            existing: d.existing,
            proposedChanges: Array.isArray(d.proposedChanges) ? d.proposedChanges : [],
          });
          setAddSaving(false);
          return;
        }
        const existing = d.existing;
        const name = existing ? `${existing.firstName} ${existing.lastName}` : addForm.email;
        toast({
          title: "Candidate Already Exists",
          description: `${name} is already in the system. No duplicate was created.`,
          variant: "destructive",
        });
        setAddSaving(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to add candidate");
      await finishAddCandidateSuccess();
    } catch {
      toast({
        title: "Error",
        description: "Could not add candidate. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAddSaving(false);
    }
  };

  const confirmAddDuplicate = async () => {
    setAddSaving(true);
    try {
      const res = await submitCandidate(true);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({
          title: "Could not add candidate",
          description: d?.error || "Please try again.",
          variant: "destructive",
        });
        setAddSaving(false);
        return;
      }
      await finishAddCandidateSuccess();
    } catch {
      toast({
        title: "Error",
        description: "Could not add candidate. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAddSaving(false);
    }
  };

  const confirmMergeEmail = async () => {
    setAddSaving(true);
    try {
      const res = await submitCandidate(false, true);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({
          title: "Could not update candidate",
          description: d?.error || "Please try again.",
          variant: "destructive",
        });
        setAddSaving(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/candidates"] });
      toast({
        title: "Candidate Updated",
        description: `${addForm.firstName} ${addForm.lastName}'s record was updated with the newer info and added to this role.`,
      });
      setAddForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        location: "",
        currentTitle: "",
        currentCompany: "",
        linkedinUrl: "",
        githubUrl: "",
      });
      setCvFileName(null);
      setCvObjectPath(null);
      setAddCandidateOpen(false);
      setEmailMatch(null);
    } catch {
      toast({
        title: "Error",
        description: "Could not update candidate. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAddSaving(false);
    }
  };

  const handleCvFile = async (file: File) => {
    if (!file) return;
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];
    const ext = file.name.toLowerCase();
    if (
      !allowed.includes(file.type) &&
      !ext.endsWith(".pdf") &&
      !ext.endsWith(".docx") &&
      !ext.endsWith(".doc")
    ) {
      toast({
        title: "Unsupported file",
        description: "Please upload a PDF or Word document.",
        variant: "destructive",
      });
      return;
    }
    setCvParsing(true);
    setCvFileName(file.name);
    setCvObjectPath(null);
    try {
      const parseFd = new FormData();
      parseFd.append("cv", file);
      const uploadFd = new FormData();
      uploadFd.append("file", file);

      const [parseRes, uploadRes] = await Promise.all([
        fetch(`${BASE}/api/candidates/parse-cv`, {
          method: "POST",
          credentials: "include",
          headers: { ...authHeaders() },
          body: parseFd,
        }),
        fetch(`${BASE}/api/storage/uploads/file`, {
          method: "POST",
          credentials: "include",
          headers: { ...authHeaders() },
          body: uploadFd,
        }),
      ]);

      if (!parseRes.ok) {
        const err = await parseRes.json().catch(() => ({}));
        throw new Error(err.error || "Parsing failed");
      }
      if (uploadRes.ok) {
        const upBody = await uploadRes.json().catch(() => ({}));
        if (upBody?.objectPath) setCvObjectPath(upBody.objectPath);
      } else {
        toast({
          title: "Resume not saved",
          description:
            "CV was parsed for auto-fill but the file couldn't be stored. Use 'Upload Resume' on the candidate profile after adding.",
          variant: "destructive",
        });
      }
      const data = await parseRes.json();
      setAddForm((f) => ({
        firstName: data.firstName || f.firstName,
        lastName: data.lastName || f.lastName,
        email: data.email || f.email,
        phone: data.phone || f.phone,
        location: data.location || f.location,
        currentTitle: data.currentTitle || f.currentTitle,
        currentCompany: data.currentCompany || f.currentCompany,
        linkedinUrl: data.linkedinUrl || f.linkedinUrl,
        githubUrl: data.githubUrl || f.githubUrl,
      }));
      toast({
        title: "CV Parsed",
        description: `Extracted details for ${data.firstName ?? ""} ${data.lastName ?? ""}. Review and confirm.`,
      });
    } catch (err: any) {
      toast({
        title: "Parse Error",
        description: err.message || "Could not read this CV.",
        variant: "destructive",
      });
      setCvFileName(null);
      setCvObjectPath(null);
    } finally {
      setCvParsing(false);
    }
  };

  if (jobLoading)
    return (
      <AppLayout>
        <div className="p-8 text-center">Loading work order...</div>
      </AppLayout>
    );
  if (!job)
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold mb-2">Work Order Not Found</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              This job may have been deleted or you may not have access to it.
            </p>
          </div>
          <Link href="/jobs">
            <Button className="gap-2">
              <Briefcase className="w-4 h-4" /> Back to Work Orders
            </Button>
          </Link>
        </div>
      </AppLayout>
    );

  // Build a combined name map: normalized candidates + sourced candidates (by their raw serp_xxx / gh_xxx IDs)
  const normalizedList =
    candidatesData?.candidates?.map((c: any) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
    })) ?? [];
  const sourcedList: Array<{ id: string; firstName: string; lastName: string }> = [];
  if (pipelineStages?.stages) {
    const allRows: any[] = Object.values(pipelineStages.stages).flat();
    for (const row of allRows) {
      const cand = row.candidate;
      if (row.sourcedId && cand?.id && cand.firstName && cand.firstName !== "Unknown") {
        // The raw sourced id (e.g. serp_xxx) is stored as normalized_candidate_id on the sourced record.
        // Intelligence records use that same raw id as their candidateId — add both forms.
        sourcedList.push({
          id: row.sourcedId,
          firstName: cand.firstName,
          lastName: cand.lastName || "",
        });
        if (cand.id !== row.sourcedId) {
          sourcedList.push({
            id: cand.id,
            firstName: cand.firstName,
            lastName: cand.lastName || "",
          });
        }
      }
    }
  }
  const candidatesList = [...normalizedList, ...sourcedList];

  return (
    <AppLayout>
      <div className="mb-6">
        <Link
          href="/jobs"
          className="text-sm text-muted-foreground hover:text-primary mb-4 inline-flex items-center gap-1"
        >
          <ArrowRight className="w-4 h-4 rotate-180" /> Back to Work Orders
        </Link>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mt-2">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="page-title">{job.title}</h1>
              <Badge
                variant="outline"
                className={`capitalize ${
                  job.status === "published"
                    ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/25"
                    : job.status === "active"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                      : job.status === "pending_approval"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/25"
                        : job.status === "draft"
                          ? "bg-slate-500/10 text-slate-400 border-slate-500/25"
                          : job.status === "closed"
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/25"
                            : "bg-muted text-muted-foreground"
                }`}
              >
                {job.status === "pending_approval" ? "Pending Approval" : job.status}
              </Badge>
              <LinxStatusBadge jobId={job.id} />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mt-2">
              <span className="flex items-center gap-1.5">
                <Briefcase className="w-4 h-4" /> {job.department || "No department"}
              </span>
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4" /> {job.location || "Remote"} ({job.workType})
              </span>
              <span className="flex items-center gap-1.5">
                <DollarSign className="w-4 h-4" />{" "}
                {job.salaryMin
                  ? `${job.salaryMin / 1000}k - ${(job.salaryMax ?? job.salaryMin) / 1000}k`
                  : "Not specified"}
              </span>
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" /> Created {formatDate(job.createdAt)}
              </span>
              {job.clientWorkOrderNumber && (
                <span className="flex items-center gap-1.5">
                  <FileText className="w-4 h-4" /> Client WO #{job.clientWorkOrderNumber}
                </span>
              )}
            </div>
            {/* Assignment pills row */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Team:
              </span>
              {Array.isArray((job as any).assignedRecruiters) &&
              (job as any).assignedRecruiters.length > 0 ? (
                ((job as any).assignedRecruiters as any[]).map((r: any, idx: number) => (
                  <Badge
                    key={r.id}
                    variant="outline"
                    className="gap-1.5 text-xs bg-blue-500/8 border-blue-500/25 text-blue-400"
                  >
                    <User className="w-3 h-3" />{" "}
                    {r.id === job.assignedRecruiterId || (idx === 0 && !job.assignedRecruiterId)
                      ? "Lead Recruiter"
                      : "Recruiter"}
                    : {r.name ?? "Unknown"}
                  </Badge>
                ))
              ) : job.assignedRecruiterName ? (
                <Badge
                  variant="outline"
                  className="gap-1.5 text-xs bg-blue-500/8 border-blue-500/25 text-blue-400"
                >
                  <User className="w-3 h-3" /> Recruiter: {job.assignedRecruiterName}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 text-xs text-muted-foreground border-dashed"
                >
                  <User className="w-3 h-3" /> No Recruiter
                </Badge>
              )}
              {job.assignedHiringManagerName ? (
                <Badge
                  variant="outline"
                  className="gap-1.5 text-xs bg-violet-500/8 border-violet-500/25 text-violet-400"
                >
                  <UserCog className="w-3 h-3" /> Hiring Manager: {job.assignedHiringManagerName}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 text-xs text-muted-foreground border-dashed"
                >
                  <UserCog className="w-3 h-3" /> No Hiring Manager
                </Badge>
              )}
              {["platform_admin", "tenant_admin", "recruiter_admin"].includes(user?.role) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                  onClick={handleReassignOpen}
                >
                  <Edit className="w-3 h-3" /> Reassign
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {/* ── Sourcing ────────────────────────────────────────────── */}
            {/* Kicks off an agent run and opens its live feed. Only offered on
                approved/live roles — sourcing creates candidate records. */}
            {["active", "published"].includes(job.status) && (
              <Button
                className="hover-elevate gap-2"
                onClick={() => triggerSourcing(job.id)}
                disabled={sourcingPending}
              >
                {sourcingPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Source Candidates
              </Button>
            )}

            {/* ── Engage LINX ─────────────────────────────────────────── */}
            {/* Cross-tenant help request; job metadata + contact only, never
                candidate data. Hidden while a request is pending/accepted. */}
            {["active", "published", "paused"].includes(job.status) && !linxActive && (
              <Button
                variant="outline"
                className="hover-elevate gap-2 border-primary/40 text-primary hover:bg-primary/10"
                onClick={() => setLinxDialogOpen(true)}
                data-testid="button-engage-linx-job-detail"
              >
                <HandshakeIcon className="w-4 h-4" />
                Engage LINX
              </Button>
            )}

            {/* ── Approval flow actions ───────────────────────────────── */}

            {/* Close / Reopen work order */}
            {["active", "published", "paused"].includes(job.status) && (
              <Button
                variant="outline"
                className="hover-elevate gap-2 border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                onClick={handleCloseWorkOrder}
                disabled={closeLoading}
              >
                {closeLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <X className="w-4 h-4" />
                )}
                Close Role
              </Button>
            )}
            {job.status === "closed" && (
              <Button
                variant="outline"
                className="hover-elevate gap-2 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                onClick={handleReopenWorkOrder}
                disabled={closeLoading}
              >
                {closeLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Reopen Role
              </Button>
            )}

            {/* Publish / Unpublish to career site */}
            {job.status === "active" && (
              <Button
                variant="outline"
                className="hover-elevate gap-2 border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10"
                onClick={() => handlePublishToCareerSite(false)}
                disabled={approvalLoading}
              >
                {approvalLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                Post to Career Site
              </Button>
            )}
            {job.status === "published" && (
              <Button
                variant="outline"
                className="hover-elevate gap-2 border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                onClick={() => handlePublishToCareerSite(true)}
                disabled={approvalLoading}
              >
                {approvalLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                Remove from Career Site
              </Button>
            )}

            {/* HM submitting their own requisition to Tenant Admin */}
            {["draft", "active"].includes(job.status) &&
              user?.role === "hiring_manager" &&
              job.createdById === user?.id && (
                <Button
                  variant="outline"
                  className="hover-elevate gap-2 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                  onClick={handleSubmitForApproval}
                  disabled={approvalLoading}
                >
                  {approvalLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Submit to Tenant Admin
                </Button>
              )}

            {/* Recruiter / admin: submit for HM approval */}
            {["draft", "active"].includes(job.status) &&
              ["recruiter", "tenant_admin", "platform_admin"].includes(user?.role) &&
              job.assignedHiringManagerId && (
                <Button
                  variant="outline"
                  className="hover-elevate gap-2 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                  onClick={handleSubmitForApproval}
                  disabled={approvalLoading}
                >
                  {approvalLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Submit for Approval
                </Button>
              )}

            {/* Approval/return buttons — shown only if this user can act */}
            {canApprove && (
              <>
                {/* Tenant admin approving HM-created job → must pick a recruiter */}
                {isHmCreatedJob && ASSIGN_ON_APPROVE_ROLES.includes(user?.role) ? (
                  <Button
                    className="hover-elevate gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => {
                      setApproveRecruiterIds([]);
                      setApproveDialogOpen(true);
                    }}
                    disabled={approvalLoading}
                  >
                    <CheckCircle2 className="w-4 h-4" /> Approve & Assign Recruiters
                  </Button>
                ) : (
                  <Button
                    className="hover-elevate gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => handleApprove()}
                    disabled={approvalLoading}
                  >
                    {approvalLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    Approve
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="hover-elevate gap-2 border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                  onClick={() => setRejectOpen(true)}
                  disabled={approvalLoading}
                >
                  <X className="w-4 h-4" /> Return for Revision
                </Button>
              </>
            )}
            {/* Platform Recommendations inline toggle */}
            <PlatformRecsHeaderButton job={job} />

            {/* Standard actions */}
            <Button variant="outline" className="hover-elevate gap-2" onClick={openEditDialog}>
              <Edit className="w-4 h-4" /> Edit Work Order
            </Button>
            {(() => {
              const isLive = job.status === "published";
              const disabledTitle =
                "Post this work order to the career site first to get a public link";
              return (
                <>
                  <Button
                    variant="default"
                    className="hover-elevate gap-2"
                    title={isLive ? "Copy public job URL to clipboard" : disabledTitle}
                    onClick={async () => {
                      if (!isLive) {
                        toast({
                          title: "Not on the career site yet",
                          description:
                            'Click "Post to Career Site" first, then you can share the public link.',
                        });
                        return;
                      }
                      const url = `${window.location.origin}${BASE}/careers/${jobId}`;
                      const ok = await copyToClipboard(url);
                      if (ok) {
                        toast({
                          title: "Link copied!",
                          description: "Public job URL copied to clipboard.",
                        });
                      } else {
                        // Clipboard API can be blocked (e.g. inside the preview iframe) —
                        // surface the URL so it can always be copied manually.
                        toast({ title: "Copy this link", description: url });
                        window.prompt("Copy this public job link:", url);
                      }
                    }}
                  >
                    <Link2 className="w-4 h-4" /> Share Link
                  </Button>
                  {isLive ? (
                    <Button variant="outline" size="icon" className="hover-elevate" asChild>
                      <a
                        href={`${BASE}/careers/${jobId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open public job page"
                        aria-label="Open public job page"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="icon"
                      disabled
                      title={disabledTitle}
                      aria-label="Open public job page"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ── Approval status banners ─────────────────────────────────────── */}
      {job.status === "pending_approval" &&
        (() => {
          const submittedTo = isHmCreatedJob
            ? "the Tenant Admin"
            : (job.assignedHiringManagerName ?? "the hiring manager");
          const actionNote = canApprove
            ? " Use the Approve / Return for Revision buttons above to action it."
            : " You will be notified once it is approved or returned.";
          return (
            <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-4 py-3">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-sm">
                <p className="font-semibold text-amber-400">
                  {isHmCreatedJob
                    ? "Awaiting Tenant Admin approval"
                    : "Awaiting hiring manager approval"}
                </p>
                <p className="text-muted-foreground text-xs mt-0.5">
                  This work order has been submitted to <strong>{submittedTo}</strong> for review.
                  {actionNote}
                </p>
              </div>
            </div>
          );
        })()}
      {job.status === "draft" && job.rejectionNote && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3">
          <ShieldAlert className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold text-rose-400">
              Returned for revision by {isHmCreatedJob ? "Tenant Admin" : "hiring manager"}
            </p>
            <p className="text-muted-foreground text-xs mt-1 italic">"{job.rejectionNote}"</p>
            {isHmCreatedJob
              ? user?.role === "hiring_manager" && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Update the work order and click <strong>Submit to Tenant Admin</strong> to
                    resubmit.
                  </p>
                )
              : ["recruiter", "tenant_admin", "platform_admin"].includes(user?.role) &&
                job.assignedHiringManagerId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Update the work order and click <strong>Submit for Approval</strong> to
                    resubmit.
                  </p>
                )}
          </div>
        </div>
      )}
      {job.status === "active" && job.approvedById && (
        <div className="mb-5 flex items-center gap-2 text-xs text-emerald-400/80">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Approved and active
          {job.assignedRecruiterName && (
            <span className="text-muted-foreground">· Recruiter: {job.assignedRecruiterName}</span>
          )}
        </div>
      )}

      {/* ── Reject dialog ───────────────────────────────────────────────── */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Return for Revision</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {isHmCreatedJob
                ? "The hiring manager will see this note and can revise then resubmit to you."
                : "The recruiter will see this note alongside the work order and can address your feedback before resubmitting."}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reject-note">Feedback (optional)</Label>
              <textarea
                id="reject-note"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                rows={3}
                placeholder="e.g. Salary range needs adjustment, or please add the skills section…"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectOpen(false)}
              disabled={approvalLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={approvalLoading}
              className="gap-2"
            >
              {approvalLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <X className="w-4 h-4" />
              )}
              Return for Revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Role Outcome Feedback dialog ────────────────────────────────── */}
      <Dialog
        open={!!closeResult}
        onOpenChange={(open) => {
          if (!open) setCloseResult(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-violet-400" />
              Help improve Lexy's intelligence
            </DialogTitle>
            <p className="text-sm text-muted-foreground pt-1">
              Did this candidate succeed in the role? One click — this trains Lexy to make better
              recommendations.
            </p>
          </DialogHeader>
          <div className="space-y-3 py-1">
            {closeResult?.outcomeEligible.map((c) => {
              const responded = outcomeResponses[c.applicationId];
              const submitting = outcomeSubmitting[c.applicationId];
              const isAutoHired = closeResult.autoHired.some(
                (a) => a.applicationId === c.applicationId,
              );
              return (
                <div
                  key={c.applicationId}
                  className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors ${
                    responded === true
                      ? "border-emerald-500/30 bg-emerald-500/8"
                      : responded === false
                        ? "border-rose-500/30 bg-rose-500/8"
                        : "border-border bg-muted/30"
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium">{c.candidateName}</p>
                    {isAutoHired && (
                      <p className="text-xs text-amber-400/80 mt-0.5 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> Auto-marked hired on close
                      </p>
                    )}
                  </div>
                  {responded !== undefined ? (
                    <div
                      className={`text-xs font-medium flex items-center gap-1 ${responded === true ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {responded === true ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" /> Succeeded
                        </>
                      ) : (
                        <>
                          <X className="w-3.5 h-3.5" /> Did not succeed
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-3 text-xs gap-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => handleRoleOutcome(c.applicationId, true)}
                        disabled={submitting}
                      >
                        {submitting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3 h-3" />
                        )}
                        Yes
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-3 text-xs gap-1.5 border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                        onClick={() => handleRoleOutcome(c.applicationId, false)}
                        disabled={submitting}
                      >
                        {submitting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                        No
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCloseResult(null)}>
              {Object.keys(outcomeResponses).length === closeResult?.outcomeEligible.length
                ? "Done"
                : "Skip remaining"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Approve & Assign Recruiter dialog (TA reviewing HM-created WO) ── */}
      <Dialog
        open={approveDialogOpen}
        onOpenChange={(o) => {
          setApproveDialogOpen(o);
          if (!o) setApprovePickerOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Approve & Assign Recruiters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Approve this work order and assign one or more recruiters to begin sourcing. The first
              selected is the lead. You can also leave it unassigned and assign later.
            </p>
            <div className="space-y-1.5">
              <Label>Assign Recruiters</Label>
              <Popover open={approvePickerOpen} onOpenChange={setApprovePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="h-9 w-full justify-between text-sm font-normal"
                  >
                    <span className="truncate text-muted-foreground">
                      {approveRecruiterIds.length === 0
                        ? "— No recruiter yet (assign later) —"
                        : `${approveRecruiterIds.length} selected`}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search recruiters…" className="h-9" />
                    <CommandList>
                      <CommandEmpty>No recruiters found.</CommandEmpty>
                      <CommandGroup>
                        {recruiters.map((r: any) => {
                          const checked = approveRecruiterIds.includes(r.id);
                          return (
                            <CommandItem
                              key={r.id}
                              value={`${r.name} ${r.email ?? ""}`}
                              onSelect={() => {
                                setApproveRecruiterIds((prev) =>
                                  prev.includes(r.id)
                                    ? prev.filter((id) => id !== r.id)
                                    : [...prev, r.id],
                                );
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  checked ? "opacity-100" : "opacity-0",
                                )}
                              />
                              <span className="truncate">
                                {r.name}{" "}
                                {r.email ? (
                                  <span className="text-muted-foreground">({r.email})</span>
                                ) : null}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {approveRecruiterIds.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {approveRecruiterIds.map((id, idx) => {
                    const m = recruiters.find((r: any) => r.id === id);
                    if (!m) return null;
                    return (
                      <Badge key={id} variant="secondary" className="gap-1 pr-1 text-[11px]">
                        {idx === 0 && <span className="text-primary font-medium">Lead:</span>}
                        {m.name}
                        <button
                          type="button"
                          className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
                          onClick={() =>
                            setApproveRecruiterIds((prev) => prev.filter((x) => x !== id))
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApproveDialogOpen(false)}
              disabled={approvalLoading}
            >
              Cancel
            </Button>
            <Button
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => handleApprove(approveRecruiterIds)}
              disabled={approvalLoading}
            >
              {approvalLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              {approveRecruiterIds.length ? "Approve & Assign" : "Approve without Recruiter"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="w-full mb-8 flex items-center gap-3">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList
              data-tour="job-tabs"
              className="min-w-max h-12 p-1 bg-muted/50 rounded-xl gap-0.5"
            >
              <TabsTrigger value="overview" className="rounded-lg px-4" data-tour="tab-overview">
                Overview
              </TabsTrigger>
              <TabsTrigger value="agents" className="rounded-lg px-4" data-tour="tab-agents">
                Workflow
              </TabsTrigger>
              <TabsTrigger value="icp" className="rounded-lg px-4" data-tour="tab-icp">
                ICP (AI)
              </TabsTrigger>
              <TabsTrigger
                value="pipeline"
                className="rounded-lg px-4 flex items-center gap-1.5"
                data-tour="tab-pipeline"
              >
                <Zap className="w-3.5 h-3.5" /> Pipeline
              </TabsTrigger>
              <TabsTrigger
                value="candidates"
                className="rounded-lg px-4"
                data-tour="tab-candidates"
              >
                Candidates{" "}
                <Badge className="ml-2 bg-primary/20 text-primary hover:bg-primary/20">
                  {candidatesData?.candidates?.length ?? 0}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="outreach" className="rounded-lg px-4" data-tour="tab-outreach">
                Outreach
              </TabsTrigger>
              <TabsTrigger value="anti-ghost" className="rounded-lg px-4 flex items-center gap-1.5">
                <Ghost className="w-3.5 h-3.5" /> Anti-Ghost
              </TabsTrigger>
              <TabsTrigger value="executive" className="rounded-lg px-4 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5" /> Executive
              </TabsTrigger>
              <TabsTrigger
                value="intelligence"
                className="rounded-lg px-4 flex items-center gap-1.5"
              >
                <Brain className="w-3.5 h-3.5" /> Intelligence
              </TabsTrigger>
              <TabsTrigger value="ai-context" className="rounded-lg px-4 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> AI Context
              </TabsTrigger>
              {import.meta.env.VITE_ENABLE_CONNECTION_ENGINE === "true" && (
                <TabsTrigger
                  value="engagement"
                  className="rounded-lg px-4 flex items-center gap-1.5"
                >
                  <Activity className="w-3.5 h-3.5" /> Engagement
                </TabsTrigger>
              )}
              <TabsTrigger value="distribute" className="rounded-lg px-4 flex items-center gap-1.5">
                <Share2 className="w-3.5 h-3.5" /> Distribute
              </TabsTrigger>
              <TabsTrigger value="funnel" className="rounded-lg px-4 flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5" /> Funnel
              </TabsTrigger>
            </TabsList>
          </div>
          {/* Permanent, revisitable AI shortlist for THIS work order — the same
              view a sourcing run's "Review shortlist" banner shows, minus the
              run scoping, so it never disappears. Lives OUTSIDE the scrollable
              tab strip so it's always visible. */}
          <Link href={`/decision-queue?job=${jobId}`}>
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0 h-12 rounded-xl">
              <Sparkles className="w-3.5 h-3.5 text-primary" /> AI Shortlist
            </Button>
          </Link>
        </div>

        {/* ── Overview ──────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Work Order Description</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <p className="whitespace-pre-wrap">{job.description}</p>
              </div>
            </CardContent>
          </Card>

          {/* ── Platform Recommendations Toggle ────────────────────────────── */}
          <PlatformRecommendationsCard job={job} />
        </TabsContent>

        {/* ── ICP ───────────────────────────────────────────────────────────── */}
        <TabsContent
          value="icp"
          className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          {!icp && !isRegenerating && icpRefetching && (
            <Card className="py-20 text-center">
              <CardContent className="space-y-4">
                <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full mx-auto" />
                <h3 className="text-lg font-medium animate-pulse">ICP Agent is running…</h3>
                <p className="text-sm text-muted-foreground">
                  The AI is analyzing the job description. This takes a few seconds.
                </p>
              </CardContent>
            </Card>
          )}

          {!icp && !isRegenerating && !icpRefetching && (
            <Card className="border-dashed bg-card/50 text-center py-16 shadow-none">
              <CardContent>
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Sparkles className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-bold mb-2">Generate Ideal Candidate Profile</h3>
                <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                  Lexy AI will analyze your job description to extract required skills,
                  nice-to-haves, and disqualifiers to automatically score inbound candidates.
                </p>
                <Button
                  type="button"
                  size="lg"
                  onClick={handleGenerateIcp}
                  disabled={isRegenerating}
                  className="hover-elevate active-elevate-2 font-semibold shadow-lg shadow-primary/20"
                >
                  <Sparkles className="w-4 h-4 mr-2" /> Generate ICP with AI
                </Button>
              </CardContent>
            </Card>
          )}

          {isRegenerating && (
            <Card className="py-20 text-center">
              <CardContent className="space-y-4">
                <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full mx-auto" />
                <h3 className="text-lg font-medium animate-pulse">
                  Lexy AI is analyzing the role...
                </h3>
                <p className="text-sm text-muted-foreground">
                  Extracting attributes, building skill graph, and setting weights.
                </p>
              </CardContent>
            </Card>
          )}

          {icp && !isRegenerating && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">
                <Card className="shadow-sm border-primary/20 overflow-hidden">
                  <div className="h-2 w-full bg-gradient-to-r from-primary to-accent"></div>
                  <CardHeader className="pb-3 flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-primary" /> AI Generated Profile
                      </CardTitle>
                      <CardDescription>
                        Version {icp.version} • {formatDate(icp.createdAt)}
                      </CardDescription>
                    </div>
                    {!editingIcp && (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingIcp(true)}
                          className="gap-1.5"
                          data-testid="button-edit-icp"
                        >
                          <Edit className="w-3.5 h-3.5" /> Edit
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleGenerateIcp}
                          disabled={isRegenerating}
                        >
                          {isRegenerating ? "Regenerating…" : "Regenerate"}
                        </Button>
                      </div>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-8">
                    {editingIcp ? (
                      <EditableIcpForm
                        key={`${(icp as any).id}-${icp.version}`}
                        icp={icp}
                        jobId={jobId}
                        onCancel={() => setEditingIcp(false)}
                        onSaved={async () => {
                          await queryClient.invalidateQueries({
                            queryKey: [`/api/jobs/${jobId}/icp`],
                          });
                          setEditingIcp(false);
                        }}
                      />
                    ) : (
                      <>
                        {((icp as any).alternateTitles?.length ?? 0) > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-primary" /> Alternate Titles
                              <span className="text-[10px] font-normal text-muted-foreground/70 normal-case">
                                (used for sourcing searches)
                              </span>
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(icp as any).alternateTitles.map((t: string) => (
                                <Badge
                                  key={t}
                                  variant="outline"
                                  className="px-3 py-1 text-sm border-primary/30 text-primary bg-primary/5"
                                >
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        <div>
                          <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-green-500" /> Required Skills
                          </h4>
                          <div className="flex flex-wrap gap-2">
                            {icp.requiredSkills.map((s) => (
                              <Badge
                                key={s}
                                variant="secondary"
                                className="px-3 py-1 bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 text-sm"
                              >
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-blue-500" /> Preferred Skills
                          </h4>
                          <div className="flex flex-wrap gap-2">
                            {icp.preferredSkills.map((s) => (
                              <Badge key={s} variant="outline" className="px-3 py-1 text-sm">
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        {((icp as any).requiredCertifications?.length ?? 0) > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-amber-500" /> Certifications &
                              Licenses
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(icp as any).requiredCertifications.map((c: string) => (
                                <Badge
                                  key={c}
                                  variant="outline"
                                  className="px-3 py-1 text-sm border-amber-500/30 text-amber-400 bg-amber-500/5"
                                >
                                  {c}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {((icp as any).toolsAndSystems?.length ?? 0) > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-purple-500" /> Tools & Systems
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(icp as any).toolsAndSystems.map((t: string) => (
                                <Badge
                                  key={t}
                                  variant="outline"
                                  className="px-3 py-1 text-sm border-purple-500/30 text-purple-400 bg-purple-500/5"
                                >
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {((icp as any).compliance?.length ?? 0) > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-cyan-500" /> Compliance &
                              Regulatory
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(icp as any).compliance.map((c: string) => (
                                <Badge
                                  key={c}
                                  variant="outline"
                                  className="px-3 py-1 text-sm border-cyan-500/30 text-cyan-300 bg-cyan-500/5"
                                >
                                  {c}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {((icp as any).negativeKeywords?.length ?? 0) > 0 && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <AlertCircle className="w-4 h-4 text-orange-500" /> Negative Keywords
                              <span className="text-[10px] font-normal text-muted-foreground/70 normal-case">
                                (excluded from sourcing)
                              </span>
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(icp as any).negativeKeywords.map((k: string) => (
                                <Badge
                                  key={k}
                                  variant="outline"
                                  className="px-3 py-1 text-sm border-orange-500/30 text-orange-400 bg-orange-500/5 line-through decoration-orange-500/40"
                                >
                                  {k}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {(icp as any).booleanSearchString && (
                          <div>
                            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-primary" /> Boolean Search String
                              <span className="text-[10px] font-normal text-muted-foreground/70 normal-case">
                                (LinkedIn / Google ready)
                              </span>
                            </h4>
                            <pre className="text-xs bg-muted/40 border border-border rounded-lg p-3 whitespace-pre-wrap break-words text-muted-foreground font-mono">
                              {(icp as any).booleanSearchString}
                            </pre>
                          </div>
                        )}

                        <div>
                          <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-destructive" /> Disqualifiers
                          </h4>
                          <ul className="space-y-2">
                            {icp.disqualifiers.map((d) => (
                              <li
                                key={d}
                                className="flex items-start gap-2 text-sm bg-destructive/5 p-3 rounded-lg border border-destructive/10 text-destructive-foreground"
                              >
                                <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-destructive flex-shrink-0" />
                                {d}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-6">
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-lg">Role Parameters</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {(icp as any).domain && (
                      <div className="flex justify-between items-center py-2 border-b">
                        <span className="text-muted-foreground text-sm">Domain</span>
                        <span className="font-medium">{(icp as any).domain}</span>
                      </div>
                    )}
                    {((icp as any).subSpecialty || (icp as any).roleFamily) && (
                      <div className="flex justify-between items-center py-2 border-b">
                        <span className="text-muted-foreground text-sm">Specialty</span>
                        <span
                          className="font-medium text-right max-w-[160px] truncate"
                          title={(icp as any).subSpecialty || (icp as any).roleFamily}
                        >
                          {(icp as any).subSpecialty || (icp as any).roleFamily}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground text-sm flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5" /> Location
                      </span>
                      <span
                        className="font-medium text-right max-w-[160px] truncate"
                        title={(icp as any).location || "Any location"}
                      >
                        {(icp as any).location || "Any location"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground text-sm">Seniority</span>
                      <span className="font-medium">{icp.seniority || "N/A"}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground text-sm">Experience</span>
                      <span className="font-medium">
                        {icp.yearsExperienceMin}-{icp.yearsExperienceMax} years
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b">
                      <span className="text-muted-foreground text-sm">Education</span>
                      <span
                        className="font-medium text-right max-w-[150px] truncate"
                        title={icp.educationRequirements || ""}
                      >
                        {icp.educationRequirements || "Any"}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-lg">AI Weighting</CardTitle>
                    <CardDescription>Attribute importance for scoring</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(() => {
                      const entries = Object.entries(icp.weightedAttributes || {})
                        .map(([key, w]) => [key, Number(w) || 0] as [string, number])
                        .slice(0, 5);
                      // weightedAttributes are intended as 0–1 fractions, but some
                      // generated rows come back on a larger scale (e.g. 0–10),
                      // which previously rendered as 700%/1000%. Show literal
                      // percentages when they're proper fractions; otherwise
                      // normalize by the max so nothing exceeds 100%.
                      const maxW = Math.max(0, ...entries.map(([, w]) => w));
                      const toPct = (w: number) =>
                        maxW <= 1 ? w * 100 : maxW > 0 ? (w / maxW) * 100 : 0;
                      return entries.map(([key, w]) => {
                        const pct = Math.max(0, Math.min(100, toPct(w)));
                        return (
                          <div key={key}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="font-medium">{key}</span>
                              <span className="text-muted-foreground">{Math.round(pct)}%</span>
                            </div>
                            <div className="w-full bg-muted rounded-full h-1.5">
                              <div
                                className="bg-primary h-1.5 rounded-full"
                                style={{ width: `${pct}%` }}
                              ></div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Executive View ────────────────────────────────────────────────── */}
        <TabsContent
          value="executive"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <ExecutiveJobView jobId={jobId} />
        </TabsContent>

        {/* ── Intelligence ──────────────────────────────────────────────────── */}
        <TabsContent
          value="intelligence"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <IntelligencePanel jobId={jobId} candidates={candidatesList} />
        </TabsContent>

        {/* ── AI Role Context ───────────────────────────────────────────────── */}
        <TabsContent
          value="ai-context"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <RoleContextPanel jobId={jobId} />
        </TabsContent>

        {/* ── Candidates ────────────────────────────────────────────────────── */}
        <TabsContent value="candidates">
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Pipeline Candidates</CardTitle>
                <CardDescription>Candidates matched and applied to this role.</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!jobApproved}
                  onClick={() => setCsvImportOpen(true)}
                >
                  Import CSV
                </Button>
                <Button size="sm" disabled={!jobApproved} onClick={() => setAddCandidateOpen(true)}>
                  <UserPlus className="w-4 h-4 mr-2" />
                  Add Candidate
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {!jobApproved && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
                  <Clock className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    This work order is awaiting approval. You can add and source candidates once a
                    tenant admin or recruiter admin approves it.
                  </span>
                </div>
              )}
              {(() => {
                const allCandidates = candidatesData?.candidates ?? [];
                const q = candidateSearch.trim().toLowerCase();
                const filtered = q
                  ? allCandidates.filter((c: any) => {
                      const haystack = [
                        c.firstName,
                        c.lastName,
                        `${c.firstName ?? ""} ${c.lastName ?? ""}`,
                        c.currentTitle,
                        c.currentCompany,
                        c.source,
                        c.email,
                      ]
                        .filter(Boolean)
                        .join(" ")
                        .toLowerCase();
                      return haystack.includes(q);
                    })
                  : allCandidates;
                if (allCandidates.length === 0) {
                  return <div className="text-center py-10">No candidates yet.</div>;
                }
                return (
                  <>
                    <div className="relative mb-4">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      <Input
                        value={candidateSearch}
                        onChange={(e) => setCandidateSearch(e.target.value)}
                        placeholder="Search candidates by name, title, or company…"
                        className="pl-9 pr-9"
                      />
                      {candidateSearch && (
                        <button
                          type="button"
                          aria-label="Clear search"
                          onClick={() => setCandidateSearch("")}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {q && (
                      <p className="text-xs text-muted-foreground mb-3">
                        {filtered.length} of {pluralize(allCandidates.length, "candidate")}
                      </p>
                    )}
                    {filtered.length === 0 ? (
                      <div className="text-center py-10 text-muted-foreground">
                        No candidates match "{candidateSearch}".
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {filtered.map((c: any) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between p-4 border rounded-xl hover:border-primary/50 transition-colors bg-card hover-elevate group"
                          >
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-lg font-bold">
                                {c.firstName.charAt(0)}
                                {c.lastName.charAt(0)}
                              </div>
                              <div>
                                <Link
                                  href={`/candidates/${c.id}`}
                                  className="font-bold hover:text-primary transition-colors text-lg"
                                >
                                  {c.firstName} {c.lastName}
                                </Link>
                                <p className="text-sm text-muted-foreground flex items-center gap-2">
                                  <span>
                                    {c.currentTitle} at {c.currentCompany}
                                  </span>
                                  <span>•</span>
                                  <span className="capitalize">{c.source}</span>
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-6">
                              {import.meta.env.VITE_ENABLE_CONNECTION_ENGINE === "true" && (
                                <div className="text-right hidden md:block">
                                  <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">
                                    Engagement
                                  </p>
                                  <ConnectionStrengthBadge candidateId={c.id} />
                                </div>
                              )}
                              <div className="text-right hidden md:block">
                                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">
                                  Match Score
                                </p>
                                <ScoreBadge
                                  score={c.talentMatchScore}
                                  className="text-sm px-3 py-1"
                                />
                              </div>
                              {onBoardCandidateIds.has(c.id) ? (
                                <Badge
                                  variant="outline"
                                  className="hidden md:inline-flex text-xs text-muted-foreground"
                                >
                                  In Pipeline
                                </Badge>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!!movingToPipeline[c.id]}
                                  onClick={() => moveToPipeline(c)}
                                >
                                  {movingToPipeline[c.id] ? "Moving…" : "Move to Pipeline"}
                                </Button>
                              )}
                              <Link href={`/candidates/${c.id}`}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`View ${c.name}`}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  <ArrowRight className="w-5 h-5" />
                                </Button>
                              </Link>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Pipeline ──────────────────────────────────────────────────────── */}
        <TabsContent
          value="pipeline"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <PipelinePanel jobId={jobId} />
        </TabsContent>

        <TabsContent
          value="agents"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6"
        >
          <WorkflowCanvas jobId={jobId} roleTitle={job?.title} />
          <RunHistoryPanel workOrderId={jobId} />
        </TabsContent>

        {/* ── Outreach ──────────────────────────────────────────────────────── */}
        <TabsContent
          value="outreach"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <JobOutreachPanel jobId={jobId} />
        </TabsContent>

        {/* ── Anti-Ghost ─────────────────────────────────────────────────────── */}
        <TabsContent
          value="anti-ghost"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <AntiGhostTab jobId={jobId} />
        </TabsContent>

        {/* ── Distribute ────────────────────────────────────────────────────── */}
        <TabsContent
          value="distribute"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <ShareAndEmbedPanel
            jobId={jobId}
            jobTitle={job?.title ?? ""}
            jobStatus={job?.status ?? "draft"}
          />
        </TabsContent>

        {/* ── Hiring Funnel ─────────────────────────────────────────────────── */}
        <TabsContent
          value="funnel"
          className="animate-in fade-in slide-in-from-bottom-4 duration-500"
        >
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingDown className="w-4 h-4 text-primary" /> Hiring Funnel
              </CardTitle>
              <CardDescription>
                Unique candidates at each pipeline stage. Conversion % shows step-by-step drop-off.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-2">
              <JobFunnel jobId={jobId} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Engagement ────────────────────────────────────────────────────── */}
        {import.meta.env.VITE_ENABLE_CONNECTION_ENGINE === "true" && (
          <TabsContent
            value="engagement"
            className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                <Activity className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Connection Engine</h2>
                <p className="text-sm text-muted-foreground">
                  Live engagement strength for every candidate in this pipeline.
                </p>
              </div>
            </div>

            {!candidatesData?.candidates || candidatesData.candidates.length === 0 ? (
              <Card className="border-dashed bg-card/50 text-center py-16 shadow-none">
                <CardContent>
                  <Activity className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-muted-foreground">No candidates in this pipeline yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {candidatesData.candidates.map((c) => (
                  <div key={c.id} className="space-y-2">
                    <Link href={`/candidates/${c.id}`} className="flex items-center gap-3 group">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-bold shrink-0">
                        {c.firstName.charAt(0)}
                        {c.lastName.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm group-hover:text-primary transition-colors truncate">
                          {c.firstName} {c.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{c.currentTitle}</p>
                      </div>
                    </Link>
                    <ConnectionStrengthPanel candidateId={c.id} jobId={jobId} />
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        )}
      </Tabs>

      <CsvImportDialog open={csvImportOpen} onOpenChange={setCsvImportOpen} jobId={jobId} />

      {/* ── Add Candidate Dialog ─────────────────────────────────────────── */}
      <Dialog
        open={addCandidateOpen}
        onOpenChange={(o) => {
          setAddCandidateOpen(o);
          if (!o) {
            setCvFileName(null);
            setCvObjectPath(null);
            setAddForm({
              firstName: "",
              lastName: "",
              email: "",
              phone: "",
              location: "",
              currentTitle: "",
              currentCompany: "",
              linkedinUrl: "",
              githubUrl: "",
            });
          }
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Candidate</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddCandidate} className="space-y-4 mt-2">
            {/* CV Upload Zone */}
            <div
              className={`relative border-2 border-dashed rounded-xl p-5 text-center transition-colors cursor-pointer ${cvDragging ? "border-primary bg-primary/10" : "border-muted-foreground/30 hover:border-primary/60 hover:bg-muted/40"}`}
              onDragOver={(e) => {
                e.preventDefault();
                setCvDragging(true);
              }}
              onDragLeave={() => setCvDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setCvDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) handleCvFile(f);
              }}
              onClick={() => {
                if (!cvParsing) document.getElementById("cv-file-input")?.click();
              }}
            >
              <input
                id="cv-file-input"
                type="file"
                accept=".pdf,.doc,.docx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleCvFile(f);
                  e.target.value = "";
                }}
              />
              {cvParsing ? (
                <div className="flex flex-col items-center gap-2 py-1">
                  <Loader2 className="w-7 h-7 text-primary animate-spin" />
                  <p className="text-sm font-medium text-primary">Parsing CV with AI…</p>
                  <p className="text-xs text-muted-foreground">{cvFileName}</p>
                </div>
              ) : cvFileName ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-left">
                    <FileText
                      className={`w-5 h-5 shrink-0 ${cvObjectPath ? "text-primary" : "text-amber-400"}`}
                    />
                    <div>
                      <p className="text-sm font-medium truncate max-w-[260px]">{cvFileName}</p>
                      {cvObjectPath ? (
                        <p className="text-xs text-emerald-400">
                          Fields auto-filled · Resume will be attached
                        </p>
                      ) : (
                        <p className="text-xs text-amber-400">
                          Fields auto-filled · Resume save failed — upload after adding
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCvFileName(null);
                      setCvObjectPath(null);
                      setAddForm({
                        firstName: "",
                        lastName: "",
                        email: "",
                        phone: "",
                        location: "",
                        currentTitle: "",
                        currentCompany: "",
                        linkedinUrl: "",
                        githubUrl: "",
                      });
                    }}
                    aria-label="Remove uploaded CV"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5 py-1">
                  <UploadCloud className="w-7 h-7 text-muted-foreground" />
                  <p className="text-sm font-medium">Upload CV to auto-fill</p>
                  <p className="text-xs text-muted-foreground">
                    PDF or Word · drag & drop or click
                  </p>
                </div>
              )}
            </div>

            <div className="relative flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground uppercase tracking-widest">
                or fill manually
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ac-first">
                  First Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ac-first"
                  placeholder="Jane"
                  value={addForm.firstName}
                  onChange={(e) => setAddForm((f) => ({ ...f, firstName: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-last">
                  Last Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ac-last"
                  placeholder="Smith"
                  value={addForm.lastName}
                  onChange={(e) => setAddForm((f) => ({ ...f, lastName: e.target.value }))}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ac-email">Email</Label>
                <Input
                  id="ac-email"
                  type="email"
                  placeholder="jane@example.com"
                  value={addForm.email}
                  onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-phone">Phone</Label>
                <Input
                  id="ac-phone"
                  placeholder="+1 555 000 0000"
                  value={addForm.phone}
                  onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ac-title">Current Title</Label>
                <Input
                  id="ac-title"
                  placeholder="Senior Engineer"
                  value={addForm.currentTitle}
                  onChange={(e) => setAddForm((f) => ({ ...f, currentTitle: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-company">Current Company</Label>
                <Input
                  id="ac-company"
                  placeholder="Acme Corp"
                  value={addForm.currentCompany}
                  onChange={(e) => setAddForm((f) => ({ ...f, currentCompany: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ac-location">Location</Label>
              <Input
                id="ac-location"
                placeholder="New York, NY"
                value={addForm.location}
                onChange={(e) => setAddForm((f) => ({ ...f, location: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ac-linkedin">LinkedIn URL</Label>
                <Input
                  id="ac-linkedin"
                  placeholder="linkedin.com/in/..."
                  value={addForm.linkedinUrl}
                  onChange={(e) => setAddForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ac-github">GitHub URL</Label>
                <Input
                  id="ac-github"
                  placeholder="github.com/..."
                  value={addForm.githubUrl}
                  onChange={(e) => setAddForm((f) => ({ ...f, githubUrl: e.target.value }))}
                />
              </div>
            </div>

            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddCandidateOpen(false)}
                disabled={addSaving || cvParsing}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  addSaving || cvParsing || !addForm.firstName.trim() || !addForm.lastName.trim()
                }
              >
                {addSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Adding…
                  </>
                ) : (
                  "Add Candidate"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Potential-duplicate confirmation dialog ──────────────────── */}
      <Dialog
        open={!!dupWarning}
        onOpenChange={(o) => {
          if (!o) setDupWarning(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-duplicate-warning">
          <DialogHeader>
            <DialogTitle>Possible duplicate candidate</DialogTitle>
          </DialogHeader>
          {dupWarning && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                A candidate with the same name and{" "}
                <span className="text-foreground font-medium">
                  {dupWarning.matchedOn.length > 0
                    ? dupWarning.matchedOn.join(" / ")
                    : "contact info"}
                </span>{" "}
                is already in your account:
              </p>
              <div className="rounded-md border border-border/40 bg-card/40 p-3">
                <div className="font-medium">
                  {dupWarning.existing.firstName} {dupWarning.existing.lastName}
                </div>
                {dupWarning.existing.email && (
                  <div className="text-xs text-muted-foreground">{dupWarning.existing.email}</div>
                )}
                {dupWarning.existing.currentTitle && (
                  <div className="text-xs text-muted-foreground">
                    {dupWarning.existing.currentTitle}
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Are you sure this is a different person? If so, you can add them anyway.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDupWarning(null)}
              disabled={addSaving}
              data-testid="button-dup-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmAddDuplicate}
              disabled={addSaving}
              data-testid="button-dup-confirm"
            >
              {addSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add anyway"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Same-email merge dialog ──────────────────────────────────── */}
      <Dialog
        open={!!emailMatch}
        onOpenChange={(o) => {
          if (!o) setEmailMatch(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-email-match">
          <DialogHeader>
            <DialogTitle>Candidate already on file</DialogTitle>
          </DialogHeader>
          {emailMatch && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">A candidate with this email already exists:</p>
              <div className="rounded-md border border-border/40 bg-card/40 p-3">
                <div className="font-medium">
                  {emailMatch.existing.firstName} {emailMatch.existing.lastName}
                </div>
                {emailMatch.existing.email && (
                  <div className="text-xs text-muted-foreground">{emailMatch.existing.email}</div>
                )}
                {emailMatch.existing.currentTitle && (
                  <div className="text-xs text-muted-foreground">
                    {emailMatch.existing.currentTitle}
                  </div>
                )}
              </div>
              {emailMatch.proposedChanges.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    The info you uploaded is newer for these fields. Updating will merge them into
                    the existing record (nothing is blanked out):
                  </p>
                  <div className="rounded-md border border-border/40 divide-y divide-border/40">
                    {emailMatch.proposedChanges.map((c) => (
                      <div key={c.field} className="px-3 py-2 text-xs">
                        <div className="font-medium text-foreground">{c.label}</div>
                        <div className="text-muted-foreground line-through">
                          {c.from ? String(c.from) : "—"}
                        </div>
                        <div className="text-emerald-400">{c.to ? String(c.to) : "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Your upload doesn't add any newer info, but we can still add this candidate to the
                  role.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEmailMatch(null)}
              disabled={addSaving}
              data-testid="button-email-match-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={confirmMergeEmail}
              disabled={addSaving}
              data-testid="button-email-match-merge"
            >
              {addSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Updating…
                </>
              ) : emailMatch && emailMatch.proposedChanges.length > 0 ? (
                "Update existing"
              ) : (
                "Add to role"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Work Order Dialog ───────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="w-5 h-5 text-primary" /> Edit Work Order
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Title *</Label>
              <Input
                value={editForm.title}
                onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Senior Frontend Engineer"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Input
                value={editForm.department}
                onChange={(e) => setEditForm((f) => ({ ...f, department: e.target.value }))}
                placeholder="e.g. Engineering"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Client Work Order #{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                value={editForm.clientWorkOrderNumber}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, clientWorkOrderNumber: e.target.value }))
                }
                placeholder="e.g. REQ-10432 (the client's own reference)"
              />
            </div>
            {/* ── Location: Country / State / City ─────────────────────────
                Mirrors the picker cascade in the Create Work Order modal so
                edits use the same canonical country/state/city lists. */}
            {(() => {
              const editStates = getStatesForCountry(editForm.locationCountry);
              const editHasStates = editStates.length > 0;
              return (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Country</Label>
                      <Popover open={editCountryOpen} onOpenChange={setEditCountryOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left"
                          >
                            <span className="flex items-center gap-2 truncate">
                              <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                              <span
                                className={cn(
                                  "truncate",
                                  !editForm.locationCountry && "text-muted-foreground",
                                )}
                              >
                                {editForm.locationCountry || "Select country…"}
                              </span>
                            </span>
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search country…" />
                            <CommandList className="max-h-[240px]">
                              <CommandEmpty>No country found.</CommandEmpty>
                              <CommandGroup>
                                {COUNTRIES.map((c) => (
                                  <CommandItem
                                    key={c.code}
                                    value={c.name}
                                    onSelect={(val) => {
                                      const country = COUNTRIES.find(
                                        (x) => x.name.toLowerCase() === val.toLowerCase(),
                                      );
                                      if (country) {
                                        // Country change invalidates the previously-picked state and city.
                                        setEditForm((f) => ({
                                          ...f,
                                          locationCountry: country.name,
                                          locationState: "",
                                          locationCity: "",
                                        }));
                                      }
                                      setEditCountryOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 w-3.5 h-3.5 shrink-0",
                                        editForm.locationCountry === c.name
                                          ? "opacity-100"
                                          : "opacity-0",
                                      )}
                                    />
                                    <span>{c.name}</span>
                                    <span className="ml-auto text-[10px] text-muted-foreground">
                                      {c.currency.code}
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-1.5">
                      <Label>State / Province</Label>
                      <Popover open={editStateOpen} onOpenChange={setEditStateOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            disabled={!editForm.locationCountry || !editHasStates}
                            className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left disabled:opacity-50"
                          >
                            <span className="flex items-center gap-2 truncate">
                              <MapPin className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                              <span
                                className={cn(
                                  "truncate",
                                  !editForm.locationState && "text-muted-foreground",
                                )}
                              >
                                {editForm.locationState ||
                                  (!editForm.locationCountry
                                    ? "Select country first"
                                    : !editHasStates
                                      ? "Not applicable"
                                      : "Select state…")}
                              </span>
                            </span>
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search state…" />
                            <CommandList className="max-h-[240px]">
                              <CommandEmpty>No state found.</CommandEmpty>
                              <CommandGroup>
                                {editStates.map((s) => (
                                  <CommandItem
                                    key={s.code}
                                    value={s.name}
                                    onSelect={(val) => {
                                      const match = editStates.find(
                                        (x) => x.name.toLowerCase() === val.toLowerCase(),
                                      );
                                      if (match) {
                                        // State change invalidates the previously-picked city.
                                        setEditForm((f) => ({
                                          ...f,
                                          locationState: match.name,
                                          locationCity: "",
                                        }));
                                      }
                                      setEditStateOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 w-3.5 h-3.5 shrink-0",
                                        editForm.locationState === s.name
                                          ? "opacity-100"
                                          : "opacity-0",
                                      )}
                                    />
                                    <span>{s.name}</span>
                                    <span className="ml-auto text-[10px] text-muted-foreground">
                                      {s.code}
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>City</Label>
                    <Popover
                      open={editCityOpen}
                      onOpenChange={(o) => {
                        setEditCityOpen(o);
                        if (!o) setEditCityQuery("");
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          disabled={
                            !editForm.locationCountry || (editHasStates && !editForm.locationState)
                          }
                          className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left disabled:opacity-50"
                        >
                          <span className="flex items-center gap-2 truncate">
                            <MapPin className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span
                              className={cn(
                                "truncate",
                                !editForm.locationCity && "text-muted-foreground",
                              )}
                            >
                              {editForm.locationCity ||
                                (!editForm.locationCountry
                                  ? "Select country first"
                                  : editHasStates && !editForm.locationState
                                    ? "Select state first"
                                    : "Select city…")}
                            </span>
                          </span>
                          <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[280px] p-0" align="start">
                        <Command>
                          <CommandInput
                            placeholder="Search or type a city…"
                            value={editCityQuery}
                            onValueChange={setEditCityQuery}
                          />
                          <CommandList className="max-h-[240px]">
                            <CommandEmpty>
                              {editCityQuery.trim()
                                ? `Press “Use ‘${editCityQuery.trim()}’” below.`
                                : "Type a city name."}
                            </CommandEmpty>
                            <CommandGroup>
                              {(() => {
                                const known = getCitiesForCountry(
                                  editForm.locationCountry,
                                  editHasStates ? editForm.locationState : undefined,
                                );
                                const q = editCityQuery.trim();
                                const items = known.map((city) => (
                                  <CommandItem
                                    key={city}
                                    value={city}
                                    onSelect={(val) => {
                                      setEditForm((f) => ({ ...f, locationCity: val }));
                                      setEditCityQuery("");
                                      setEditCityOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 w-3.5 h-3.5 shrink-0",
                                        editForm.locationCity === city
                                          ? "opacity-100"
                                          : "opacity-0",
                                      )}
                                    />
                                    {city}
                                  </CommandItem>
                                ));
                                // "Use '<typed>'" escape hatch for long-tail cities (e.g. San Ramon)
                                // that aren't in the bundled countries-data list.
                                const exactMatch = known.some(
                                  (c) => c.toLowerCase() === q.toLowerCase(),
                                );
                                if (q && !exactMatch) {
                                  items.push(
                                    <CommandItem
                                      key={`__custom__${q}`}
                                      value={q}
                                      onSelect={() => {
                                        setEditForm((f) => ({ ...f, locationCity: q }));
                                        setEditCityQuery("");
                                        setEditCityOpen(false);
                                      }}
                                    >
                                      <Check className="mr-2 w-3.5 h-3.5 shrink-0 opacity-0" />
                                      Use “{q}”
                                    </CommandItem>,
                                  );
                                }
                                return items;
                              })()}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </>
              );
            })()}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Work Type</Label>
                <Select
                  value={editForm.workType}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, workType: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="remote">Remote</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                    <SelectItem value="onsite">On-site</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Employment</Label>
                <Select
                  value={editForm.employmentType}
                  onValueChange={(v) => setEditForm((f) => ({ ...f, employmentType: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full_time">Full-time</SelectItem>
                    <SelectItem value="part_time">Part-time</SelectItem>
                    <SelectItem value="contract">Contract</SelectItem>
                    <SelectItem value="internship">Internship</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Salary Min</Label>
                <Input
                  type="number"
                  value={editForm.salaryMin}
                  onChange={(e) => setEditForm((f) => ({ ...f, salaryMin: e.target.value }))}
                  placeholder="e.g. 80000"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Salary Max</Label>
                <Input
                  type="number"
                  value={editForm.salaryMax}
                  onChange={(e) => setEditForm((f) => ({ ...f, salaryMax: e.target.value }))}
                  placeholder="e.g. 120000"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Job Description</Label>
              <textarea
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editForm.isConfidential}
                onChange={(e) => setEditForm((f) => ({ ...f, isConfidential: e.target.checked }))}
                className="rounded"
              />
              Confidential — hide company name on the public careers page
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={editSaving || !editForm.title.trim()}
              className="gap-1.5"
            >
              {editSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reassign Team Dialog ─────────────────────────────────────── */}
      <Dialog
        open={reassignOpen}
        onOpenChange={(o) => {
          setReassignOpen(o);
          if (!o) setReassignPickerOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCog className="w-5 h-5 text-primary" /> Reassign Team
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Recruiters</Label>
              <Popover open={reassignPickerOpen} onOpenChange={setReassignPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="h-9 w-full justify-between text-sm font-normal"
                  >
                    <span className="truncate text-muted-foreground">
                      {reassignRecruiterIds.length === 0
                        ? "Select recruiters…"
                        : `${reassignRecruiterIds.length} selected`}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search recruiters…" className="h-9" />
                    <CommandList>
                      <CommandEmpty>No recruiters found.</CommandEmpty>
                      <CommandGroup>
                        {recruiters
                          .filter((m: any) => m.status !== "pending")
                          .map((m: any) => {
                            const checked = reassignRecruiterIds.includes(m.id);
                            return (
                              <CommandItem
                                key={m.id}
                                value={`${m.name} ${m.email}`}
                                onSelect={() => {
                                  setReassignRecruiterIds((prev) =>
                                    prev.includes(m.id)
                                      ? prev.filter((id) => id !== m.id)
                                      : [...prev, m.id],
                                  );
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    checked ? "opacity-100" : "opacity-0",
                                  )}
                                />
                                <span className="truncate">
                                  {m.name}{" "}
                                  <span className="text-muted-foreground">({m.email})</span>
                                </span>
                              </CommandItem>
                            );
                          })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {reassignRecruiterIds.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {reassignRecruiterIds.map((id, idx) => {
                    const m = recruiters.find((r: any) => r.id === id);
                    if (!m) return null;
                    return (
                      <Badge key={id} variant="secondary" className="gap-1 pr-1 text-[11px]">
                        {idx === 0 && <span className="text-primary font-medium">Lead:</span>}
                        {m.name}
                        <button
                          type="button"
                          className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
                          onClick={() =>
                            setReassignRecruiterIds((prev) => prev.filter((x) => x !== id))
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                All selected recruiters can work this order; the first is the lead.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Hiring Manager</Label>
              <Select value={reassignHm} onValueChange={setReassignHm}>
                <SelectTrigger>
                  <SelectValue placeholder="Select hiring manager…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Unassigned —</SelectItem>
                  {hiringManagers
                    .filter((m: any) => m.status !== "pending")
                    .map((m: any) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name} ({m.email})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Reviews and approves submitted candidates.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReassignOpen(false)}
              disabled={reassignSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleReassignSave} disabled={reassignSaving} className="gap-1.5">
              {reassignSaving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save Assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Engage LINX dialog — job pre-filled from this work order. */}
      <EngageLinxDialog
        open={linxDialogOpen}
        onClose={() => setLinxDialogOpen(false)}
        jobId={jobId}
        jobTitle={job.title}
      />
    </AppLayout>
  );
}
