/**
 * pages/recruiter/jobs/index.tsx — Jobs Board
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Lists all jobs for the recruiter's tenant and provides a "Create Job" flow
 * that walks through title, description, department, location, and then
 * auto-triggers the ICP Agent to generate an Ideal Candidate Profile.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   JobCard     — title, department, location, status badge (open/paused/
 *                 closed), candidate counts per stage, days-open indicator
 *   CreateModal — multi-step form (Step 1: basics → Step 2: JD text or upload
 *                 → Step 3: pipeline config → Step 4: ICP generation)
 *   StatusFilter — tabs: All / Active / Paused / Closed
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useListJobs()   — GET /api/jobs?tenantId=…
 *   useCreateJob()  — POST /api/jobs
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/jobs
 */
import { authHeaders } from "@/lib/api";
import { useState, useRef, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListJobs, useCreateJob } from "@workspace/api-client-react";
import { aiFetch } from "@/lib/ai-intel-api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Link, useSearch, useLocation } from "wouter";
import { clientAvatar, resolveClientAvatars } from "@/lib/client-avatar";
import { useSourcingTrigger } from "@/lib/agent-runs";
import { Checkbox } from "@/components/ui/checkbox";
import { Handshake } from "lucide-react";
import { createLinxRequest, LinxStatusBadge } from "@/components/linx/engage-linx";
import {
  Search, Plus, MapPin, Users, Calendar, ArrowRight, Building,
  DollarSign, Briefcase, Wand2, Upload, ClipboardPaste, ChevronRight,
  ChevronLeft, Sparkles, X, CheckCircle2, RefreshCw, FileText,
  Clock, Building2, Lock, Loader2, PanelLeft,
  GitBranch, Hash, User, PartyPopper, Copy, ChevronsUpDown, Check, Globe, UserCog,
  ClipboardCheck, Video,
} from "lucide-react";
import { COUNTRIES, getCitiesForCountry, getStatesForCountry, getCurrencyForCountry, USD } from "@/lib/countries-data";
import { formatDate, cn, pluralize } from "@/lib/utils";
import { useToast } from "@workspace/react-hooks/use-toast";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ── Hooks ────────────────────────────────────────────────────────────────── */
// Top-level client tenants (agency parents) for the work-order client picker.
function useClients() {
  return useQuery({
    queryKey: ["clients", "topLevel"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants?topLevel=true`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json() as Promise<any[]>;
    },
    staleTime: 60000,
  });
}

// Branch tenants under a chosen parent client (disabled until a parent is set).
function useSubClients(parentId: string | null) {
  return useQuery({
    queryKey: ["subclients", parentId],
    queryFn: async () => {
      if (!parentId) return [];
      const res = await fetch(`${BASE}/api/tenants/${parentId}/branches`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json() as Promise<any[]>;
    },
    enabled: !!parentId,
    staleTime: 60000,
  });
}

// Available interview languages (cached indefinitely — rarely changes).
function useLanguages() {
  return useQuery({
    queryKey: ["interview-languages"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/interviews/languages`);
      return res.json() as Promise<{ code: string; label: string; nativeName: string }[]>;
    },
    staleTime: Infinity,
  });
}

// Members of a tenant for assignee selection (returns [] on error, not a throw).
function useTenantMembers(tenantId: string | null) {
  return useQuery({
    queryKey: ["members", tenantId],
    queryFn: async () => {
      if (!tenantId) return [];
      const res = await fetch(`${BASE}/api/tenants/${tenantId}/members`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return [];
      return res.json() as Promise<any[]>;
    },
    enabled: !!tenantId,
    staleTime: 60000,
  });
}

// All tenants, tolerating either a bare array or a { tenants: [] } envelope.
function useAllTenants() {
  return useQuery({
    queryKey: ["tenants", "all"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      const body = await res.json();
      return Array.isArray(body) ? body : (Array.isArray(body?.tenants) ? body.tenants : []);
    },
    staleTime: 60000,
  });
}

/* ── Tag chip helpers ─────────────────────────────────────────────────────── */
// Renders tags as removable chips; shows a placeholder when empty.
function TagList({ tags, onRemove }: { tags: string[]; onRemove?: (i: number) => void }) {
  if (!tags.length) return <span className="text-xs text-muted-foreground italic">None added yet</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 rounded-md px-2 py-0.5 text-[11px] font-medium">
          {t}
          {onRemove && (
            <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${t}`} className="hover:text-red-400 transition-colors">
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

// Text input that adds a tag on Enter/comma (dedupes, trims) plus a TagList below.
function TagInput({ tags, setTags, placeholder }: { tags: string[]; setTags: (t: string[]) => void; placeholder?: string }) {
  const [val, setVal] = useState("");
  const add = () => {
    const trimmed = val.trim();
    // Ignore blanks and duplicates so the tag set stays clean.
    if (trimmed && !tags.includes(trimmed)) setTags([...tags, trimmed]);
    setVal("");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          placeholder={placeholder || "Type and press Enter…"}
          className="h-8 text-sm"
        />
        <Button type="button" size="sm" variant="outline" onClick={add} className="h-8 px-2.5">Add</Button>
      </div>
      <TagList tags={tags} onRemove={(i) => setTags(tags.filter((_, idx) => idx !== i))} />
    </div>
  );
}

/* ── Step indicator ─────────────────────────────────────────────────────── */
/* Free-text role-context fields shown on the wizard's "Role Context" step.
 * These persist to workorder_ai_contexts (PUT /jobs/:id/ai-context) right after
 * the work order is created, so the AI messaging layer has per-role context
 * from day one. Department & work model are carried over from the Basics step
 * (not duplicated here). */
const CONTEXT_TEXT_FIELDS: { key: string; label: string; placeholder?: string }[] = [
  { key: "whyRoleExists", label: "Why this role exists" },
  { key: "businessProblem", label: "Business problem being solved" },
  { key: "teamDescription", label: "Team description" },
  { key: "projectDescription", label: "Project description" },
  { key: "candidateSellingPoints", label: "Candidate selling points", placeholder: "Why a great candidate would want this role." },
  { key: "candidateConcerns", label: "Candidate concerns to address", placeholder: "Objections to address proactively." },
  { key: "interviewProcess", label: "Interview process" },
  { key: "compensationNotes", label: "Compensation notes", placeholder: "Only referenced by the AI if you fill it in." },
  { key: "hiringManagerPreferences", label: "Hiring manager preferences" },
  { key: "messagingAngle", label: "Messaging angle", placeholder: "The pitch the AI should lead with." },
  { key: "aiInstructions", label: "Role-specific instructions for AI", placeholder: "Treated as data, never as commands." },
];

const EMPTY_ROLE_CONTEXT: Record<string, string> = {
  projectName: "", hiringManager: "", urgencyLevel: "",
  techStack: "", mustHaveSkills: "", niceToHaveSkills: "",
  ...Object.fromEntries(CONTEXT_TEXT_FIELDS.map((f) => [f.key, ""])),
};

// Progress indicator for the create-work-order wizard (current/done/upcoming steps).
function StepDots({ step, total }: { step: number; total: number }) {
  const labels = ["Client", "Basics", "Job Description", "Role Context"];
  return (
    <div className="flex items-center gap-0 mb-6 flex-wrap">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all",
            i + 1 === step ? "bg-primary/15 text-primary" :
            i + 1 < step  ? "text-emerald-400" : "text-muted-foreground"
          )}>
            {i + 1 < step
              ? <CheckCircle2 className="w-3.5 h-3.5" />
              : <span className={cn("w-5 h-5 rounded-full border flex items-center justify-center text-[10px]",
                  i + 1 === step ? "border-primary text-primary bg-primary/10" : "border-muted-foreground/40"
                )}>{i + 1}</span>
            }
            {labels[i]}
          </div>
          {i < total - 1 && <div className={cn("h-px w-3 mx-0.5", i + 1 < step ? "bg-emerald-400/50" : "bg-border/40")} />}
        </div>
      ))}
    </div>
  );
}

/* ── Work Order Success Panel ─────────────────────────────────────────────── */
// Confirmation screen shown after a work order is created (copy WO number + close).
function WOSuccessPanel({ workOrderNumber, title, status, onClose }: { workOrderNumber: string; title: string; status?: string; onClose: () => void }) {
  const { toast } = useToast();
  const pendingApproval = status === "pending_approval";
  const copy = () => {
    navigator.clipboard.writeText(workOrderNumber);
    toast({ title: "Copied to clipboard" });
  };
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center space-y-5">
      <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
        <PartyPopper className="w-8 h-8 text-emerald-400" />
      </div>
      <div>
        <h3 className="text-xl font-bold">{pendingApproval ? "Work Order Submitted!" : "Work Order Created!"}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {pendingApproval
            ? "Your work order has been submitted for approval. You'll be notified once it's reviewed."
            : "Your work order has been created and the ICP agent is running."}
        </p>
      </div>
      <div className="bg-muted/40 border border-border rounded-xl px-6 py-4 space-y-1">
        <p className="text-[11px] text-muted-foreground uppercase tracking-widest font-semibold">Work Order Number</p>
        <div className="flex items-center gap-2 justify-center">
          <p className="text-2xl font-mono font-bold text-primary tracking-wide">{workOrderNumber}</p>
          <button onClick={copy} aria-label="Copy work order number" className="text-muted-foreground hover:text-primary transition-colors">
            <Copy className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{title}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button onClick={onClose}>View All Work Orders</Button>
      </div>
    </div>
  );
}

/* ── Create Work Order Wizard ─────────────────────────────────────────────── */
// Multi-step wizard for creating a work order (client → basics → JD → role context),
// then persists per-role AI context once the work order exists.
function CreateWorkOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: languages = [] } = useLanguages();

  const [step, setStep] = useState(1);
  const [jdMode, setJdMode] = useState<"ai" | "paste" | "upload">("ai");
  const [createdWO, setCreatedWO] = useState<{ number: string; title: string; status?: string } | null>(null);

  /* Step 4 — Role Context (optional; feeds the AI messaging layer). */
  const [roleContext, setRoleContext] = useState<Record<string, string>>({ ...EMPTY_ROLE_CONTEXT });
  const setRC = (k: string, v: string) => setRoleContext((f) => ({ ...f, [k]: v }));
  // Payload is assembled at submit time (fresh state) and read back in the
  // mutation's onSuccess closure, which would otherwise capture stale state.
  const pendingContextRef = useRef<Record<string, any> | null>(null);

  /* Interview setup (optional) — focus + custom questions for THIS job's
   * interviews. Saved to the job's interview-direction `_default` key once the
   * work order exists (mirrors the AI-context flow). Also editable later from
   * the pipeline's "Set interview questions" step. */
  const [interviewFocus, setInterviewFocus] = useState("");
  const [interviewQuestions, setInterviewQuestions] = useState<string[]>([]);
  const pendingInterviewRef = useRef<{ focusDirective: string; customQuestions: string[] } | null>(null);

  /* Engage LINX (optional) — asks the LINX tenant for help filling this role.
   * Only job metadata + contact info is sent; never candidate data. The
   * request is POSTed in onSuccess once the job id exists (same pattern as
   * AI context / interview direction above). */
  const [engageLinx, setEngageLinx] = useState(false);
  const [linxContactName, setLinxContactName] = useState("");
  const [linxContactEmail, setLinxContactEmail] = useState("");
  const [linxNote, setLinxNote] = useState("");
  const pendingLinxRef = useRef<{ contactName: string; contactEmail: string; note?: string } | null>(null);

  /* Step 1 — Client */
  const [clientId, setClientId]       = useState("");
  const [subClientId, setSubClientId] = useState("");
  const [isConfidential, setIsConfidential] = useState(false);

  /* Assignment — multiple recruiters can be staffed on a work order. The first
     selected becomes the primary/lead; every selected recruiter gets access. */
  const [assignedRecruiterIds, setAssignedRecruiterIds] = useState<string[]>([]);
  const [recruiterPickerOpen, setRecruiterPickerOpen] = useState(false);
  const [assignedHiringManagerId, setAssignedHiringManagerId] = useState("");

  /* Step 2 — Basics */
  const [title, setTitle]               = useState("");
  const [department, setDepartment]     = useState("");
  const [clientWorkOrderNumber, setClientWorkOrderNumber] = useState("");
  const [interviewLanguage, setInterviewLanguage] = useState("en");
  const [locationCountry, setLocationCountry] = useState("");
  const [locationState, setLocationState]     = useState("");
  const [locationCity, setLocationCity]       = useState("");
  const [countryOpen, setCountryOpen]         = useState(false);
  const [stateOpen, setStateOpen]             = useState(false);
  const [cityOpen, setCityOpen]               = useState(false);
  // Free-text search box inside the City popover. We don't try to keep an
  // exhaustive worldwide city list — the recruiter can always type a city
  // we don't have (e.g. "San Ramon") and pick the "Use '…'" option.
  const [cityQuery, setCityQuery]             = useState("");
  // States available for the currently-selected country. Empty array means
  // the country has no meaningful top-level subdivision — we then disable
  // the State picker and let the user pick a city directly.
  const availableStates = getStatesForCountry(locationCountry);
  const hasStates       = availableStates.length > 0;
  const [currencyMode, setCurrencyMode]       = useState<"USD" | "local">("USD");
  const [workType, setWorkType]         = useState("hybrid");
  const [employmentType, setEmploymentType] = useState("full_time");
  const [salaryMin, setSalaryMin]       = useState("");
  const [salaryMax, setSalaryMax]       = useState("");
  const [salaryPeriod, setSalaryPeriod] = useState<"annual" | "monthly" | "hourly">("annual");
  const isContract = employmentType === "contract";
  // Auto-flip period when toggling in/out of Contract so the labels and
  // payload stay coherent without the user having to fiddle with the period
  // toggle (which is hidden for contract roles).
  useEffect(() => {
    if (isContract && salaryPeriod !== "hourly") setSalaryPeriod("hourly");
    if (!isContract && salaryPeriod === "hourly") setSalaryPeriod("annual");
  }, [isContract, salaryPeriod]);
  const periodSuffix = salaryPeriod === "annual" ? "yr" : salaryPeriod === "monthly" ? "mo" : "hr";

  /* Derived location string & currency. Format:
   *   "City, State, Country"  when state is present
   *   "City, Country"         when no state
   *   "State, Country"        when no city but a state was picked
   */
  const location = [locationCity, locationState, locationCountry].filter(Boolean).join(", ");
  const localCurrency = getCurrencyForCountry(locationCountry);
  const activeCurrency = currencyMode === "USD" || localCurrency.code === "USD" ? USD : localCurrency;
  const isLocalSameAsUSD = localCurrency.code === "USD";

  /* Step 3 — JD */
  const [jd, setJd]                     = useState("");
  const [jdGenerating, setJdGenerating] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");


  const { data: rawClients, isLoading: clientsLoading } = useClients();
  const { data: rawSubClients, isLoading: subLoading } = useSubClients(clientId || null);
  /* Team Assignment shows teammates from the LOGGED-IN user's agency (their own tenant),
     NOT members of the client company being staffed. Platform admins fall back to the
     selected client so they can still assign someone. */
  const { user } = useAuth() as any;
  const teamTenantId = user?.role === "platform_admin" ? (clientId || null) : (user?.tenantId || null);
  const { data: rawMembers = [] } = useTenantMembers(teamTenantId);
  const clients: any[] = Array.isArray(rawClients) ? rawClients : [];
  /* Resolve avatars over the full tenant list (same canonical pool JobsList
     uses) so a client's initials + colour stay identical across every surface. */
  const { data: avatarTenants = [] } = useAllTenants();
  const subClients: any[] = Array.isArray(rawSubClients) ? rawSubClients : [];
  const members: any[] = Array.isArray(rawMembers) ? rawMembers : [];
  const recruiters = members.filter(m => m.role === "recruiter");
  const hiringManagers = members.filter(m => m.role === "hiring_manager");

  /* Create mutation */
  const createMutation = useCreateJob({
    mutation: {
      onSuccess: async (data: any) => {
        queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
        const ctx = pendingContextRef.current;
        if (data?.id && ctx) {
          try {
            await aiFetch(`/jobs/${data.id}/ai-context`, { method: "PUT", body: JSON.stringify(ctx) });
          } catch (e: any) {
            toast({
              title: "Work order created — role context didn't save",
              description: e?.message || "You can add it from the work order's AI Context tab.",
              variant: "destructive",
            });
          }
        }
        pendingContextRef.current = null;
        const intv = pendingInterviewRef.current;
        if (data?.id && intv) {
          try {
            await aiFetch(`/jobs/${data.id}/interview-direction`, {
              method: "POST",
              body: JSON.stringify({ type: "_default", ...intv }),
            });
          } catch (e: any) {
            toast({
              title: "Work order created — interview questions didn't save",
              description: e?.message || "You can add them from the pipeline's “Set interview questions” step.",
              variant: "destructive",
            });
          }
        }
        pendingInterviewRef.current = null;
        const linx = pendingLinxRef.current;
        if (data?.id && linx) {
          try {
            await createLinxRequest({ jobId: data.id, ...linx });
          } catch (e: any) {
            toast({
              title: "Work order created — LINX request didn't send",
              description: e?.message || "You can engage LINX later from Market Intelligence.",
              variant: "destructive",
            });
          }
        }
        pendingLinxRef.current = null;
        setCreatedWO({ number: data.workOrderNumber || "WO-PENDING", title: data.title, status: data.status });
      },
      onError: (err: any) => {
        const issues = err?.data?.issues;
        const description =
          (Array.isArray(issues) && issues.length > 0
            ? issues.map((i: any) => i?.message).filter(Boolean).join(" ")
            : null) ||
          err?.data?.error ||
          err?.message ||
          "Please review the fields and try again.";
        toast({ title: "Failed to create work order", description, variant: "destructive" });
      },
    },
  });

  const handleClose = () => {
    setStep(1); setJdMode("ai"); setCreatedWO(null);
    setClientId(""); setSubClientId(""); setIsConfidential(false);
    setAssignedRecruiterIds([]); setAssignedHiringManagerId("");
    setTitle(""); setDepartment(""); setClientWorkOrderNumber(""); setLocationCountry(""); setLocationState(""); setLocationCity(""); setCityQuery(""); setCurrencyMode("USD"); setWorkType("hybrid");
    setEmploymentType("full_time"); setSalaryMin(""); setSalaryMax(""); setSalaryPeriod("annual");
    setJd(""); setJdGenerating(false); setUploadFileName("");
    setRoleContext({ ...EMPTY_ROLE_CONTEXT }); pendingContextRef.current = null;
    setInterviewFocus(""); setInterviewQuestions([]); pendingInterviewRef.current = null;
    setEngageLinx(false); setLinxContactName(""); setLinxContactEmail(""); setLinxNote(""); pendingLinxRef.current = null;
    onClose();
  };

  /* Generate JD via AI */
  const generateJD = async () => {
    if (!title.trim()) { toast({ title: "Enter a job title first", variant: "destructive" }); return; }
    setJdGenerating(true);
    try {
      const res = await fetch(`${BASE}/api/jobs/generate-jd`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ title, department, location, workType, employmentType, salaryMin: Number(salaryMin) || undefined, salaryMax: Number(salaryMax) || undefined }),
      });
      const data = await res.json();
      setJd(data.jd || "");
    } catch {
      toast({ title: "JD generation failed", variant: "destructive" });
    } finally {
      setJdGenerating(false);
    }
  };

  /* Handle file upload — extracts plain text from PDF/DOCX/DOC/TXT server-side
     so the JD field is filled with the REAL content the LLM needs to build a
     domain-correct ICP. Without this, the model only sees the job title and
     hallucinates the wrong industry. */
  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setUploadFileName(file.name);

    if (file.name.match(/\.(txt|md)$/i)) {
      const reader = new FileReader();
      reader.onload = (e) => setJd(e.target?.result as string || "");
      reader.readAsText(file);
      return;
    }

    if (file.name.match(/\.doc$/i)) {
      toast({ title: "Legacy .doc not supported", description: "Re-save as .docx or PDF, or paste the JD text instead.", variant: "destructive" });
      setUploadFileName("");
      return;
    }

    setJd(`Extracting text from ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${BASE}/api/jobs/parse-jd`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders() },
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Could not read file", description: body.error || `Failed to extract text from ${file.name}.`, variant: "destructive" });
        setJd("");
        setUploadFileName("");
        return;
      }
      const extracted = String(body.text || "").trim();
      if (!extracted) {
        toast({ title: "No text found", description: "The file appears empty or scanned-image-only. Paste the JD instead.", variant: "destructive" });
        setJd("");
        return;
      }
      setJd(extracted);
      toast({ title: "JD extracted", description: `${body.charCount.toLocaleString()} characters loaded from ${file.name}.` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || String(err), variant: "destructive" });
      setJd("");
      setUploadFileName("");
    }
  };

  /* Submit
   * For contract roles the user enters an hourly rate (e.g. 50/120). The
   * schema only has integer salary_min/max columns and downstream renderers
   * (careers pages, recruiter list) assume an annual figure. Annualize using
   * the standard 2080 work-hours/year so "$50/hr" persists as "$104,000" and
   * displays correctly everywhere. */
  const HOURS_PER_YEAR = 2080;
  const annualize = (raw: string) => {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return isContract ? n * HOURS_PER_YEAR : n;
  };
  const handleSubmit = () => {
    const sMin = annualize(salaryMin);
    const sMax = annualize(salaryMax);
    if (sMin !== undefined && sMax !== undefined && sMin > sMax) {
      toast({
        title: isContract ? "Hourly rate range is reversed" : "Salary range is reversed",
        description: `The minimum (${salaryMin}) is higher than the maximum (${salaryMax}). Swap them so the lower value comes first.`,
        variant: "destructive",
      });
      return;
    }
    // Assemble the per-role AI context. Department & work model carry over from
    // the Basics step; the rest come from the Role Context step. Saved via
    // PUT /jobs/:id/ai-context in the mutation's onSuccess once we have the id.
    const ctx: Record<string, any> = {
      department: department.trim() || null,
      workModel: ["remote", "hybrid", "onsite"].includes(workType) ? workType : null,
    };
    for (const [k, v] of Object.entries(roleContext)) {
      ctx[k] = v.trim() === "" ? null : v.trim();
    }
    pendingContextRef.current = Object.values(ctx).some((v) => v != null) ? ctx : null;
    // Stash interview setup so onSuccess can persist it once the job id exists.
    const interviewFocusClean = interviewFocus.trim();
    const interviewQuestionsClean = interviewQuestions.map((q) => q.trim()).filter(Boolean);
    pendingInterviewRef.current =
      interviewFocusClean || interviewQuestionsClean.length > 0
        ? { focusDirective: interviewFocusClean, customQuestions: interviewQuestionsClean }
        : null;
    // LINX engagement: if the box is ticked, the contact fields are required —
    // block submit rather than silently skipping the request.
    if (engageLinx) {
      if (!linxContactName.trim() || !linxContactEmail.trim()) {
        toast({
          title: "LINX contact details required",
          description: "Add a contact name and email, or untick “Engage LINX on this role”.",
          variant: "destructive",
        });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(linxContactEmail.trim())) {
        toast({
          title: "Invalid LINX contact email",
          description: "Enter a valid email address for the LINX contact.",
          variant: "destructive",
        });
        return;
      }
    }
    pendingLinxRef.current = engageLinx
      ? {
          contactName: linxContactName.trim(),
          contactEmail: linxContactEmail.trim(),
          note: linxNote.trim() || undefined,
        }
      : null;
    createMutation.mutate({
      data: {
        title,
        department,
        clientWorkOrderNumber: clientWorkOrderNumber.trim() || undefined,
        location,
        workType,
        employmentType,
        salaryMin: sMin,
        salaryMax: sMax,
        description: jd,
        clientId: clientId || undefined,
        subClientId: subClientId || undefined,
        jdSource: jdMode,
        jdFileName: uploadFileName || undefined,
        language: interviewLanguage,
        isConfidential,
        assignedRecruiterIds: assignedRecruiterIds.length ? assignedRecruiterIds : undefined,
        assignedHiringManagerId: (assignedHiringManagerId && assignedHiringManagerId !== "none") ? assignedHiringManagerId : undefined,
      } as any,
    });
  };

  const selectedClient = clients.find((c: any) => c.id === clientId);
  const selectedSubClient = subClients.find((c: any) => c.id === subClientId);
  const clientAvatarMap = resolveClientAvatars((avatarTenants as any[]).map((t: any) => t.name));
  const avatarFor = (name: string) => clientAvatarMap.get(name) ?? clientAvatar(name);
  const canProceed1 = !!clientId;
  const canProceed2 = title.trim().length > 0;
  const canProceed3 = jd.trim().length > 10;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"
        onInteractOutside={(e) => { if (!createdWO) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (!createdWO) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Briefcase className="w-4 h-4" />
            </div>
            New Work Order
          </DialogTitle>
        </DialogHeader>

        {/* ── Success State ───────────────────────────────────────────────── */}
        {createdWO ? (
          <WOSuccessPanel workOrderNumber={createdWO.number} title={createdWO.title} status={createdWO.status} onClose={handleClose} />
        ) : (
          <>
            <StepDots step={step} total={4} />

            {/* ── Step 1: Client & Sub-client ─────────────────────────────── */}
            {step === 1 && (
              <div className="space-y-5">
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-1">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-primary" /> Select Client & Sub-client
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The work order number will be generated using the client and sub-client identifiers.
                  </p>
                </div>

                {/* Client selector */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-primary" />
                    Client (Organization) <span className="text-primary">*</span>
                  </Label>
                  {clientsLoading ? (
                    <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
                  ) : clients.length === 0 ? (
                    <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-xl text-center">
                      No clients found. <Link href="/clients" className="text-primary hover:underline">Create a client first</Link>.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                      {clients.map((c: any) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => { setClientId(c.id); setSubClientId(""); }}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-xl border text-left transition-all",
                            clientId === c.id
                              ? "border-primary bg-primary/10"
                              : "border-border/60 hover:border-primary/30 hover:bg-muted/30"
                          )}
                        >
                          <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0",
                            avatarFor(c.name).colorClass
                          )}>
                            {avatarFor(c.name).initials}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{c.name}</p>
                            <p className="text-[11px] text-muted-foreground">{c.industry || "General"} · {c.plan}</p>
                          </div>
                          {clientId === c.id && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Sub-client selector */}
                {clientId && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <GitBranch className="w-3.5 h-3.5 text-primary" />
                      Sub-client / Branch <span className="text-muted-foreground text-[11px] font-normal">(optional)</span>
                    </Label>
                    {subLoading ? (
                      <div className="h-10 bg-muted/40 rounded-lg animate-pulse" />
                    ) : subClients.length === 0 ? (
                      <div className="text-xs text-muted-foreground p-3 border border-dashed border-border/40 rounded-xl text-center">
                        No sub-clients for {selectedClient?.name}. Work order will use "MAIN" as sub-client code.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 max-h-32 overflow-y-auto pr-1">
                        <button
                          type="button"
                          onClick={() => setSubClientId("")}
                          className={cn(
                            "flex items-center gap-3 p-2.5 rounded-lg border text-left transition-all text-xs",
                            !subClientId
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border/40 hover:border-primary/30 text-muted-foreground hover:bg-muted/20"
                          )}
                        >
                          <span className="font-medium">None — use {selectedClient?.name} directly</span>
                        </button>
                        {subClients.map((s: any) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSubClientId(s.id)}
                            className={cn(
                              "flex items-center gap-3 p-2.5 rounded-lg border text-left transition-all",
                              subClientId === s.id
                                ? "border-primary bg-primary/10"
                                : "border-border/40 hover:border-primary/30 hover:bg-muted/20"
                            )}
                          >
                            <GitBranch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{s.name}</p>
                              <p className="text-[11px] text-muted-foreground">{s.industry || "Branch"}</p>
                            </div>
                            {subClientId === s.id && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Preview WO number format */}
                {clientId && (
                  <div className="bg-muted/30 border border-border/40 rounded-xl p-3 flex items-center gap-3">
                    <Hash className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-[11px] text-muted-foreground">Work Order Number Preview</p>
                      <p className="text-sm font-mono font-bold text-foreground">
                        WO-{new Date().getFullYear()}-{(selectedClient?.slug || selectedClient?.name || "CLT").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(2, "X")}-{subClientId && selectedSubClient ? (selectedSubClient.slug || selectedSubClient.name).replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(2, "X") : "MAIN"}-<span className="text-faint">####</span>
                      </p>
                    </div>
                  </div>
                )}

                {/* Confidential toggle — only relevant when posting for a client */}
                {clientId && (
                  <button
                    type="button"
                    onClick={() => setIsConfidential(v => !v)}
                    className={cn(
                      "w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all",
                      isConfidential
                        ? "border-amber-500/40 bg-amber-500/8"
                        : "border-border/50 hover:border-border/80 bg-muted/10"
                    )}
                  >
                    <div className={cn(
                      "w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all",
                      isConfidential
                        ? "bg-amber-500 border-amber-500 text-white"
                        : "border-border/60"
                    )}>
                      {isConfidential && <Lock className="w-2.5 h-2.5" />}
                    </div>
                    <div>
                      <p className={cn("text-sm font-medium", isConfidential ? "text-amber-500" : "text-foreground")}>
                        Confidential posting
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {isConfidential
                          ? `This job will NOT appear on ${selectedClient?.name}'s careers page. It will post on your agency page as "Confidential Client".`
                          : `This job will appear on ${selectedClient?.name}'s public careers page with their branding.`
                        }
                      </p>
                    </div>
                  </button>
                )}
              </div>
            )}

            {/* ── Step 2: Basics ──────────────────────────────────────────── */}
            {step === 2 && (
              <div className="space-y-4">
                {/* Selected client pill */}
                {selectedClient && (
                  <div className="flex items-center gap-2 p-2 bg-primary/5 border border-primary/20 rounded-lg text-xs">
                    <Building2 className="w-3.5 h-3.5 text-primary" />
                    <span className="font-medium text-primary">{selectedClient.name}</span>
                    {selectedSubClient && <><span className="text-muted-foreground">›</span><span className="text-primary">{selectedSubClient.name}</span></>}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>Work Order Title <span className="text-primary">*</span></Label>
                  <Input placeholder="e.g. Senior Software Engineer" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                </div>

                <div className="space-y-1.5">
                  <Label>Client Work Order # <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input placeholder="e.g. REQ-10432 (the client's own reference)" value={clientWorkOrderNumber} onChange={(e) => setClientWorkOrderNumber(e.target.value)} />
                  <p className="text-xs text-muted-foreground">The client's existing requisition number, if this work order already exists in their system. Lexy still assigns its own tracking number.</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Department</Label>
                    <Input placeholder="e.g. Engineering" value={department} onChange={(e) => setDepartment(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Country</Label>
                    <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" role="combobox" className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left">
                          <span className="flex items-center gap-2 truncate">
                            <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span className={cn("truncate", !locationCountry && "text-muted-foreground")}>
                              {locationCountry || "Select country…"}
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
                                    const country = COUNTRIES.find(x => x.name.toLowerCase() === val.toLowerCase());
                                    if (country) {
                                      setLocationCountry(country.name);
                                      // Reset dependent pickers — old state/city won't exist in the new country.
                                      setLocationState("");
                                      setLocationCity("");
                                      setCurrencyMode("local");
                                    }
                                    setCountryOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 w-3.5 h-3.5 shrink-0", locationCountry === c.name ? "opacity-100" : "opacity-0")} />
                                  <span>{c.name}</span>
                                  <span className="ml-auto text-[10px] text-muted-foreground">{c.currency.code}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>State / Province</Label>
                    <Popover open={stateOpen} onOpenChange={setStateOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          // Disabled when the country has no states OR no country picked yet.
                          disabled={!locationCountry || !hasStates}
                          className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left disabled:opacity-50"
                        >
                          <span className="flex items-center gap-2 truncate">
                            <MapPin className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span className={cn("truncate", !locationState && "text-muted-foreground")}>
                              {locationState
                                || (!locationCountry
                                      ? "Select country first"
                                      : !hasStates
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
                              {availableStates.map((s) => (
                                <CommandItem
                                  key={s.code}
                                  value={s.name}
                                  onSelect={(val) => {
                                    const match = availableStates.find(x => x.name.toLowerCase() === val.toLowerCase());
                                    if (match) {
                                      setLocationState(match.name);
                                      // Reset city — the previously-picked city may not belong to this state.
                                      setLocationCity("");
                                    }
                                    setStateOpen(false);
                                  }}
                                >
                                  <Check className={cn("mr-2 w-3.5 h-3.5 shrink-0", locationState === s.name ? "opacity-100" : "opacity-0")} />
                                  <span>{s.name}</span>
                                  <span className="ml-auto text-[10px] text-muted-foreground">{s.code}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="space-y-1.5">
                    <Label>City</Label>
                    <Popover open={cityOpen} onOpenChange={(o) => { setCityOpen(o); if (!o) setCityQuery(""); }}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          // Disabled until we have a country, AND (if the country has states) a state.
                          disabled={!locationCountry || (hasStates && !locationState)}
                          className="w-full justify-between font-normal bg-input border-input hover:bg-input/80 text-left disabled:opacity-50"
                        >
                          <span className="flex items-center gap-2 truncate">
                            <MapPin className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span className={cn("truncate", !locationCity && "text-muted-foreground")}>
                              {locationCity
                                || (!locationCountry
                                      ? "Select country first"
                                      : hasStates && !locationState
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
                            value={cityQuery}
                            onValueChange={setCityQuery}
                          />
                          <CommandList className="max-h-[240px]">
                            <CommandEmpty>
                              {cityQuery.trim()
                                ? `Press “Use ‘${cityQuery.trim()}’” below.`
                                : "Type a city name."}
                            </CommandEmpty>
                            <CommandGroup>
                              {/* When the country has states, scope cities to the picked state.
                                  Otherwise show the flat country-level list. */}
                              {(() => {
                                const known = getCitiesForCountry(locationCountry, hasStates ? locationState : undefined);
                                const q = cityQuery.trim();
                                const items = known.map((city) => (
                                  <CommandItem
                                    key={city}
                                    value={city}
                                    onSelect={(val) => { setLocationCity(val); setCityQuery(""); setCityOpen(false); }}
                                  >
                                    <Check className={cn("mr-2 w-3.5 h-3.5 shrink-0", locationCity === city ? "opacity-100" : "opacity-0")} />
                                    {city}
                                  </CommandItem>
                                ));
                                // Show a "Use '<typed>'" option whenever the user has typed something
                                // that isn't an exact (case-insensitive) match for a known city.
                                // This handles the long tail (e.g. "San Ramon" in California) without
                                // forcing us to ship an exhaustive worldwide city list.
                                const exactMatch = known.some((c) => c.toLowerCase() === q.toLowerCase());
                                if (q && !exactMatch) {
                                  items.push(
                                    <CommandItem
                                      key={`__custom__${q}`}
                                      value={q}
                                      onSelect={() => { setLocationCity(q); setCityQuery(""); setCityOpen(false); }}
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
                  <div className="space-y-1.5">
                    <Label>Work Type</Label>
                    <Select value={workType} onValueChange={setWorkType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="remote">Remote</SelectItem>
                        <SelectItem value="hybrid">Hybrid</SelectItem>
                        <SelectItem value="onsite">On-site</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Employment</Label>
                    <Select value={employmentType} onValueChange={setEmploymentType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="full_time">Full-time</SelectItem>
                        <SelectItem value="part_time">Part-time</SelectItem>
                        <SelectItem value="contract">Contract</SelectItem>
                        <SelectItem value="internship">Internship</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Currency toggle — only show when a non-USD country is selected */}
                  <div className="space-y-1.5">
                    <Label>Salary Currency</Label>
                    <div className="flex rounded-lg border border-input overflow-hidden h-10">
                      <button
                        type="button"
                        onClick={() => setCurrencyMode("USD")}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors",
                          currencyMode === "USD" || isLocalSameAsUSD
                            ? "bg-primary text-primary-foreground"
                            : "bg-input text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <span>$ USD</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setCurrencyMode("local")}
                        disabled={isLocalSameAsUSD || !locationCountry}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors border-l border-input",
                          currencyMode === "local" && !isLocalSameAsUSD
                            ? "bg-primary text-primary-foreground"
                            : "bg-input text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                      >
                        <span>{locationCountry && !isLocalSameAsUSD ? `${localCurrency.symbol} ${localCurrency.code}` : "Local"}</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Salary period toggle — hidden for Contract (always hourly) */}
                {!isContract && (
                  <div className="space-y-1.5">
                    <Label>Salary Period</Label>
                    <div className="flex rounded-lg border border-input overflow-hidden h-10">
                      {(["annual", "monthly"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setSalaryPeriod(p)}
                          className={cn(
                            "flex-1 flex items-center justify-center text-xs font-medium transition-colors",
                            p === "monthly" && "border-l border-input",
                            salaryPeriod === p
                              ? "bg-primary text-primary-foreground"
                              : "bg-input text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {p === "annual" ? "📅 Annual" : "🗓 Monthly"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {(() => {
                    const isUSD = activeCurrency.code === "USD";
                    const prefix = isUSD ? "$" : activeCurrency.code;
                    const inputPl = isUSD ? "pl-7" : "pl-12";
                    return (
                      <>
                        <div className="space-y-1.5">
                          <Label>{isContract ? "Hourly Rate Min" : "Salary Min"} <span className="text-muted-foreground font-normal text-[10px] ml-1">/ {periodSuffix}</span></Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium select-none">{prefix}</span>
                            <Input className={inputPl} placeholder={isContract ? "50" : "80,000"} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value.replace(/\D/g, ""))} />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label>{isContract ? "Hourly Rate Max" : "Salary Max"} <span className="text-muted-foreground font-normal text-[10px] ml-1">/ {periodSuffix}</span></Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium select-none">{prefix}</span>
                            <Input className={inputPl} placeholder={isContract ? "120" : "120,000"} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value.replace(/\D/g, ""))} />
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Interview language */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground" /> Interview & Outreach Language
                  </Label>
                  <Select value={interviewLanguage} onValueChange={setInterviewLanguage}>
                    <SelectTrigger className="bg-input border-input">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {languages.length > 0
                        ? languages.map(l => (
                            <SelectItem key={l.code} value={l.code}>
                              {l.label}{l.nativeName && l.nativeName !== l.label ? ` — ${l.nativeName}` : ""}
                            </SelectItem>
                          ))
                        : <SelectItem value="en-US">English (United States)</SelectItem>
                      }
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Lexy will conduct the interview and write outreach emails in this language</p>
                </div>

                {/* ── Assignment */}
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-3">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <User className="w-4 h-4 text-primary" /> Team Assignment <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Assigned Recruiters</Label>
                      <Popover open={recruiterPickerOpen} onOpenChange={setRecruiterPickerOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            role="combobox"
                            disabled={!recruiters.length}
                            className="h-9 w-full justify-between text-sm font-normal"
                          >
                            <span className="truncate text-muted-foreground">
                              {assignedRecruiterIds.length === 0
                                ? (recruiters.length ? "Select recruiters…" : "No recruiters yet")
                                : `${assignedRecruiterIds.length} selected`}
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
                                {recruiters.map((m: any) => {
                                  const checked = assignedRecruiterIds.includes(m.id);
                                  return (
                                    <CommandItem
                                      key={m.id}
                                      value={m.name}
                                      onSelect={() => {
                                        setAssignedRecruiterIds((prev) =>
                                          prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                                        );
                                      }}
                                    >
                                      <Check className={cn("mr-2 h-4 w-4", checked ? "opacity-100" : "opacity-0")} />
                                      {m.name}
                                    </CommandItem>
                                  );
                                })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {assignedRecruiterIds.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {assignedRecruiterIds.map((id, idx) => {
                            const m = recruiters.find((r: any) => r.id === id);
                            if (!m) return null;
                            return (
                              <Badge key={id} variant="secondary" className="gap-1 pr-1 text-[11px]">
                                {idx === 0 && <span className="text-primary font-medium">Lead:</span>}
                                {m.name}
                                <button
                                  type="button"
                                  aria-label={`Remove ${m.name}`}
                                  className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
                                  onClick={() => setAssignedRecruiterIds((prev) => prev.filter((x) => x !== id))}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Assigned Hiring Manager</Label>
                      <Select value={assignedHiringManagerId} onValueChange={setAssignedHiringManagerId}>
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder={hiringManagers.length ? "Select hiring manager…" : "No hiring managers yet"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {hiringManagers.map((m: any) => (
                            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Step 3: Job Description ──────────────────────────────────── */}
            {step === 3 && (
              <div className="space-y-4">
                {/* Mode selector */}
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { mode: "ai",    icon: Wand2,           label: "AI Generate",  desc: "Write JD from job details" },
                    { mode: "paste", icon: ClipboardPaste,  label: "Type / Paste", desc: "Paste or type your own JD" },
                    { mode: "upload",icon: Upload,           label: "Upload File",  desc: "Upload .txt, .pdf, .docx"  },
                  ] as const).map(({ mode, icon: Icon, label, desc }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setJdMode(mode)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-all",
                        jdMode === mode
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/60 hover:border-primary/30 hover:bg-muted/30 text-muted-foreground"
                      )}
                    >
                      <Icon className="w-5 h-5" />
                      <span className="text-xs font-semibold">{label}</span>
                      <span className="text-[10px] opacity-70 leading-tight">{desc}</span>
                    </button>
                  ))}
                </div>

                {jdMode === "ai" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        AI will write a full JD based on <span className="text-foreground font-medium">"{title}"</span>
                        {department ? `, ${department}` : ""}{location ? ` · ${location}` : ""}.
                      </p>
                      <Button type="button" size="sm" onClick={generateJD} disabled={jdGenerating} className="gap-2 shrink-0">
                        {jdGenerating
                          ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Generating…</>
                          : <><Sparkles className="w-3.5 h-3.5" /> {jd ? "Regenerate" : "Generate JD"}</>}
                      </Button>
                    </div>
                    {!jd && !jdGenerating && (
                      <div className="border border-dashed border-border/60 rounded-xl p-8 text-center text-muted-foreground">
                        <Wand2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p className="text-sm">Click "Generate JD" to create an AI-written job description</p>
                      </div>
                    )}
                    {(jd || jdGenerating) && (
                      <Textarea
                        value={jdGenerating ? "Generating…" : jd}
                        onChange={(e) => setJd(e.target.value)}
                        className="h-52 text-sm font-mono leading-relaxed resize-none"
                        readOnly={jdGenerating}
                      />
                    )}
                  </div>
                )}

                {jdMode === "paste" && (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Paste your existing job description or type a new one.</p>
                    <Textarea
                      value={jd}
                      onChange={(e) => setJd(e.target.value)}
                      placeholder="Paste or type your full job description here…"
                      className="h-56 text-sm leading-relaxed"
                      autoFocus
                    />
                    <p className="text-[11px] text-muted-foreground text-right">{jd.length} characters</p>
                  </div>
                )}

                {jdMode === "upload" && (
                  <div className="space-y-3">
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".txt,.md,.pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }}
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="w-full border-2 border-dashed border-border/60 hover:border-primary/40 rounded-xl p-8 text-center transition-all group"
                    >
                      <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground group-hover:text-primary transition-colors" />
                      <p className="text-sm font-medium text-foreground">{uploadFileName || "Click to upload a JD file"}</p>
                      <p className="text-xs text-muted-foreground mt-1">Supports .txt, .md, .pdf, .doc, .docx</p>
                    </button>
                    {jd && (
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Extracted / review content</Label>
                        <Textarea value={jd} onChange={(e) => setJd(e.target.value)} className="h-40 text-sm leading-relaxed" />
                      </div>
                    )}
                  </div>
                )}

                {jd && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Job description ready ({jd.length} characters)
                  </div>
                )}
              </div>
            )}

            {/* ── Step 4: Role Context (optional; feeds AI messaging) ─────── */}
            {step === 4 && (
              <div className="space-y-5">
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-1">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" /> Role Context for AI <span className="text-[10px] font-normal text-muted-foreground">· optional</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Specific to this work order. Lexy uses it to write sharper candidate &amp; hiring-manager messages, and it overrides the tenant brand profile on conflict. Department &amp; work model carry over from the Basics step. You can edit all of this later from the work order's AI Context tab.
                  </p>
                </div>

                {/* Role basics */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Project name</Label>
                    <Input value={roleContext.projectName} onChange={(e) => setRC("projectName", e.target.value)} placeholder="e.g. Payments Platform" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Hiring manager</Label>
                    <Input value={roleContext.hiringManager} onChange={(e) => setRC("hiringManager", e.target.value)} placeholder="e.g. Priya Sharma" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Urgency</Label>
                    <Select value={roleContext.urgencyLevel} onValueChange={(v) => setRC("urgencyLevel", v)}>
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Skills & stack */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Tech stack / tools</Label>
                    <Input value={roleContext.techStack} onChange={(e) => setRC("techStack", e.target.value)} placeholder="e.g. React, Node, AWS" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Must-have skills</Label>
                    <Input value={roleContext.mustHaveSkills} onChange={(e) => setRC("mustHaveSkills", e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Nice-to-have skills</Label>
                    <Input value={roleContext.niceToHaveSkills} onChange={(e) => setRC("niceToHaveSkills", e.target.value)} />
                  </div>
                </div>

                {/* Context & messaging */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {CONTEXT_TEXT_FIELDS.map((f) => (
                    <div key={f.key} className="space-y-1.5">
                      <Label className="text-xs font-medium">{f.label}</Label>
                      <Textarea rows={2} value={roleContext[f.key]} onChange={(e) => setRC(f.key, e.target.value)} placeholder={f.placeholder} />
                    </div>
                  ))}
                </div>

                {/* Interview questions & focus (optional) — saved to this job's
                    interview direction; also editable later from the pipeline's
                    "Set interview questions" step before outreach goes out. */}
                <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-4 space-y-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <Video className="w-4 h-4 text-cyan-400" /> Interview Questions &amp; Focus
                      <span className="text-[10px] font-normal text-muted-foreground">· optional</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Add specific questions or a focus/theme for this role's interviews. Applies to every candidate who reaches the interview stage — both auto-scheduled and manually generated links. You can change this anytime from the pipeline.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Focus / theme direction</Label>
                    <Textarea
                      rows={2}
                      value={interviewFocus}
                      onChange={(e) => setInterviewFocus(e.target.value)}
                      placeholder="e.g. Focus on real-world problem-solving and how they collaborate under pressure."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Custom questions</Label>
                    <TagInput tags={interviewQuestions} setTags={setInterviewQuestions} placeholder="Type a question and press Enter…" />
                  </div>
                </div>

                {/* Engage LINX (optional) — cross-tenant help request. Only the
                    role + contact info is shared; candidate data never crosses
                    the tenant boundary. */}
                <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4 space-y-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      checked={engageLinx}
                      onCheckedChange={(v) => {
                        const on = Boolean(v);
                        setEngageLinx(on);
                        if (on) {
                          if (!linxContactName) setLinxContactName(user?.name || "");
                          if (!linxContactEmail) setLinxContactEmail(user?.email || "");
                        }
                      }}
                      className="mt-0.5"
                      data-testid="checkbox-engage-linx"
                    />
                    <span className="space-y-1">
                      <span className="text-sm font-medium flex items-center gap-2">
                        <Handshake className="w-4 h-4 text-primary" /> Engage LINX on this role
                        <span className="text-[10px] font-normal text-muted-foreground">· optional</span>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Ask LINX to help fill this role. Only the role details and your contact info are shared — never candidate data.
                      </span>
                    </span>
                  </label>
                  {engageLinx && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium">Contact name <span className="text-primary">*</span></Label>
                          <Input value={linxContactName} onChange={(e) => setLinxContactName(e.target.value)} data-testid="input-wizard-linx-contact-name" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium">Contact email <span className="text-primary">*</span></Label>
                          <Input type="email" value={linxContactEmail} onChange={(e) => setLinxContactEmail(e.target.value)} data-testid="input-wizard-linx-contact-email" />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Note to LINX <span className="text-muted-foreground font-normal">· optional</span></Label>
                        <Textarea rows={2} value={linxNote} onChange={(e) => setLinxNote(e.target.value)} placeholder="Anything LINX should know about this role…" data-testid="input-wizard-linx-note" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Nav buttons ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-between pt-4 border-t border-border/40 mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => step === 1 ? handleClose() : setStep(step - 1)}
                className="gap-2"
              >
                <ChevronLeft className="w-4 h-4" />
                {step === 1 ? "Cancel" : "Back"}
              </Button>

              {step < 4 ? (
                <Button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  disabled={step === 1 ? !canProceed1 : step === 2 ? !canProceed2 : !canProceed3}
                  className="gap-2"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={createMutation.isPending || !title.trim() || !jd.trim()}
                  className="gap-2"
                >
                  {createMutation.isPending
                    ? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Creating…</>
                    : <><Plus className="w-3.5 h-3.5" />Create Work Order</>}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Approval Queue Card ─────────────────────────────────────────────────────── */
// Pending-approval job card with approve/reject actions (TA can also assign a
// recruiter inline when approving hiring-manager-created jobs).
function ApprovalQueueCard({ job }: { job: any }) {
  const { user } = useAuth() as any;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  // For TA approving HM-created jobs: inline recruiter picker
  const [assignPickerOpen, setAssignPickerOpen] = useState(false);
  const [selectedRecruiterId, setSelectedRecruiterId] = useState("");

  const isHmJob = job.createdByRole === "hiring_manager";
  const isTA = ["tenant_admin", "platform_admin"].includes(user?.role);

  // Load team members from the REVIEWER's agency (user.tenantId), not the job's tenantId
  // which is the client company. Platform admins fall back to the job's tenantId.
  const queueTeamTenantId = user?.role === "platform_admin" ? (job.tenantId || null) : (user?.tenantId || null);
  const { data: membersData } = useQuery({
    queryKey: ["queue-members", queueTeamTenantId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants/${queueTeamTenantId}/members`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.ok ? res.json() : [];
    },
    enabled: !!user && !!queueTeamTenantId && assignPickerOpen,
    staleTime: 60_000,
  });
  const queueRecruiters: any[] = (Array.isArray(membersData) ? membersData : []).filter((m: any) => m.role === "recruiter");

  const approve = async (recruiterId?: string) => {
    setLoading("approve");
    try {
      const res = await fetch(`${BASE}/api/jobs/${job.id}/approve`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(recruiterId ? { assignedRecruiterId: recruiterId } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      const desc = recruiterId
        ? `${job.title} is active — recruiter assigned.`
        : `${job.title} is now active and open for sourcing.`;
      toast({ title: "Work order approved", description: desc });
      setAssignPickerOpen(false);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setLoading(null); }
  };

  const reject = async () => {
    setLoading("reject");
    try {
      const res = await fetch(`${BASE}/api/jobs/${job.id}/reject`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ note: rejectNote }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      const who = isHmJob ? "The hiring manager" : "The recruiter";
      toast({ title: "Returned for revision", description: `${who} has been notified.` });
      setRejectOpen(false);
      setRejectNote("");
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally { setLoading(null); }
  };

  return (
    <div className="rounded-xl border border-amber-500/20 bg-card p-4 space-y-3 hover:border-amber-500/40 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm line-clamp-1">{job.title}</p>
          <p className="text-xs text-body dark:text-muted-foreground mt-0.5">{job.department || "No department"} · {job.location || job.workType || "Flexible"}</p>
          {isHmJob && (
            <p className="text-[10px] text-violet-800 dark:text-violet-400 mt-0.5 flex items-center gap-1">
              <UserCog className="w-3 h-3" /> Requisition by Hiring Manager
            </p>
          )}
        </div>
        <div className="font-mono text-[10px] font-bold text-[#0B4A82] dark:text-primary bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 shrink-0">
          {job.workOrderNumber || "WO"}
        </div>
      </div>
      <p className="text-xs text-body dark:text-muted-foreground line-clamp-2">{job.description?.slice(0, 100)}…</p>

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        {/* TA + HM job → "Approve & Assign Recruiter" expands the picker */}
        {isHmJob && isTA ? (
          <Button
            size="sm"
            className="flex-1 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs"
            onClick={() => { setSelectedRecruiterId(""); setAssignPickerOpen(v => !v); }}
            disabled={!!loading}
          >
            {loading === "approve" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Approve & Assign
          </Button>
        ) : (
          <Button
            size="sm"
            className="flex-1 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs"
            onClick={() => approve()}
            disabled={!!loading}
          >
            {loading === "approve" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Approve
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 border-rose-500/30 text-rose-400 hover:bg-rose-500/10 h-8 text-xs"
          onClick={() => { setAssignPickerOpen(false); setRejectOpen(v => !v); }}
          disabled={!!loading}
        >
          <X className="w-3.5 h-3.5" /> Return
        </Button>
        <Button size="sm" variant="ghost" className="px-2 h-8" asChild>
          <Link href={`/jobs/${job.id}`} aria-label="View work order"><ArrowRight className="w-3.5 h-3.5" /></Link>
        </Button>
      </div>

      {/* Inline recruiter picker (TA approving HM job) */}
      {assignPickerOpen && (
        <div className="space-y-2 pt-1 border-t border-border/40">
          <p className="text-[11px] text-muted-foreground">Select a recruiter to assign to this work order:</p>
          <select
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={selectedRecruiterId}
            onChange={e => setSelectedRecruiterId(e.target.value)}
          >
            <option value="">— Assign later —</option>
            {queueRecruiters.map((r: any) => (
              <option key={r.id} value={r.id}>{r.name}{r.email ? ` (${r.email})` : ""}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={() => setAssignPickerOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="h-7 text-xs flex-1 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => approve(selectedRecruiterId || undefined)}
              disabled={!!loading}
            >
              {loading === "approve" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {selectedRecruiterId ? "Approve & Assign" : "Approve"}
            </Button>
          </div>
        </div>
      )}

      {/* Inline reject note */}
      {rejectOpen && (
        <div className="space-y-2 pt-1 border-t border-border/40">
          <textarea
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            rows={2}
            placeholder={isHmJob ? "Feedback for the hiring manager (optional)…" : "Feedback for the recruiter (optional)…"}
            value={rejectNote}
            onChange={e => setRejectNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={() => { setRejectOpen(false); setRejectNote(""); }}>Cancel</Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs flex-1 gap-1" onClick={reject} disabled={!!loading}>
              {loading === "reject" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Confirm Return
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Job Card ───────────────────────────────────────────────────────────────── */
/* Field labels that mark a "description" as really just serialized form data
   (e.g. "Job Description: … Department: … Location: …") which duplicates the
   metadata rows already shown on the card. Two or more distinct labels => treat
   the whole thing as a form dump and render no preview. */
const FORM_FIELD_LABEL_RE = /(job\s*description|job\s*title|department|location|employment\s*type|work\s*type|salary(?:\s*range)?|responsibilities|requirements|qualifications)\s*:/gi;

/* Reduce a stored description to a short, genuine preview:
   - strip markdown tokens,
   - return "" when the text is really just concatenated form fields,
   - otherwise return only the first sentence (the card line-clamps to 2 lines). */
function cleanPreview(text: string | null | undefined): string {
  const cleaned = (text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>~-]+/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const labelMatches = cleaned.match(FORM_FIELD_LABEL_RE);
  if (labelMatches && labelMatches.length >= 2) return "";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return firstSentence.trim();
}

/* Salaries are stored as annual integers (contract roles are annualized at
   rate × 2080). We surface the period explicitly ("/yr", "/hr"). There is no
   monthly period in the data model, so a value that looks like a monthly figure
   typed into an annual field is flagged in the console rather than silently
   "corrected" — the data is displayed as-is. */
const LOW_ANNUAL_SALARY_THRESHOLD = 20000;
const warnedLowSalaryJobIds = new Set<string>();

function formatSalary(job: any): string {
  if (job.salaryMax == null) return "—";
  if (job.employmentType === "contract") {
    const hourly = Math.round(job.salaryMax / 2080);
    return `$${hourly}/hr`;
  }
  const annual = job.salaryMax as number;
  if (
    annual > 0 &&
    annual < LOW_ANNUAL_SALARY_THRESHOLD &&
    job.employmentType !== "internship" &&
    job.employmentType !== "part_time" &&
    !warnedLowSalaryJobIds.has(job.id)
  ) {
    warnedLowSalaryJobIds.add(job.id);
    console.warn(
      `[JobCard] Job ${job.id} ("${job.title}") has an implausibly low annual salaryMax ($${annual}). ` +
      `Likely a data-entry error (a monthly value entered as annual). Displaying as-is; data not modified.`,
    );
  }
  return `$${(annual / 1000).toFixed(0)}k/yr`;
}

// Grid card for a single job/work order, linking to its detail page.
function JobCard({ job, statusColor, flat = false }: { job: any; statusColor: (s: string) => string; flat?: boolean }) {
  const { user } = useAuth() as any;
  const [, navigate] = useLocation();
  const { trigger, isPending } = useSourcingTrigger();
  const isAssignedToMe = user?.id && (job.assignedRecruiterId === user.id || job.assignedHiringManagerId === user.id);
  // Sourcing creates candidate records, so only offer it on approved/live roles.
  const canSource = ["active", "published"].includes(job.status);
  const preview = cleanPreview(job.description);
  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className={cn(
        "relative h-full overflow-hidden hover-elevate transition-all duration-300 cursor-pointer border border-border dark:border-border/80 bg-card dark:bg-gradient-to-b dark:from-card dark:to-muted/20 hover:border-primary/50 hover:-translate-y-0.5 group",
        flat
          ? "shadow-none hover:shadow-md hover:shadow-primary/5"
          : "shadow-sm hover:shadow-lg hover:shadow-primary/10"
      )}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-primary/0 via-primary/70 to-primary/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <CardContent className="p-5 flex flex-col h-full">
          <div className="flex justify-end items-center mb-3">
            <div className="flex items-center gap-1.5">
              {isAssignedToMe && (
                <Badge className="text-[10px] bg-green-500/15 text-green-800 dark:text-green-400 border border-green-500/25 gap-1">
                  Assigned to me
                </Badge>
              )}
              {job.isConfidential && (
                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-700 dark:text-amber-500 bg-amber-500/8 gap-1">
                  <Lock className="w-2.5 h-2.5" /> Confidential
                </Badge>
              )}
              <Badge variant="outline" className={cn("text-[11px]", statusColor(job.status))}>
                {job.status === "pending_approval" ? "Pending Approval" : job.status}
              </Badge>
              <LinxStatusBadge jobId={job.id} />
            </div>
          </div>
          <h3 className="text-base font-bold mb-1 group-hover:text-primary transition-colors line-clamp-1">{job.title}</h3>
          {preview && (
            <p className="text-sm text-body dark:text-muted-foreground mb-4 line-clamp-2">{preview}</p>
          )}
          <div className="grid grid-cols-2 gap-y-2.5 gap-x-2 text-sm text-body dark:text-muted-foreground mb-3">
            <div className="flex items-center gap-2"><Building className="w-3.5 h-3.5 shrink-0" /><span className="truncate text-xs">{job.department || "—"}</span></div>
            <div className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5 shrink-0" /><span className="truncate text-xs capitalize">{job.location || job.workType || "Flexible"}</span></div>
            <div className="flex items-center gap-2"><DollarSign className="w-3.5 h-3.5 shrink-0" /><span className="text-xs">{formatSalary(job)}</span></div>
            <div className="flex items-center gap-2 text-body dark:text-foreground font-medium"><Users className="w-3.5 h-3.5 text-primary shrink-0" /><span className="text-xs">{pluralize(job.applicationCount, "application")}</span></div>
          </div>
          {/* Assignee slot — always present so cards read consistently */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {job.assignedRecruiterName ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-blue-800 dark:text-blue-400 bg-blue-500/8 border border-blue-500/20 rounded px-1.5 py-0.5">
                <User className="w-2.5 h-2.5" /> {job.assignedRecruiterName}
              </span>
            ) : (
              <span
                role="button"
                tabIndex={0}
                aria-label="Assign recruiter"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/jobs/${job.id}?assign=1`); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); navigate(`/jobs/${job.id}?assign=1`); } }}
                className="inline-flex items-center gap-1 text-[10px] text-body dark:text-muted-foreground bg-transparent border border-dashed border-muted-foreground/40 rounded-full px-2 py-0.5 cursor-pointer hover:border-primary/50 hover:text-primary transition-colors"
              >
                <User className="w-2.5 h-2.5" /> Unassigned
              </span>
            )}
            {job.assignedHiringManagerName && (
              <span className="inline-flex items-center gap-1 text-[10px] text-violet-800 dark:text-violet-400 bg-violet-500/8 border border-violet-500/20 rounded px-1.5 py-0.5">
                <UserCog className="w-2.5 h-2.5" /> {job.assignedHiringManagerName}
              </span>
            )}
          </div>
          {canSource && (
            <button
              type="button"
              disabled={isPending}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); trigger(job.id); }}
              className="mb-3 inline-flex items-center justify-center gap-1.5 w-full text-[11px] font-semibold px-3 py-1.5 rounded-md border border-primary/30 text-primary bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-colors disabled:opacity-60"
            >
              {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Source Candidates
            </button>
          )}
          <div className="mt-auto pt-3 border-t border-border/40 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1 whitespace-nowrap shrink-0"><Calendar className="w-3 h-3" />Created {formatDate(job.createdAt)}</span>
            <span className="relative flex-1 min-w-0 flex items-center justify-end">
              <span
                className="font-mono truncate min-w-0 max-w-full group-hover:opacity-0 transition-opacity duration-200"
                style={{ direction: "rtl" }}
                title={job.workOrderNumber || "WO-LEGACY"}
              >{job.workOrderNumber || "WO-LEGACY"}</span>
              <span className="absolute inset-y-0 right-0 flex items-center font-medium text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-all translate-x-1 group-hover:translate-x-0 duration-200">
                View details <ArrowRight className="w-3 h-3 ml-1" />
              </span>
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ── Main page ─────────────────────────────────────────────────────────────── */
// Jobs/work-orders list page: filterable grid plus the pending-approval queue.
export default function JobsList() {
  const { toast } = useToast();
  const search$ = useSearch();
  const initialFilter = (() => {
    const p = new URLSearchParams(search$);
    return p.get("queue") === "pending" ? "pending_approval" : "all";
  })();
  const [filter, setFilter]         = useState<string>(initialFilter);
  const isApprovalsView = new URLSearchParams(search$).get("queue") === "pending";
  useEffect(() => {
    const p = new URLSearchParams(search$);
    if (p.get("queue") === "pending") setFilter("pending_approval");
  }, [search$]);
  const [search, setSearch]         = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [expandedClients, setExpandedClients]   = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { const v = localStorage.getItem("jobs.clientSidebarCollapsed"); return v === null ? true : v === "true"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("jobs.clientSidebarCollapsed", String(sidebarCollapsed)); } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  const { user } = useAuth() as any;
  const isRecruiter = user?.role === "recruiter";

  const { data, isLoading } = useListJobs();
  const { data: allTenants = [] } = useAllTenants();

  const jobs: any[] = data?.jobs || [];

  /* Build tenant map for quick lookup */
  const tenantMap = new Map<string, any>();
  (allTenants as any[]).forEach((t) => tenantMap.set(t.id, t));

  /* Top-level clients and their sub-clients.
   * For platform_admin, top-level means tenants with no parentId.
   * For scoped users (recruiter/tenant_admin), the API already returns only
   * their direct clients — all have a parentId — so fall back to showing all. */
  const strictTop = (allTenants as any[]).filter((t) => !t.parentId);
  const topClients = strictTop.length > 0 ? strictTop : (allTenants as any[]);
  /* One resolved avatar map for every client name on this page so each client's
     colour + initials stay consistent across the sidebar list, group headers,
     and cards (and colliding pairs get a 3-letter tiebreak). */
  const clientAvatarMap = resolveClientAvatars((allTenants as any[]).map((t: any) => t.name));
  const avatarFor = (name: string) => clientAvatarMap.get(name) ?? clientAvatar(name);
  const subClientMap = new Map<string, any[]>();
  (allTenants as any[]).forEach((t) => {
    if (t.parentId && strictTop.length > 0) {
      if (!subClientMap.has(t.parentId)) subClientMap.set(t.parentId, []);
      subClientMap.get(t.parentId)!.push(t);
    }
  });

  /* Filter jobs by status, search, and selected tenant */
  const baseFiltered = jobs.filter((j) =>
    (filter === "all" || j.status === filter) &&
    (j.title.toLowerCase().includes(search.toLowerCase()) ||
     (j.workOrderNumber || "").toLowerCase().includes(search.toLowerCase()))
  );

  /* Apply the selected-tenant subtree scope to any job list. Status-agnostic
     so it can be reused for the per-status pill counts. */
  const applyTenantScope = (list: any[], tenantId: string) => {
    const tenant = tenantMap.get(tenantId);
    if (!tenant) return list.filter((j) => j.tenantId === tenantId);
    if (!tenant.parentId) {
      const subIds = new Set((subClientMap.get(tenantId) || []).map((s: any) => s.id));
      return list.filter((j) => j.tenantId === tenantId || subIds.has(j.tenantId));
    }
    return list.filter((j) => j.tenantId === tenantId);
  };

  /* When a tenant is selected, include its sub-clients too */
  const getJobsForTenant = (tenantId: string) => applyTenantScope(baseFiltered, tenantId);

  const displayJobs = selectedTenantId ? getJobsForTenant(selectedTenantId) : baseFiltered;

  /* Per-status counts for the filter pills — scoped by search + selected tenant
     but NOT by the active status pill, so each pill shows its own live total
     (zero included). */
  const searchScoped = jobs.filter((j) =>
    j.title.toLowerCase().includes(search.toLowerCase()) ||
    (j.workOrderNumber || "").toLowerCase().includes(search.toLowerCase())
  );
  const countPool = selectedTenantId ? applyTenantScope(searchScoped, selectedTenantId) : searchScoped;
  const statusCount = (key: string) =>
    key === "all" ? countPool.length : countPool.filter((j) => j.status === key).length;

  const statusColor = (s: string) =>
    s === "active" ? "bg-emerald-500/10 text-[#085041] dark:text-emerald-400 border-emerald-500/20" :
    s === "draft"  ? "bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20" :
    s === "closed" ? "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20" :
                     "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20";

  const toggleExpand = (id: string) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  /* Max work orders shown per client group in the "All" view before the
     "View all" link drills into that client's full list. */
  const GROUP_PREVIEW_LIMIT = 3;

  /* Group jobs by client/sub-client for the "All" view */
  type GroupedSection = { tenantId: string; label: string; subLabel?: string; jobs: any[] };
  const buildGroupedSections = (): GroupedSection[] => {
    const sections: GroupedSection[] = [];
    topClients.forEach((client) => {
      const subs = subClientMap.get(client.id) || [];
      if (subs.length > 0) {
        subs.forEach((sub) => {
          const subJobs = baseFiltered.filter((j) => j.tenantId === sub.id);
          if (subJobs.length > 0) {
            sections.push({ tenantId: sub.id, label: client.name, subLabel: sub.name, jobs: subJobs });
          }
        });
        const directJobs = baseFiltered.filter((j) => j.tenantId === client.id);
        if (directJobs.length > 0) {
          sections.push({ tenantId: client.id, label: client.name, subLabel: `${client.name} (Direct)`, jobs: directJobs });
        }
      } else {
        const clientJobs = baseFiltered.filter((j) => j.tenantId === client.id);
        if (clientJobs.length > 0) {
          sections.push({ tenantId: client.id, label: client.name, jobs: clientJobs });
        }
      }
    });
    const assignedIds = new Set(sections.flatMap((s) => s.jobs.map((j: any) => j.id)));
    const unassigned = baseFiltered.filter((j) => !assignedIds.has(j.id));
    if (unassigned.length > 0) {
      /* Keep strict per-client grouping even for fallback rows: bucket the
         unmatched jobs by their own tenantId so multiple clients are never
         co-mingled into one panel. */
      const byTenant = new Map<string, any[]>();
      unassigned.forEach((j: any) => {
        const key = j.tenantId || "__unassigned__";
        if (!byTenant.has(key)) byTenant.set(key, []);
        byTenant.get(key)!.push(j);
      });
      byTenant.forEach((jobs, tid) => {
        const t = tenantMap.get(tid);
        sections.push({ tenantId: tid, label: t?.name || "Unassigned", jobs });
      });
    }
    return sections;
  };

  const woCountForClient = (clientId: string) => {
    const subIds = new Set((subClientMap.get(clientId) || []).map((s: any) => s.id));
    return baseFiltered.filter((j) => j.tenantId === clientId || subIds.has(j.tenantId)).length;
  };

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div className="min-w-0 flex-1">
          <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-3">
            <ArrowRight className="w-4 h-4 rotate-180" /> Back to Dashboard
          </Link>
          <h1 data-tour="jobs-page-title" className="page-title flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              {isApprovalsView ? <ClipboardCheck className="w-5 h-5" /> : <Briefcase className="w-5 h-5" />}
            </div>
            {isApprovalsView ? "Approvals" : "Work Orders"}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isApprovalsView
              ? "Work orders awaiting your review and approval."
              : isRecruiter ? "Your assigned work orders — roles you are responsible for filling." : "Manage your open requisitions and hiring pipelines."}
          </p>
        </div>
        <div className="relative inline-block">
          <Button data-tour="jobs-create-button" onClick={() => setShowCreate(true)} className="hover-elevate shadow-md shadow-primary/20 gap-2">
            <Plus className="w-4 h-4" /> New Work Order
          </Button>
        </div>
      </div>

      {/* Search + Status filter — frosted, sticks under the top nav */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6 sticky top-16 z-20 frosted-nav -mx-6 md:-mx-8 px-6 md:px-8 py-3">
        <button
          type="button"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? "Show clients" : "Hide clients"}
          aria-label={sidebarCollapsed ? "Show clients" : "Hide clients"}
          aria-pressed={!sidebarCollapsed}
          className={cn(
            "shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg border transition-colors",
            sidebarCollapsed
              ? "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
              : "border-primary/40 text-primary bg-primary/10"
          )}
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input placeholder="Search by title or WO number…" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <SegmentedControl
          aria-label="Filter work orders by status"
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All", count: statusCount("all") },
            { key: "active", label: "Active", count: statusCount("active") },
            { key: "draft", label: "Draft", count: statusCount("draft") },
            { key: "pending_approval", label: "Pending", count: statusCount("pending_approval") },
            { key: "paused", label: "Paused", count: statusCount("paused") },
            { key: "closed", label: "Closed", count: statusCount("closed") },
          ]}
        />
      </div>

      {/* Careers page URL banner — shown when a specific client is selected */}
      {selectedTenantId && (() => {
        const selectedTenant = tenantMap.get(selectedTenantId);
        if (!selectedTenant?.slug) return null;
        const careersUrl = `${window.location.origin}${BASE}/company/${selectedTenant.slug}`;
        return (
          <div className="flex items-center gap-3 px-4 py-2.5 mb-4 rounded-xl border border-primary/20 bg-primary/5 text-sm">
            <Globe className="w-4 h-4 text-primary shrink-0" />
            <span className="text-muted-foreground">Careers page for <span className="text-foreground font-medium">{selectedTenant.name}</span>:</span>
            <a
              href={careersUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 truncate max-w-xs hover:opacity-80"
            >
              {careersUrl.replace(/^https?:\/\//, "")}
            </a>
            <button
              onClick={() => { navigator.clipboard.writeText(careersUrl); toast({ title: "Copied!", description: "Careers page URL copied to clipboard." }); }}
              className="ml-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border/50 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-all"
            >
              <Copy className="w-3 h-3" /> Copy link
            </button>
          </div>
        );
      })()}

      {/* ── Approval Queue — hiring managers, recruiter admins & tenant admins ── */}
      {(() => {
        const isApprover = ["hiring_manager", "recruiter_admin", "tenant_admin", "platform_admin"].includes(user?.role);
        const pendingForMe = jobs.filter((j: any) =>
          j.status === "pending_approval" &&
          (user?.role !== "hiring_manager" || j.assignedHiringManagerId === user?.id)
        );
        if (!isApprover || pendingForMe.length === 0) return null;
        return (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-3.5 border-b border-amber-500/20">
              <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center">
                <Clock className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-400">Approval Queue</p>
                <p className="text-xs text-muted-foreground">{pluralize(pendingForMe.length, "work order")} awaiting your review</p>
              </div>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {pendingForMe.map((job: any) => (
                <ApprovalQueueCard key={job.id} job={job} />
              ))}
            </div>
          </div>
        );
      })()}

      {/* Two-panel layout */}
      <div className={cn("flex items-start transition-[gap] duration-[250ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none", sidebarCollapsed ? "gap-0" : "gap-5")}>

        {/* ── Client sidebar (collapsible, animated) ───────────────────────── */}
        <div
          aria-hidden={sidebarCollapsed}
          className={cn(
            "shrink-0 sticky top-4 overflow-hidden transition-[width,opacity] duration-[250ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
            sidebarCollapsed ? "w-0 opacity-0 pointer-events-none" : "w-60 opacity-100"
          )}
        >
          <div className="w-60 bg-card border border-border dark:border-border/50 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Clients</span>
              <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
            </div>

          <div className="py-1.5">
            {/* All */}
            <button
              onClick={() => setSelectedTenantId(null)}
              className={cn(
                "w-full flex items-center justify-between px-4 py-2.5 text-sm transition-all",
                !selectedTenantId
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <span className="flex items-center gap-2">
                <Briefcase className="w-3.5 h-3.5" /> All Work Orders
              </span>
              <span className="text-[11px] font-mono bg-muted rounded px-1.5 py-0.5 text-faint dark:text-inherit">{baseFiltered.length}</span>
            </button>

            <div className="h-px bg-border/30 mx-3 my-1" />

            {/* Client tree */}
            {(allTenants as any[]).length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">No clients yet</div>
            ) : topClients.map((client) => {
              const subs = subClientMap.get(client.id) || [];
              const count = woCountForClient(client.id);
              const isExpanded = expandedClients.has(client.id);
              const isClientSelected = selectedTenantId === client.id;

              return (
                <div key={client.id}>
                  <div className={cn(
                    "group/row flex items-center gap-1 pr-2 transition-all",
                    isClientSelected ? "bg-primary/10" : "hover:bg-muted/30"
                  )}>
                    {subs.length > 0 && (
                      <button
                        onClick={() => toggleExpand(client.id)}
                        className="pl-2 py-2.5 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", isExpanded && "rotate-90")} />
                      </button>
                    )}
                    <button
                      onClick={() => setSelectedTenantId(client.id)}
                      className={cn(
                        "flex-1 flex items-center justify-between py-2.5 text-sm",
                        subs.length > 0 ? "pl-0" : "pl-4",
                        isClientSelected ? "text-primary font-semibold" : "text-body"
                      )}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <div className={cn(
                          "w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center shrink-0",
                          avatarFor(client.name).colorClass
                        )}>
                          {avatarFor(client.name).initials}
                        </div>
                        <span className="truncate text-xs">{client.name}</span>
                      </span>
                      {count > 0 && (
                        <span className="text-[11px] font-mono bg-muted rounded px-1.5 py-0.5 shrink-0 ml-1 text-faint dark:text-inherit">{count}</span>
                      )}
                    </button>
                    {client.slug && (
                      <a
                        href={`${window.location.origin}${BASE}/company/${client.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="View careers page"
                        onClick={e => e.stopPropagation()}
                        className="shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity p-1 rounded text-muted-foreground hover:text-primary"
                      >
                        <Globe className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  {/* Sub-clients */}
                  {subs.length > 0 && isExpanded && (
                    <div className="ml-8 border-l border-border/30 pl-2 pb-1">
                      {subs.map((sub: any) => {
                        const subCount = baseFiltered.filter((j) => j.tenantId === sub.id).length;
                        const isSubSelected = selectedTenantId === sub.id;
                        return (
                          <button
                            key={sub.id}
                            onClick={() => setSelectedTenantId(sub.id)}
                            className={cn(
                              "w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-all",
                              isSubSelected
                                ? "bg-primary/10 text-primary font-semibold"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                            )}
                          >
                            <span className="flex items-center gap-1.5 truncate">
                              <GitBranch className="w-3 h-3 shrink-0" />
                              <span className="truncate">{sub.name.replace(client.name, "").replace(/^[\s—-]+/, "") || sub.name}</span>
                            </span>
                            {subCount > 0 && (
                              <span className="font-mono bg-muted rounded px-1 py-0.5 shrink-0 ml-1 text-faint dark:text-inherit">{subCount}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </div>

        {/* ── Work orders panel ────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
              {[1,2,3,4,5,6].map(i => <div key={i} className="h-56 bg-card rounded-xl animate-pulse border border-white/5" />)}
            </div>
          ) : selectedTenantId ? (
            /* ── Selected client/sub-client view ── */
            <>
              {/* Breadcrumb */}
              <div className="flex items-center gap-2 mb-5 text-sm">
                <button onClick={() => setSelectedTenantId(null)} className="text-muted-foreground hover:text-foreground transition-colors">
                  All Work Orders
                </button>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
                {(() => {
                  const t = tenantMap.get(selectedTenantId);
                  if (!t) return null;
                  if (t.parentId) {
                    const parent = tenantMap.get(t.parentId);
                    return (
                      <>
                        <button onClick={() => setSelectedTenantId(t.parentId)} className="text-muted-foreground hover:text-foreground transition-colors">
                          {parent?.name}
                        </button>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        <span className="text-foreground font-medium">{t.name}</span>
                      </>
                    );
                  }
                  return <span className="text-foreground font-medium">{t.name}</span>;
                })()}
              </div>

              {displayJobs.length === 0 ? (
                <div className="text-center py-20 bg-card rounded-2xl border border-dashed border-border/50">
                  <Briefcase className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-30" />
                  <h3 className="text-lg font-bold">{isRecruiter ? "No work orders assigned to you" : "No work orders found"}</h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {isRecruiter ? "Ask your admin to assign a work order to you." : "No work orders for this client yet."}
                  </p>
                  {!isRecruiter && (
                    <Button onClick={() => setShowCreate(true)} className="mt-4 gap-2" size="sm">
                      <Plus className="w-4 h-4" /> New Work Order
                    </Button>
                  )}
                </div>
              ) : (
                <div className="bg-panel border border-border/60 dark:border-border/50 rounded-[20px] p-4">
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-3">
                    {displayJobs.map((job: any) => (
                      <JobCard key={job.id} job={job} statusColor={statusColor} flat />
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ── All clients grouped view ── */
            <>
              {baseFiltered.length === 0 ? (
                jobs.length === 0 ? (
                  /* No work orders exist at all across every client — one
                     page-level empty state (matches the app's empty-state style). */
                  <div className="text-center py-20 bg-card rounded-2xl border border-dashed border-border/50">
                    <Briefcase className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-30" />
                    <h3 className="text-lg font-bold">No work orders yet</h3>
                    <p className="text-muted-foreground mt-1 text-sm">Create your first work order to start hiring.</p>
                    <Button onClick={() => setShowCreate(true)} className="mt-4 gap-2" size="sm">
                      <Plus className="w-4 h-4" /> New Work Order
                    </Button>
                  </div>
                ) : (
                  /* Work orders exist, but the current search/status filter hides
                     them all — steer the user to their filters, not creation. */
                  <div className="text-center py-20 bg-card rounded-2xl border border-dashed border-border/50">
                    <Briefcase className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-30" />
                    <h3 className="text-lg font-bold">No work orders found</h3>
                    <p className="text-muted-foreground mt-1 text-sm">Try adjusting your filters or search.</p>
                  </div>
                )
              ) : (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4 items-start">
                  {buildGroupedSections().map((section) => {
                    const isTruncated = section.jobs.length > GROUP_PREVIEW_LIMIT;
                    const visibleJobs = section.jobs.slice(0, GROUP_PREVIEW_LIMIT);
                    return (
                    <div
                      key={section.tenantId}
                      className="bg-panel border border-border/60 dark:border-border/50 rounded-[20px] p-4"
                    >
                      {/* Client header row */}
                      <div className="flex items-center gap-3 mb-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={cn(
                            "w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold shrink-0",
                            avatarFor(section.label).colorClass
                          )}>
                            {avatarFor(section.label).initials}
                          </div>
                          <span className="font-semibold text-sm text-foreground truncate">{section.subLabel || section.label}</span>
                        </div>
                        {section.subLabel && section.subLabel !== section.label && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
                            <GitBranch className="w-3 h-3" /> {section.label}
                          </span>
                        )}
                        <span className="text-[11px] font-mono bg-muted border border-border/30 rounded px-1.5 py-0.5 text-faint shrink-0">
                          {pluralize(section.jobs.length, "WO")}
                        </span>
                        <button
                          onClick={() => setSelectedTenantId(section.tenantId)}
                          className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
                        >
                          View all <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>

                      {/* This client's work orders stack vertically inside the panel */}
                      <div className="flex flex-col gap-3">
                        {visibleJobs.map((job: any) => (
                          <JobCard key={job.id} job={job} statusColor={statusColor} flat />
                        ))}
                      </div>

                      {isTruncated && (
                        <button
                          onClick={() => setSelectedTenantId(section.tenantId)}
                          className="mt-3 w-full py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-primary hover:bg-muted/40 transition-colors flex items-center justify-center gap-1"
                        >
                          View all {section.jobs.length} <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <CreateWorkOrderDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </AppLayout>
  );
}
