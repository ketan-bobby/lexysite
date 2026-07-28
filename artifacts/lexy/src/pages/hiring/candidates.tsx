/**
 * pages/hiring/candidates.tsx — Hiring Manager Candidate View
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Read-focused candidate list for hiring_manager role. Shows candidates that
 * are in the "interviewing" or later stages for jobs assigned to this hiring
 * manager. Hiring managers can view AI summaries, leave feedback, and record
 * their own hiring decision but cannot trigger outreach or modify pipeline stages.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   StageFilter    — tabs: Interviewing / Offered / Hired / Rejected
 *   CandidateRow   — name, current stage, AI fit score, interview report link,
 *                    "Leave Feedback" action
 *   FeedbackDialog — structured feedback form (rating + notes) per candidate
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET /api/candidates?assignedHiringManagerId=<userId>&stage=interviewing,offered,hired
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /hiring/candidates
 */
import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Search, Loader2, CheckCircle2, XCircle, ThumbsUp, ThumbsDown, ArrowRight, Clock } from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";

const stageColors: Record<string, string> = {
  sourced:      "bg-slate-500/10 text-slate-400 border-slate-500/25",
  applied:      "bg-blue-500/10 text-blue-400 border-blue-500/25",
  shortlisted:  "bg-violet-500/10 text-violet-400 border-violet-500/25",
  phone_screen: "bg-cyan-500/10 text-cyan-400 border-cyan-500/25",
  interview:    "bg-amber-500/10 text-amber-400 border-amber-500/25",
  offer:        "bg-orange-500/10 text-orange-400 border-orange-500/25",
  hired:        "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
};

type Tab = "to_review" | "approved" | "rejected" | "all";

export default function HiringCandidates() {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<any[]>([]);
  const [query, setQuery]           = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [activeTab, setActiveTab]   = useState<Tab>("to_review");
  const [loading, setLoading]       = useState(true);
  const [approving, setApproving]   = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/candidates`)
      .then(r => r.json())
      .then((d: any) => setCandidates(Array.isArray(d) ? d : d.candidates ?? []))
      .finally(() => setLoading(false));
  }, []);

  /* Tab counts (computed before search/stage filters so badges reflect totals) */
  const counts = useMemo(() => {
    const c = { to_review: 0, approved: 0, rejected: 0, all: candidates.length };
    for (const cand of candidates) {
      if (cand.hiringManagerApproval === "approved") c.approved++;
      else if (cand.hiringManagerApproval === "rejected") c.rejected++;
      else c.to_review++;
    }
    return c;
  }, [candidates]);

  const filtered = useMemo(() => {
    return candidates.filter((c: any) => {
      // Tab filter
      if (activeTab === "to_review" && c.hiringManagerApproval) return false;
      if (activeTab === "approved"  && c.hiringManagerApproval !== "approved") return false;
      if (activeTab === "rejected"  && c.hiringManagerApproval !== "rejected") return false;

      // Search
      const q = query.toLowerCase();
      const matchQ = !q || `${c.firstName} ${c.lastName} ${c.email} ${c.jobTitle ?? ""}`.toLowerCase().includes(q);

      // Stage
      const matchStage = stageFilter === "all" || c.currentStage === stageFilter;

      return matchQ && matchStage;
    });
  }, [candidates, activeTab, query, stageFilter]);

  async function handleApprove(candidateId: string, approved: boolean) {
    setApproving(candidateId);
    try {
      await apiFetch(`${apiBase}/candidates/${candidateId}`, {
        method: "PATCH",
        // Explicit Content-Type: without it the browser sends text/plain and
        // express.json() leaves req.body empty → server 400s.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiringManagerApproval: approved ? "approved" : "rejected" }),
      });
      toast({ title: approved ? "Candidate approved" : "Candidate rejected" });
      setCandidates(prev => prev.map(c =>
        c.id === candidateId ? { ...c, hiringManagerApproval: approved ? "approved" : "rejected" } : c
      ));
    } catch {
      toast({ title: "Failed to update candidate", variant: "destructive" });
    } finally {
      setApproving(null);
    }
  }

  const stages = ["all", "applied", "shortlisted", "phone_screen", "interview", "offer", "hired"];

  /* Per-tab empty-state copy so the user knows what each list represents */
  const emptyState = (() => {
    switch (activeTab) {
      case "to_review": return { title: "No candidates waiting for your review", hint: "When a recruiter submits a candidate, they'll show up here for you to approve or reject." };
      case "approved":  return { title: "No approved candidates yet", hint: "Candidates you approve will be listed here." };
      case "rejected":  return { title: "No rejected candidates", hint: "Candidates you reject will be listed here." };
      case "all":       return { title: "No candidates found", hint: "Try clearing the search or stage filter." };
    }
  })();

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <Link href="/hiring/dashboard" className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-3">
            <ArrowRight className="w-4 h-4 rotate-180" /> Back to Dashboard
          </Link>
          <h1 className="text-2xl font-bold">Candidates</h1>
          <p className="text-muted-foreground text-sm mt-1">Review and approve candidates that recruiters submit to your pipeline.</p>
        </div>

        {/* Tabs — "Candidates to Review" is the default landing tab so the action queue is the first thing the user sees */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
          <TabsList className="bg-card/40 border border-border/40">
            <TabsTrigger value="to_review" data-testid="tab-to-review" className="gap-2">
              <Clock className="w-3.5 h-3.5" />
              Candidates to Review
              <Badge variant="outline" className="ml-1 text-[10px] bg-primary/10 text-primary border-primary/25">{counts.to_review}</Badge>
            </TabsTrigger>
            <TabsTrigger value="approved" data-testid="tab-approved" className="gap-2">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Approved
              <Badge variant="outline" className="ml-1 text-[10px]">{counts.approved}</Badge>
            </TabsTrigger>
            <TabsTrigger value="rejected" data-testid="tab-rejected" className="gap-2">
              <XCircle className="w-3.5 h-3.5" />
              Rejected
              <Badge variant="outline" className="ml-1 text-[10px]">{counts.rejected}</Badge>
            </TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all" className="gap-2">
              <Users className="w-3.5 h-3.5" />
              All Candidates
              <Badge variant="outline" className="ml-1 text-[10px]">{counts.all}</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search candidates…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="input-candidate-search" />
          </div>
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-44" data-testid="select-stage-filter">
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              {stages.map(s => (
                <SelectItem key={s} value={s}>{s === "all" ? "All stages" : s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="font-medium">{emptyState.title}</p>
            <p className="text-xs mt-1">{emptyState.hint}</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((c: any) => (
              <Card key={c.id} className="hover:border-border/80 transition-colors" data-testid={`card-candidate-${c.id}`}>
                <CardContent className="p-4 flex items-center gap-4">
                  <Avatar className="w-10 h-10 shrink-0">
                    <AvatarFallback className="bg-primary/10 text-primary font-bold text-sm">
                      {c.firstName?.[0]}{c.lastName?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{c.firstName} {c.lastName}</p>
                      <Badge variant="outline" className={`text-[10px] ${stageColors[c.currentStage] || "text-muted-foreground"}`}>
                        {c.currentStage?.replace(/_/g, " ") || "Applied"}
                      </Badge>
                      {c.hiringManagerApproval === "approved" && (
                        <Badge variant="outline" className="text-emerald-400 border-emerald-500/25 bg-emerald-500/10 text-[10px]">
                          <CheckCircle2 className="w-2.5 h-2.5 mr-1" />Approved
                        </Badge>
                      )}
                      {c.hiringManagerApproval === "rejected" && (
                        <Badge variant="outline" className="text-red-400 border-red-500/25 bg-red-500/10 text-[10px]">
                          <XCircle className="w-2.5 h-2.5 mr-1" />Rejected
                        </Badge>
                      )}
                      {!c.hiringManagerApproval && (
                        <Badge variant="outline" className="text-primary border-primary/25 bg-primary/10 text-[10px]">
                          <Clock className="w-2.5 h-2.5 mr-1" />Awaiting your review
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{c.jobTitle ?? c.currentTitle ?? "—"} · {c.email}</p>
                  </div>
                  {!c.hiringManagerApproval && (
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                        disabled={approving === c.id}
                        onClick={() => handleApprove(c.id, true)}
                        data-testid={`button-approve-${c.id}`}
                      >
                        <ThumbsUp className="w-3.5 h-3.5" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10"
                        disabled={approving === c.id}
                        onClick={() => handleApprove(c.id, false)}
                        data-testid={`button-reject-${c.id}`}
                      >
                        <ThumbsDown className="w-3.5 h-3.5" /> Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
