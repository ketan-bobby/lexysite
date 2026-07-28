/**
 * pages/hiring/talent-pool.tsx — Hiring Manager Talent Pool Browser
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Browse the platform talent pool — candidates who have self-registered and
 * opted in to being discovered by hiring teams. Hiring managers can search
 * by skill, location, or role and flag interesting candidates for recruiter
 * follow-up.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   SearchFilters   — skill tags, location, experience level, availability
 *   CandidateCard   — name, current role, location, top skills, availability
 *                     status, AI career score, "Flag for Recruiter" CTA
 *   FlaggedList     — sidebar: candidates this HM has flagged
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/talent-pool?skills=…&location=…   — talent pool browser
 *   POST /api/talent-pool/:id/flag             — flag for recruiter attention
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /hiring/talent-pool
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Search, Users, MapPin, Briefcase, Linkedin, Mail,
  Phone, Calendar, FileText, Loader2, ArrowRight, Database,
  Sparkles, CheckCircle2, X, ClipboardList,
} from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn } from "@/lib/utils";

interface Submission {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  location: string | null;
  experienceLevel: string | null;
  bio: string | null;
  linkedinUrl: string | null;
  resumeObjectPath: string | null;
  status: string | null;
  note: string | null;
  pushedAt: string;
  candidateId: string | null;
}

interface Job {
  id: string;
  title: string;
  location?: string | null;
  department?: string | null;
  status?: string | null;
}

const statusStyles: Record<string, string> = {
  active:   "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
  pending:  "bg-amber-500/10  text-amber-400  border-amber-500/25",
  rejected: "bg-red-500/10    text-red-400    border-red-500/25",
  hired:    "bg-sky-500/10    text-sky-400    border-sky-500/25",
};

function initials(name: string) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ─── Assign to Work Order Modal ───────────────────────────────────────────── */
function AssignModal({
  submission,
  onClose,
}: {
  submission: Submission;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [jobs, setJobs]             = useState<Job[]>([]);
  const [jobSearch, setJobSearch]   = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [assigning, setAssigning]   = useState(false);
  const [assignedJobId, setAssignedJobId] = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);

  // Load open jobs
  useEffect(() => {
    setJobsLoading(true);
    apiFetch(`${apiBase}/jobs`)
      .then(r => r.json())
      .then((d: any) => {
        const all: Job[] = Array.isArray(d) ? d : d.jobs ?? [];
        setJobs(all.filter(j => j.status !== "closed" && j.status !== "archived"));
      })
      .catch(() => setJobs([]))
      .finally(() => setJobsLoading(false));
  }, []);

  const visibleJobs = jobSearch.trim()
    ? jobs.filter(j =>
        `${j.title} ${j.location ?? ""} ${j.department ?? ""}`.toLowerCase()
          .includes(jobSearch.toLowerCase())
      )
    : jobs;

  async function handleAssign() {
    if (!selectedJob || !submission.candidateId) return;
    setAssigning(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: submission.candidateId, jobId: selectedJob.id, stage: "shortlisted" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      setAssignedJobId(selectedJob.id);
      queryClient.invalidateQueries({ queryKey: ["talent-pool-submissions"] });
      toast({ title: "Candidate assigned", description: `${submission.fullName} added to "${selectedJob.title}"` });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAssigning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card border border-border/60 rounded-2xl shadow-2xl z-10 overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center shrink-0">
              <ClipboardList className="w-4.5 h-4.5 text-violet-400" />
            </div>
            <div>
              <h2 className="font-bold text-base">Assign to Work Order</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Adding <span className="font-medium text-foreground">{submission.fullName}</span> to a pipeline
              </p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5">
          {assignedJobId ? (
            /* ── Success state ── */
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7 text-emerald-400" />
              </div>
              <div>
                <p className="font-semibold text-foreground">{submission.fullName} assigned!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Added to <span className="font-medium text-foreground">"{selectedJob?.title}"</span> as Shortlisted
                </p>
              </div>
              <div className="flex gap-2 w-full mt-2">
                <Button variant="outline" className="flex-1" onClick={onClose}>Done</Button>
                {submission.candidateId && (
                  <Button className="flex-1 gap-2" asChild>
                    <Link href={`/candidates/${submission.candidateId}`} onClick={onClose}>
                      <Calendar className="w-3.5 h-3.5" /> Schedule Interview
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          ) : (
            /* ── Job picker ── */
            <div className="space-y-4">
              {/* Search jobs */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  className="pl-8 h-9 text-sm"
                  placeholder="Search open work orders…"
                  value={jobSearch}
                  onChange={e => setJobSearch(e.target.value)}
                />
              </div>

              {/* Job list */}
              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                {jobsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : visibleJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {jobs.length === 0 ? "No open work orders found." : "No matching work orders."}
                  </p>
                ) : visibleJobs.map(job => (
                  <button
                    key={job.id}
                    onClick={() => setSelectedJob(job)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg border transition-all text-sm",
                      selectedJob?.id === job.id
                        ? "border-violet-500/50 bg-violet-500/10 text-foreground"
                        : "border-border/40 hover:border-border/60 hover:bg-muted/30 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <div className="font-medium text-inherit">{job.title}</div>
                    <div className="text-[11px] mt-0.5 text-muted-foreground flex gap-2">
                      {job.location && <span>{job.location}</span>}
                      {job.department && <span>· {job.department}</span>}
                    </div>
                  </button>
                ))}
              </div>

              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                  {error}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
                <Button
                  className="flex-1 gap-2"
                  disabled={!selectedJob || assigning || !submission.candidateId}
                  onClick={handleAssign}
                >
                  {assigning
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Assigning…</>
                    : <><Sparkles className="w-3.5 h-3.5" /> Assign to Pipeline</>
                  }
                </Button>
              </div>

              {!submission.candidateId && (
                <p className="text-[11px] text-amber-400 text-center">
                  This candidate has no linked profile. Contact your recruiter.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Page ─────────────────────────────────────────────────────────────── */
export default function HiringTalentPool() {
  const [search, setSearch]             = useState("");
  const [assignTarget, setAssignTarget] = useState<Submission | null>(null);
  const [, navigate] = useLocation();

  const { data, isLoading, isError } = useQuery<{ submissions: Submission[] }>({
    queryKey: ["talent-pool-submissions"],
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/talent-pool/submissions`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 30_000,
  });

  const submissions = data?.submissions ?? [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return submissions;
    return submissions.filter(s =>
      `${s.fullName} ${s.email ?? ""} ${s.currentTitle ?? ""} ${s.location ?? ""}`.toLowerCase().includes(q)
    );
  }, [submissions, search]);

  return (
    <AppLayout>
      <div className="space-y-6">

        {/* Header */}
        <div>
          <Link href="/hiring/dashboard" className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-3">
            <ArrowRight className="w-4 h-4 rotate-180" /> Back to Dashboard
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/25 flex items-center justify-center">
              <Database className="w-5 h-5 text-sky-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Recruiters Shortlist</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Candidates recommended by your recruiter for your consideration.
              </p>
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {[
            { label: "Total Submitted", value: submissions.length,                                   color: "text-sky-400"     },
            { label: "Active",          value: submissions.filter(s => s.status === "active").length, color: "text-emerald-400" },
            { label: "With Resume",     value: submissions.filter(s => !!s.resumeObjectPath).length,  color: "text-violet-400"  },
          ].map(stat => (
            <Card key={stat.label} className="border-border/40">
              <CardContent className="p-4 flex items-center gap-3">
                <span className={cn("text-3xl font-black tabular-nums", stat.color)}>{stat.value}</span>
                <span className="text-sm text-muted-foreground">{stat.label}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, role, location…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : isError ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="font-medium">Failed to load recommended candidates.</p>
            <p className="text-sm mt-1">Please refresh the page and try again.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto">
              <Users className="w-7 h-7 text-sky-400" />
            </div>
            <p className="font-semibold text-foreground">
              {submissions.length === 0 ? "No candidates recommended yet" : "No results match your search"}
            </p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {submissions.length === 0
                ? "Your recruiter will push relevant candidates here for your consideration."
                : "Try a different search term."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(s => (
              <Card
                key={s.id}
                className={cn(
                  "border-border/40 hover:border-sky-500/30 transition-colors",
                  s.candidateId && "cursor-pointer"
                )}
                onClick={() => s.candidateId && navigate(`/candidates/${s.candidateId}`)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">

                    {/* Avatar */}
                    <Avatar className="w-12 h-12 shrink-0">
                      <AvatarFallback className="bg-gradient-to-br from-sky-600 to-primary text-white font-bold text-sm">
                        {initials(s.fullName)}
                      </AvatarFallback>
                    </Avatar>

                    {/* Main info */}
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-foreground">{s.fullName}</span>
                        {s.status && (
                          <Badge className={cn("text-[10px] px-2 py-0 h-4 border capitalize", statusStyles[s.status] ?? "")}>
                            {s.status}
                          </Badge>
                        )}
                        {s.experienceLevel && (
                          <Badge variant="outline" className="text-[10px] px-2 py-0 h-4 capitalize">
                            {s.experienceLevel.replace("_", " ")}
                          </Badge>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {s.currentTitle && (
                          <span className="flex items-center gap-1">
                            <Briefcase className="w-3.5 h-3.5" />{s.currentTitle}
                          </span>
                        )}
                        {s.location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5" />{s.location}
                          </span>
                        )}
                        {s.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5" />{s.email}
                          </span>
                        )}
                        {s.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="w-3.5 h-3.5" />{s.phone}
                          </span>
                        )}
                      </div>

                      {s.bio && (
                        <p className="text-sm text-muted-foreground line-clamp-2 italic border-l-2 border-sky-500/30 pl-2">
                          "{s.bio}"
                        </p>
                      )}

                      {s.note && (
                        <div className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-md px-3 py-1.5">
                          <span className="font-semibold">Recruiter note:</span> {s.note}
                        </div>
                      )}
                    </div>

                    {/* Right column: date + actions */}
                    <div className="flex flex-col gap-2 shrink-0 items-end" onClick={e => e.stopPropagation()}>
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {fmtDate(s.pushedAt)}
                      </span>

                      {/* Always-visible primary action */}
                      <Button
                        size="sm"
                        className="gap-1.5 bg-violet-600 hover:bg-violet-500 text-white border-0 shadow-md shadow-violet-900/30"
                        onClick={() => setAssignTarget(s)}
                      >
                        <ClipboardList className="w-3.5 h-3.5" />
                        Assign to Role
                      </Button>

                      {/* Secondary quick links */}
                      <div className="flex gap-1.5">
                        {s.linkedinUrl && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
                            <a href={s.linkedinUrl} target="_blank" rel="noreferrer" aria-label="View LinkedIn profile">
                              <Linkedin className="w-3 h-3" />
                            </a>
                          </Button>
                        )}
                        {s.resumeObjectPath && (
                          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs">
                            <FileText className="w-3 h-3" /> CV
                          </Button>
                        )}
                        {s.candidateId && (
                          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" asChild>
                            <Link href={`/candidates/${s.candidateId}`}>
                              Profile <ArrowRight className="w-3 h-3" />
                            </Link>
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Assign modal */}
      {assignTarget && (
        <AssignModal
          submission={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </AppLayout>
  );
}
