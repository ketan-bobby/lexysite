/**
 * pages/careers/index.tsx — Public Job Board
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Public-facing job listing page accessible without authentication. Candidates
 * can browse open jobs, search by keyword/location, and apply directly.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   SearchBar    — keyword + location filters; live-filters the job list
 *   JobCard      — title, company, location, employment type, salary range
 *                  (if set), days since posted; "Apply" CTA
 *   EmptyState   — "No jobs match your search" with clear filters link
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET /api/public/jobs?search=…&location=…  — no auth required
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /careers  (public; no authentication required)
 */
import { useState } from "react";
import { pluralize } from "@/lib/utils";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import {
  MapPin, Briefcase, DollarSign, Clock, Search, Zap,
  ArrowRight, Building2, ChevronRight, Loader2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PublicJob {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  workType: string;
  employmentType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  description: string | null;
  createdAt: string;
}

function workTypeLabel(wt: string) {
  return { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" }[wt] ?? wt;
}

function employmentLabel(et: string) {
  return { full_time: "Full-time", part_time: "Part-time", contract: "Contract", internship: "Internship" }[et] ?? et;
}

function salaryLabel(min: number | null, max: number | null) {
  if (!min && !max) return null;
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
  if (min && max) return `$${fmt(min)} – $${fmt(max)}`;
  if (min) return `From $${fmt(min)}`;
  return `Up to $${fmt(max!)}`;
}

function timeAgo(dateStr: string) {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 7) return `Posted ${days} days ago`;
  if (days < 30) return `Posted ${Math.floor(days / 7)}w ago`;
  return `Posted ${Math.floor(days / 30)}mo ago`;
}

export default function CareersPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("all");
  const [filterType, setFilterType] = useState("all");

  const { data, isLoading, isError } = useQuery<{ data: PublicJob[]; total: number }>({
    queryKey: ["public-jobs"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/public/jobs`);
      if (!res.ok) throw new Error("Failed to load jobs");
      return res.json();
    },
  });

  const jobs = data?.data ?? [];

  const departments = ["all", ...Array.from(new Set(jobs.map(j => j.department).filter(Boolean) as string[]))];
  const types = ["all", ...Array.from(new Set(jobs.map(j => j.workType)))];

  const filtered = jobs.filter(j => {
    const q = search.toLowerCase();
    const matchSearch = !q || j.title.toLowerCase().includes(q) || j.department?.toLowerCase().includes(q) || j.location?.toLowerCase().includes(q);
    const matchDept = filterDept === "all" || j.department === filterDept;
    const matchType = filterType === "all" || j.workType === filterType;
    return matchSearch && matchDept && matchType;
  });

  return (
    <div className="min-h-screen text-foreground">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href={`${BASE}/careers`} className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight">L3XY</span>
              <span className="text-muted-foreground text-sm ml-2">Careers</span>
            </div>
          </Link>
          {user?.role === "candidate" ? (
            <Link href={`${BASE}/portal/career`}>
              <Button size="sm" className="gap-1.5">My Portal</Button>
            </Link>
          ) : user ? (
            <Link href={`${BASE}/dashboard`}>
              <Button variant="outline" size="sm">Dashboard</Button>
            </Link>
          ) : (
            <Link href={`${BASE}/portal/login`}>
              <Button variant="outline" size="sm">Sign in</Button>
            </Link>
          )}
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-medium mb-6">
          <Zap className="w-3 h-3" />
          {isLoading ? "Loading…" : pluralize(jobs.length, "open position")}
        </div>
        <h1 className="text-5xl font-bold tracking-tight mb-4">
          Join a team building<br />
          <span className="text-primary">the future of hiring</span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          We're looking for exceptional people who want to reshape how the world finds talent.
        </p>
      </section>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-6 pb-8">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search roles, teams, or locations…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 bg-muted/30 border-border/50"
            />
          </div>
          <select
            value={filterDept}
            onChange={e => setFilterDept(e.target.value)}
            className="h-10 rounded-md border border-border/50 bg-muted/30 px-3 text-sm text-foreground min-w-36"
          >
            {departments.map(d => (
              <option key={d} value={d}>{d === "all" ? "All departments" : d}</option>
            ))}
          </select>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="h-10 rounded-md border border-border/50 bg-muted/30 px-3 text-sm text-foreground min-w-36"
          >
            {types.map(t => (
              <option key={t} value={t}>{t === "all" ? "All work types" : workTypeLabel(t)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Jobs List ─────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-6 pb-24">
        {isLoading && (
          <div className="flex items-center justify-center py-24 gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Loading open positions…</span>
          </div>
        )}

        {isError && (
          <div className="text-center py-24 text-muted-foreground">
            <p className="text-lg mb-2">Could not load jobs right now</p>
            <p className="text-sm">Please try again in a moment.</p>
          </div>
        )}

        {!isLoading && !isError && filtered.length === 0 && (
          <div className="text-center py-24 text-muted-foreground">
            <Building2 className="w-10 h-10 mx-auto mb-4 opacity-30" />
            <p className="text-lg mb-1">No positions match your search</p>
            <p className="text-sm">Try adjusting your filters or check back soon.</p>
          </div>
        )}

        {!isLoading && !isError && filtered.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground mb-4">
              {pluralize(filtered.length, "position")}
              {search || filterDept !== "all" || filterType !== "all" ? " matching your criteria" : ""}
            </p>
            {filtered.map(job => {
              const salary = salaryLabel(job.salaryMin, job.salaryMax);
              return (
                <Link key={job.id} href={`${BASE}/careers/${job.id}`}>
                  <div className="group flex items-center justify-between gap-4 p-5 rounded-xl border border-border/50 bg-card/50 hover:border-primary/40 hover:bg-card transition-all cursor-pointer">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                          <Briefcase className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h2 className="font-semibold text-base group-hover:text-primary transition-colors leading-tight">
                            {job.title}
                          </h2>
                          {job.department && (
                            <p className="text-sm text-muted-foreground">{job.department}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 ml-12 text-xs text-muted-foreground">
                        {job.location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3" /> {job.location}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {workTypeLabel(job.workType)}
                        </span>
                        <span>{employmentLabel(job.employmentType)}</span>
                        {salary && (
                          <span className="flex items-center gap-1">
                            <DollarSign className="w-3 h-3" /> {salary}
                          </span>
                        )}
                        <span className="text-muted-foreground/60">{timeAgo(job.createdAt)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <Badge variant="outline" className="text-xs border-border/50 hidden sm:inline-flex">
                        {workTypeLabel(job.workType)}
                      </Badge>
                      <div className="w-8 h-8 rounded-full bg-muted/50 group-hover:bg-primary/10 flex items-center justify-center transition-colors">
                        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border/30 py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>Powered by <span className="text-primary font-semibold">L3XY</span> — AI Hiring Platform</span>
          <span>© {new Date().getFullYear()}</span>
        </div>
      </footer>
    </div>
  );
}
