/**
 * pages/recruiter/talent-match.tsx — Talent Match Explorer
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Pick a job and see the ranked candidate shortlist from the internal pool,
 * scored by ICP fit. Used to identify talent re-deployment opportunities
 * (candidates sourced/rejected for one role who fit another open role).
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useListJobs()                       — job picker
 *   POST /api/talent-match/rediscover   — ranked candidates for the selected job
 *     (prefers each candidate's accrued talentMatchScore; falls back to a
 *      deterministic ICP-signal heuristic, never random)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/talent-match
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { useListJobs, useRediscoverCandidates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Magnet, Zap, TrendingUp, Star, MapPin, Building, CheckCircle, XCircle, ArrowRight, ChevronRight, Loader2, SearchX } from "lucide-react";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { bandBy } from "@/lib/score-band";

// Exceptional-match star flourish — a highlight above the strong band, not a colour band.
const TOP_MATCH_STAR_MIN = 90;

// Talent Match Explorer: pick a job, see candidates ranked by ICP fit score.
export default function TalentMatch() {
  const { data: jobsData } = useListJobs({ limit: 20 });
  const jobs = (jobsData as any)?.jobs || [];
  const [selectedJob, setSelectedJob] = useState<string>("");
  const rediscover = useRediscoverCandidates();

  // Land on the first job once the list loads.
  useEffect(() => {
    if (!selectedJob && jobs.length) setSelectedJob(jobs[0].id);
  }, [jobs, selectedJob]);

  // Fetch the ranked shortlist whenever the selected job changes.
  useEffect(() => {
    if (selectedJob) rediscover.mutate({ data: { jobId: selectedJob, limit: 25 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob]);

  const matches = (rediscover.data ?? []) as any[];
  const loading = rediscover.isPending;
  const errored = rediscover.isError;
  const selectedJobTitle = jobs.find((j: any) => j.id === selectedJob)?.title;

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title">Talent Match</h1>
          <p className="text-muted-foreground mt-1">AI-scored candidate rankings based on your Ideal Candidate Profile.</p>
        </div>
        <Button
          className="gap-2"
          disabled={!selectedJob || loading}
          onClick={() => selectedJob && rediscover.mutate({ data: { jobId: selectedJob, limit: 25 } })}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Run Fresh Match
        </Button>
      </div>

      <Card className="mb-6 bg-primary/2 border-primary/20">
        <CardContent className="p-5 flex flex-col md:flex-row items-center gap-4">
          <div className="flex items-center gap-3 flex-1">
            <Magnet className="w-5 h-5 text-primary" />
            <div>
              <p className="text-sm font-medium">Match Against Job</p>
              <p className="text-xs text-muted-foreground">Select a job to see ranked candidates from your pipeline</p>
            </div>
          </div>
          <Select value={selectedJob} onValueChange={setSelectedJob}>
            <SelectTrigger className="w-full md:w-72">
              <SelectValue placeholder="Select a job..." />
            </SelectTrigger>
            <SelectContent>
              {jobs.map((j: any) => (
                <SelectItem key={j.id} value={j.id}>{j.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedJob && (
            <Link href={`/jobs/${selectedJob}`}>
              <Button variant="outline" className="gap-2 flex-shrink-0">
                <TrendingUp className="w-4 h-4" /> View ICP
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>

      {/* ── Loading ─────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin mb-3" />
          <p className="text-sm">Scoring candidates against {selectedJobTitle || "the role"}…</p>
        </div>
      )}

      {/* ── Empty: no job selected ──────────────────────────────────────────── */}
      {!loading && !selectedJob && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <Magnet className="w-8 h-8 mb-3 opacity-40" />
          <p className="text-sm">Select a job above to see ranked candidate matches.</p>
        </div>
      )}

      {/* ── Error: rediscover failed ────────────────────────────────────────── */}
      {!loading && errored && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <XCircle className="w-8 h-8 mb-3 text-orange-400/70" />
          <p className="text-sm">Couldn't load matches for this role.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 gap-2"
            onClick={() => selectedJob && rediscover.mutate({ data: { jobId: selectedJob, limit: 25 } })}
          >
            <Zap className="w-3.5 h-3.5" /> Retry
          </Button>
        </div>
      )}

      {/* ── Empty: job selected but no matches ──────────────────────────────── */}
      {!loading && !errored && selectedJob && matches.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <SearchX className="w-8 h-8 mb-3 opacity-40" />
          <p className="text-sm">No candidates in your pool match this role yet.</p>
          <p className="text-xs mt-1 opacity-70">Source or add candidates, then run a match.</p>
        </div>
      )}

      {/* ── Ranked results ──────────────────────────────────────────────────── */}
      {!loading && matches.length > 0 && (
        <div className="space-y-4">
          {matches.map((m, idx) => {
            const cand = m.candidate || {};
            const score = m.fitScore ?? 0;
            const strengths: string[] = m.strengths || [];
            const gaps: string[] = m.gaps || [];
            // A preliminary score is a deterministic profile heuristic, not a
            // calibrated AI screen — render it neutrally and flag it so a
            // thin-evidence estimate doesn't read as a firm match.
            const preliminary = !!m.preliminary;
            return (
              <Card key={m.candidateId || idx} className="hover-elevate border-border/60 group">
                <CardContent className="p-6">
                  <div className="flex items-start gap-5">
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <div className={`text-2xl font-black ${preliminary ? "text-slate-400" : bandBy(score, { strong: "text-green-600", good: "text-primary", fair: "text-orange-500" })}`}>
                        {score}%
                      </div>
                      <div className="text-[10px] text-muted-foreground font-medium">{preliminary ? "Est. Match" : "Match"}</div>
                      {preliminary && (
                        <div className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/25 whitespace-nowrap">
                          Preliminary
                        </div>
                      )}
                      <div className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${idx === 0 ? "bg-green-100 text-green-700" : idx === 1 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                        #{idx + 1}
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-bold text-lg group-hover:text-primary transition-colors">{cand.firstName} {cand.lastName}</h3>
                        {score >= TOP_MATCH_STAR_MIN && <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />}
                      </div>
                      <p className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
                        {(cand.currentTitle || cand.currentCompany) && (
                          <>
                            <Building className="w-3.5 h-3.5" /> {cand.currentTitle}{cand.currentCompany ? ` at ${cand.currentCompany}` : ""}
                          </>
                        )}
                        {cand.location && (
                          <>
                            <span className="mx-1">•</span>
                            <MapPin className="w-3.5 h-3.5" /> {cand.location}
                          </>
                        )}
                      </p>
                      {m.matchExplanation && (
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{m.matchExplanation}</p>
                      )}

                      <div className="flex gap-6 mt-3 flex-wrap">
                        {strengths.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> Strengths</p>
                            <div className="flex gap-1.5 flex-wrap">
                              {strengths.map((s) => (
                                <Badge key={s} variant="secondary" className="text-[10px] bg-green-100 text-green-800 border-0">{s}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {gaps.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1"><XCircle className="w-3.5 h-3.5 text-orange-400" /> Gaps</p>
                            <div className="flex gap-1.5 flex-wrap">
                              {gaps.map((g) => (
                                <Badge key={g} variant="secondary" className="text-[10px] bg-orange-100 text-orange-800 border-0">{g}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 flex-shrink-0">
                      <Link href={`/candidates/${m.candidateId}`}>
                        <Button size="sm" className="gap-1.5 w-full">View Profile <ChevronRight className="w-3.5 h-3.5" /></Button>
                      </Link>
                      <Button size="sm" variant="outline" className="gap-1.5">Add to Pipeline <ArrowRight className="w-3.5 h-3.5" /></Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
