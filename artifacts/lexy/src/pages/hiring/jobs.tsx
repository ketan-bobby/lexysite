/**
 * pages/hiring/jobs.tsx — Hiring Manager Job View
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Read-only job board for hiring_manager role users. Shows the jobs they have
 * been assigned to, candidate counts per stage, and interview schedules.
 * Hiring managers cannot create jobs (recruiter-only) but can view job details
 * and leave feedback on candidates.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   JobCard    — title, department, open candidate count, days open,
 *                stage breakdown (sourced → screening → interviewing → offer)
 *   Search     — filter by job title or department
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET /api/jobs?assignedHiringManagerId=<userId>
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /hiring/jobs
 */
import { useState } from "react";
import { pluralize } from "@/lib/utils";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Briefcase, MapPin, Clock, Users, Search, Loader2, Plus,
  User, UserCog, ArrowRight, Globe,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import { apiFetch, apiBase, authHeaders } from "@/lib/api";
import { Link } from "wouter";

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

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const workTypeLabel: Record<string, string> = {
  remote: "Remote", hybrid: "Hybrid", onsite: "On-site",
};

const employmentLabel: Record<string, string> = {
  full_time: "Full-time", part_time: "Part-time", contract: "Contract", internship: "Internship",
};

const statusConfig: Record<string, { label: string; className: string }> = {
  draft:  { label: "Draft",  className: "text-muted-foreground border-border" },
  active: { label: "Active", className: "text-emerald-400 border-emerald-500/25 bg-emerald-500/10" },
  paused: { label: "Paused", className: "text-amber-400 border-amber-500/25 bg-amber-500/10" },
  closed: { label: "Closed", className: "text-red-400 border-red-500/25 bg-red-500/10" },
};

function useJobs() {
  const { user } = useAuth() as any;
  return useQuery({
    // Cookie-era key: partition by user id (not the raw token). Same-tab
    // login/logout do full page navigations (cache wiped), but cross-tab
    // auth sync swaps accounts via storage events WITHOUT a reload — the
    // user id keeps this cache from showing a previous account's jobs.
    queryKey: ["hm-jobs", user?.id ?? "anon"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/jobs`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      const data = await res.json();
      return (data.jobs ?? data ?? []) as any[];
    },
    staleTime: 30000,
  });
}

/* ── Simple Create Job Dialog for Hiring Manager ─────────────────────────── */
function CreateJobDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [title, setTitle]         = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation]   = useState("");
  const [workType, setWorkType]   = useState("hybrid");
  const [language, setLanguage]   = useState("en-US");
  const [description, setDescription] = useState("");
  const [saving, setSaving]       = useState(false);
  const { data: languages = [] }  = useLanguages();

  const handleClose = () => {
    setTitle(""); setDepartment(""); setLocation(""); setWorkType("hybrid");
    setLanguage("en-US"); setDescription("");
    onClose();
  };

  const handleCreate = async () => {
    if (!title.trim() || !description.trim()) {
      toast({ title: "Title and description are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/jobs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          title, department, location, workType, description,
          language,
          jdSource: "paste",
          assignedHiringManagerId: user?.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast({ title: err.error ?? "Failed to create job", variant: "destructive" });
        return;
      }
      toast({ title: "Job requisition created!", description: "It's in draft — a recruiter will be assigned." });
      queryClient.invalidateQueries({ queryKey: ["hm-jobs"] });
      handleClose();
    } catch {
      toast({ title: "Failed to create job", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Briefcase className="w-4 h-4" />
            </div>
            New Job Requisition
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Job Title <span className="text-primary">*</span></Label>
            <Input placeholder="e.g. Senior Software Engineer" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Input placeholder="e.g. Engineering" value={department} onChange={e => setDepartment(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Location</Label>
              <Input placeholder="e.g. New York, NY" value={location} onChange={e => setLocation(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Work Type</Label>
              <Select value={workType} onValueChange={setWorkType}>
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
              <Label className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-muted-foreground" /> Interview Language
              </Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
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
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Job Description <span className="text-primary">*</span></Label>
            <Textarea
              placeholder="Describe the role, responsibilities, and requirements…"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={6}
              className="resize-none text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The requisition will be created as a draft. An admin can assign a recruiter to start sourcing.
          </p>
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border/40">
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving || !title.trim() || !description.trim()}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
            Create Requisition
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Job Card ─────────────────────────────────────────────────────────────── */
function JobCard({ job, currentUserId }: { job: any; currentUserId: string }) {
  const cfg = statusConfig[job.status] ?? statusConfig.draft;
  const isAssignedToMe = job.assignedHiringManagerId === currentUserId;

  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className="hover:border-primary/30 transition-all cursor-pointer group">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h3 className="font-semibold group-hover:text-primary transition-colors">{job.title}</h3>
                {isAssignedToMe && (
                  <Badge variant="outline" className="text-primary border-primary/25 bg-primary/10 text-[10px]">Assigned to me</Badge>
                )}
                {job.isConfidential && (
                  <Badge variant="outline" className="text-amber-400 border-amber-500/25 bg-amber-500/10 text-[10px]">Confidential</Badge>
                )}
              </div>
              {job.department && <p className="text-sm text-muted-foreground">{job.department}</p>}
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                {job.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{job.location}</span>}
                {job.workType && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{workTypeLabel[job.workType] || job.workType}</span>}
                {job.employmentType && <span className="flex items-center gap-1"><Briefcase className="w-3 h-3" />{employmentLabel[job.employmentType] || job.employmentType}</span>}
                {job.applicationCount > 0 && <span className="flex items-center gap-1"><Users className="w-3 h-3" />{job.applicationCount} applicants</span>}
              </div>
              {/* Assignment pills */}
              {(job.assignedRecruiterName || job.assignedHiringManagerName) && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {job.assignedRecruiterName && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/40 border border-border/50 rounded-md px-2 py-0.5">
                      <User className="w-3 h-3" /> {job.assignedRecruiterName}
                    </span>
                  )}
                  {job.assignedHiringManagerName && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/40 border border-border/50 rounded-md px-2 py-0.5">
                      <UserCog className="w-3 h-3" /> {job.assignedHiringManagerName}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Badge variant="outline" className={`text-xs shrink-0 ${cfg.className}`}>{cfg.label}</Badge>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ── Main Page ────────────────────────────────────────────────────────────── */
export default function HiringJobs() {
  const { user } = useAuth() as any;
  const { data: jobs = [], isLoading } = useJobs();
  const [query, setQuery]   = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const currentUserId = user?.id ?? "";

  const filtered = jobs.filter((j: any) => {
    const q = query.toLowerCase();
    return !q || j.title?.toLowerCase().includes(q) || j.department?.toLowerCase().includes(q) || j.location?.toLowerCase().includes(q);
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <Link href="/hiring/dashboard" className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-4">
            <ArrowRight className="w-4 h-4 rotate-180" /> Back to Dashboard
          </Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <UserCog className="w-6 h-6 text-primary" /> My Requisitions
            </h1>
            <p className="text-muted-foreground text-sm mt-1">Work orders assigned to you — roles you are responsible for hiring.</p>
          </div>
          <div className="flex items-center gap-2">
            {jobs.length > 0 && (
              <Badge variant="secondary" className="text-sm px-3 py-1">{pluralize(jobs.length, "role")}</Badge>
            )}
            <Button className="gap-2 shadow-lg shadow-primary/20" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" /> New Requisition
            </Button>
          </div>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search roles…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-20 text-center text-muted-foreground">
              <UserCog className="w-14 h-14 mx-auto mb-4 opacity-20" />
              <p className="font-semibold text-lg text-foreground">
                {query ? "No roles match your search" : "No requisitions assigned to you yet"}
              </p>
              <p className="text-sm mt-1 max-w-xs mx-auto">
                {query ? "Try a different search term." : "Ask your admin to assign a work order to you, or create a new requisition below."}
              </p>
              {!query && (
                <Button className="mt-5 gap-2" onClick={() => setShowCreate(true)}>
                  <Plus className="w-4 h-4" /> Create Requisition
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((job: any) => (
              <JobCard key={job.id} job={job} currentUserId={currentUserId} />
            ))}
          </div>
        )}
      </div>

      <CreateJobDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </AppLayout>
  );
}
