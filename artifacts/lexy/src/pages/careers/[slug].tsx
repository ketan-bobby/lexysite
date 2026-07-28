/**
 * pages/careers/[slug].tsx — Tenant-Branded Public Job Board
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Tenant-specific public careers page, reached via /:slug (e.g. /linx-ae).
 * Shows the tenant's branding (logo, name, accent colour) and lists only that
 * tenant's open jobs. Used when a company wants a branded careers portal URL
 * rather than the generic /careers page.
 *
 * ─── Tenant resolution ───────────────────────────────────────────────────────
 * GET /api/public/tenants/:slug → { name, logoUrl, accentColor, jobs[] }
 * If the slug doesn't match any tenant → 404 page.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   BrandedHeader  — tenant logo + name + tagline
 *   SearchBar      — keyword search on the tenant's jobs
 *   JobCard        — same as /careers/index.tsx JobCard
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /careers/:slug  (public; resolves tenant by slug, not UUID)
 */
import { useState } from "react";
import { pluralize } from "@/lib/utils";
import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  MapPin, Briefcase, DollarSign, Clock, Search,
  Building2, ChevronRight, Loader2, Globe, AlertCircle, Lock,
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
  isConfidential?: boolean;
  postingLabel?: string | null;
}
interface TenantBranding {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
  website: string | null;
  industry: string | null;
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

export default function ClientCareersPage() {
  const [, params] = useRoute("/company/:slug");
  const slug = params?.slug ?? "";

  const [search, setSearch]       = useState("");
  const [filterDept, setFilterDept] = useState("all");
  const [filterType, setFilterType] = useState("all");

  const { data, isLoading, isError } = useQuery<{ tenant: TenantBranding; jobs: PublicJob[]; total: number }>({
    queryKey: ["careers-slug", slug],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/public/careers/${slug}`);
      if (!res.ok) throw new Error("not_found");
      return res.json();
    },
    enabled: !!slug,
    retry: false,
  });

  const tenant = data?.tenant;
  const jobs   = data?.jobs ?? [];
  const accent = tenant?.primaryColor || "#6366f1";

  const departments = ["all", ...Array.from(new Set(jobs.map(j => j.department).filter(Boolean) as string[]))];
  const types       = ["all", ...Array.from(new Set(jobs.map(j => j.workType)))];

  const filtered = jobs.filter(j => {
    const q = search.toLowerCase();
    const matchSearch = !q || j.title.toLowerCase().includes(q) || j.department?.toLowerCase().includes(q) || j.location?.toLowerCase().includes(q);
    const matchDept = filterDept === "all" || j.department === filterDept;
    const matchType = filterType === "all" || j.workType === filterType;
    return matchSearch && matchDept && matchType;
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground gap-3">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Loading careers page…</span>
      </div>
    );
  }

  if (isError || !tenant) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-6 gap-4">
        <AlertCircle className="w-10 h-10 text-muted-foreground/40" />
        <h1 className="text-2xl font-bold">Careers page not found</h1>
        <p className="text-muted-foreground max-w-sm">
          This careers page doesn't exist or the link may have changed.
        </p>
        <Link href={`${BASE}/careers`}>
          <Button variant="outline">Browse all open roles</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground">
      <style>{`
        :root { --accent-careers: ${accent}; }
        .careers-accent { color: ${accent} !important; }
        .careers-accent-bg { background-color: ${accent}1a !important; border-color: ${accent}33 !important; }
        .careers-accent-hover:hover { border-color: ${accent}66 !important; }
        .careers-accent-btn { background-color: ${accent} !important; color: #fff !important; }
      `}</style>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="border-b border-border/50 bg-background/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {tenant.logoUrl ? (
              <img src={tenant.logoUrl} alt={tenant.name} className="h-8 w-auto object-contain" />
            ) : (
              <div className="w-8 h-8 rounded-lg flex items-center justify-center careers-accent-bg">
                <Building2 className="w-4 h-4 careers-accent" />
              </div>
            )}
            <div>
              <span className="font-bold text-lg tracking-tight">{tenant.name}</span>
              <span className="text-muted-foreground text-sm ml-2">Careers</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {tenant.website && (
              <a href={tenant.website} target="_blank" rel="noopener noreferrer">
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <Globe className="w-3.5 h-3.5" /> Website
                </Button>
              </a>
            )}
            <Link href={`${BASE}/portal/login`}>
              <Button variant="outline" size="sm">Sign in</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-6 careers-accent-bg careers-accent">
          <Briefcase className="w-3 h-3" />
          {pluralize(jobs.length, "open position")}
          {tenant.industry ? ` · ${tenant.industry}` : ""}
        </div>
        <h1 className="text-5xl font-bold tracking-tight mb-4">
          Join <span className="careers-accent">{tenant.name}</span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          Explore open roles and find the opportunity that matches your skills and ambitions.
        </p>
      </section>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
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
          {departments.length > 1 && (
            <select
              value={filterDept}
              onChange={e => setFilterDept(e.target.value)}
              className="h-10 rounded-md border border-border/50 bg-muted/30 px-3 text-sm text-foreground min-w-36"
            >
              {departments.map(d => (
                <option key={d} value={d}>{d === "all" ? "All departments" : d}</option>
              ))}
            </select>
          )}
          {types.length > 1 && (
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="h-10 rounded-md border border-border/50 bg-muted/30 px-3 text-sm text-foreground min-w-36"
            >
              {types.map(t => (
                <option key={t} value={t}>{t === "all" ? "All work types" : workTypeLabel(t)}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ── Jobs List ───────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-6 pb-24">
        {filtered.length === 0 && (
          <div className="text-center py-24 text-muted-foreground">
            <Building2 className="w-10 h-10 mx-auto mb-4 opacity-30" />
            <p className="text-lg mb-1">
              {jobs.length === 0 ? "No open positions right now" : "No positions match your search"}
            </p>
            <p className="text-sm">
              {jobs.length === 0
                ? "Check back soon — new roles are added regularly."
                : "Try adjusting your filters or check back soon."}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground mb-4">
              {pluralize(filtered.length, "position")}
              {search || filterDept !== "all" || filterType !== "all" ? " matching your criteria" : ""}
            </p>
            {filtered.map(job => {
              const salary = salaryLabel(job.salaryMin, job.salaryMax);
              return (
                <Link key={job.id} href={`${BASE}/careers/${job.id}`}>
                  <div className="group flex items-center justify-between gap-4 p-5 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-all cursor-pointer careers-accent-hover">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-3 mb-2">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5 careers-accent-bg">
                          <Briefcase className="w-4 h-4 careers-accent" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="font-semibold text-base group-hover:careers-accent transition-colors leading-tight careers-accent-hover-text">
                              {job.title}
                            </h2>
                            {job.isConfidential && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-amber-500/30 text-amber-500 bg-amber-500/8 shrink-0">
                                <Lock className="w-2.5 h-2.5" /> Confidential Client
                              </span>
                            )}
                          </div>
                          {job.department && (
                            <p className="text-sm text-muted-foreground">{job.department}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 ml-12 text-xs text-muted-foreground">
                        {job.location && (
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {job.location}</span>
                        )}
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {workTypeLabel(job.workType)}</span>
                        <span>{employmentLabel(job.employmentType)}</span>
                        {salary && (
                          <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> {salary}</span>
                        )}
                        <span className="text-muted-foreground/60">{timeAgo(job.createdAt)}</span>
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <Badge variant="outline" className="text-xs border-border/50 hidden sm:inline-flex">
                        {workTypeLabel(job.workType)}
                      </Badge>
                      <div className="w-8 h-8 rounded-full bg-muted/50 flex items-center justify-center transition-colors group-hover:careers-accent-bg">
                        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:careers-accent" />
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border/30 py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between text-xs text-muted-foreground flex-wrap gap-2">
          <span>
            {tenant.name} · Careers
            {tenant.website && (
              <> · <a href={tenant.website} target="_blank" rel="noopener noreferrer" className="hover:text-foreground underline">{tenant.website.replace(/^https?:\/\//, "")}</a></>
            )}
          </span>
          <span>Powered by <span className="careers-accent font-semibold">L3XY</span> — AI Hiring Platform</span>
        </div>
      </footer>
    </div>
  );
}
