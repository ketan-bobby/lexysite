/**
 * pages/recruiter/internal-talent.tsx — Internal Talent dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * A dedicated front door for INTERNAL mobility: your company's own bench —
 * current employees plus every candidate already saved into your tenant pool.
 * The Intelligence Engine always surfaces these people first inside any search;
 * this page makes that channel browsable on its own so recruiters and people
 * teams can answer "who do we already have?" before sourcing externally.
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 * GET /api/candidates?pool=tenant  — tenant-scoped internal pool (real data).
 *   Each row carries isCurrentEmployee, currentTitle/Company, skills,
 *   talentMatchScore (internal fit) and updatedAt (used to derive recent
 *   activity, since the API only computes activityStatus for the platform pool).
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /internal-talent  (registered in App.tsx, recruiter roles)
 */
import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { bandBy } from "@/lib/score-band";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBase, apiFetch } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { CsvImportDialog } from "@/components/candidates/CsvImportDialog";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import {
  Search, Users, Building2, Brain, Sparkles, TrendingUp, Activity,
  ArrowRight, Briefcase, ChevronRight, Upload, Loader2,
  type LucideIcon,
} from "lucide-react";

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface InternalCandidate {
  id: string;
  firstName: string;
  lastName: string;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  skills: string[];
  talentMatchScore: number | null;
  isCurrentEmployee?: boolean;
  updatedAt?: string | null;
  applicationCount?: number;
}

type Filter = "all" | "employees" | "saved";
type SortKey = "fit" | "name" | "recent";

/* Tenant-pool rows don't carry a server-computed activityStatus (the API only
   computes it for platform-pool candidates), so derive "recently active" from
   updatedAt — the best signal available for internal records. */
function isRecentlyActive(c: InternalCandidate): boolean {
  if (!c.updatedAt) return false;
  const days = (Date.now() - new Date(c.updatedAt).getTime()) / 86_400_000;
  return Number.isFinite(days) && days <= 30;
}

/* ─── Fit score color — a candidate↔role MATCH surface: use the canonical band ─ */
function fitColor(v: number) {
  return bandBy(v, { strong: "#10b981", good: "#06b6d4", fair: "#f59e0b" });
}

/* ─── KPI card ─────────────────────────────────────────────────────────────── */
function Kpi({
  icon: Icon, label, value, accent,
}: { icon: LucideIcon; label: string; value: string | number; accent: string }) {
  return (
    <Card className="border-border/40 bg-card/80 backdrop-blur">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", accent)}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-extrabold tabular-nums leading-none">{value}</div>
          <div className="text-[11px] text-muted-foreground mt-1 truncate">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Candidate row ────────────────────────────────────────────────────────── */
function Row({
  c, onToggleEmployee, toggling,
}: {
  c: InternalCandidate;
  onToggleEmployee: (id: string, next: boolean) => void;
  toggling: boolean;
}) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
  const initials = name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  const fit = c.talentMatchScore;

  return (
    <Card className="border-border/40 bg-card/80 backdrop-blur hover:border-primary/30 transition-all group">
      <CardContent className="p-4 flex items-center gap-4">
        <Avatar className="h-11 w-11 border border-border/40 shrink-0">
          <AvatarFallback className={cn(
            "font-bold text-sm",
            c.isCurrentEmployee ? "bg-emerald-500/15 text-emerald-400" : "bg-primary/10 text-primary",
          )}>
            {initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/candidates/${c.id}`}>
              <span className="font-semibold text-foreground hover:text-primary transition-colors cursor-pointer text-sm truncate">
                {name}
              </span>
            </Link>
            {c.isCurrentEmployee && (
              <Badge className="text-[9px] px-1.5 py-0 h-4 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium gap-0.5 flex items-center">
                <Building2 className="w-2.5 h-2.5" /> Current employee
              </Badge>
            )}
            {isRecentlyActive(c) && (
              <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0 h-4 rounded-full border font-medium text-emerald-400 bg-emerald-500/10 border-emerald-500/25">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {c.currentTitle || "No title"}
            {c.currentCompany ? ` · ${c.currentCompany}` : ""}
            {c.location ? ` · ${c.location}` : ""}
          </div>
          {c.skills?.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {c.skills.slice(0, 4).map(s => (
                <Badge key={s} variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-border/50 text-muted-foreground font-normal">
                  {s}
                </Badge>
              ))}
              {c.skills.length > 4 && (
                <span className="text-[9px] text-muted-foreground">+{c.skills.length - 4}</span>
              )}
            </div>
          )}
        </div>

        {/* Current-employee toggle */}
        <div className="flex flex-col items-center gap-1 shrink-0" title="Mark as a current employee">
          {toggling ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={!!c.isCurrentEmployee}
              onCheckedChange={next => onToggleEmployee(c.id, next)}
              aria-label="Mark as current employee"
              className="data-[state=checked]:bg-emerald-500"
            />
          )}
          <span className="text-[8px] text-muted-foreground">Employee</span>
        </div>

        {/* Internal fit */}
        <div className="flex flex-col items-center w-14 shrink-0">
          {fit != null ? (
            <>
              <span className="text-lg font-extrabold tabular-nums leading-none" style={{ color: fitColor(fit) }}>
                {fit}%
              </span>
              <span className="text-[8px] text-muted-foreground mt-0.5">Internal fit</span>
            </>
          ) : (
            <>
              <span className="text-lg font-bold text-muted-foreground leading-none">—</span>
              <span className="text-[8px] text-muted-foreground mt-0.5">Internal fit</span>
            </>
          )}
        </div>

        <Link href={`/candidates/${c.id}`}>
          <span className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary">
            <ChevronRight className="w-4 h-4" />
          </span>
        </Link>
      </CardContent>
    </Card>
  );
}

/* ─── Page ─────────────────────────────────────────────────────────────────── */
export default function InternalTalent() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("fit");
  const [importOpen, setImportOpen] = useState(false);

  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery<{ candidates: InternalCandidate[] }>({
    queryKey: ["internal-talent"],
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/candidates?pool=tenant&limit=500`);
      if (!res.ok) throw new Error("Failed to load internal talent");
      return res.json();
    },
  });

  /* Mark / unmark a single person as a current employee. */
  const toggleEmployee = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      const res = await apiFetch(`${apiBase}/candidates/${id}/employee-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isCurrentEmployee: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to update employee status");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["internal-talent"] });
      toast({
        title: vars.next ? "Marked as current employee" : "Removed from current employees",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update", description: err.message, variant: "destructive" });
    },
  });
  const togglingId = toggleEmployee.isPending ? toggleEmployee.variables?.id : undefined;

  const all = data?.candidates ?? [];

  /* KPIs */
  const employeeCount = all.filter(c => c.isCurrentEmployee).length;
  const activeCount = all.filter(isRecentlyActive).length;
  const scored = all.filter(c => c.talentMatchScore != null);
  const avgFit = scored.length
    ? Math.round(scored.reduce((s, c) => s + (c.talentMatchScore ?? 0), 0) / scored.length)
    : null;

  /* Filter + search + sort. Current employees always pinned to the top so
     internal mobility candidates are never buried — mirrors the engine's
     own "employees always surface first" rule on the sourcing side. */
  const rows = useMemo(() => {
    let list = all;
    if (filter === "employees") list = list.filter(c => c.isCurrentEmployee);
    if (filter === "saved") list = list.filter(c => !c.isCurrentEmployee);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        `${c.firstName} ${c.lastName} ${c.currentTitle ?? ""} ${c.currentCompany ?? ""} ${(c.skills ?? []).join(" ")}`
          .toLowerCase().includes(q),
      );
    }
    const sorted = [...list].sort((a, b) => {
      if (sort === "name") {
        return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
      }
      if (sort === "fit") {
        return (b.talentMatchScore ?? -1) - (a.talentMatchScore ?? -1);
      }
      return 0; // recent — API already returns newest-first
    });
    // Pin current employees first regardless of sort.
    return [
      ...sorted.filter(c => c.isCurrentEmployee),
      ...sorted.filter(c => !c.isCurrentEmployee),
    ];
  }, [all, filter, search, sort]);

  const filterTabs: { key: Filter; label: string }[] = [
    { key: "all", label: `All (${all.length})` },
    { key: "employees", label: `Current employees (${employeeCount})` },
    { key: "saved", label: `Saved candidates (${all.length - employeeCount})` },
  ];

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Users className="w-7 h-7 text-primary" /> Internal Talent
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Your own bench — current employees and every candidate already in your database.
            Check who you already have before you source externally.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4" /> Import employees
          </Button>
          <Link href="/sourcing">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline cursor-pointer">
              Go to Sourcing <ArrowRight className="w-4 h-4" />
            </span>
          </Link>
        </div>
      </div>

      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} isCurrentEmployee />


      {/* Intelligence Engine framing */}
      <Card className="mb-6 border-primary/25 bg-gradient-to-r from-primary/8 to-violet-500/5">
        <CardContent className="p-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Brain className="w-5 h-5 text-primary" />
          </div>
          <div className="text-sm text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">The Intelligence Engine checks here first.</span>{" "}
            Every search you run always scans your internal database, and current employees are surfaced
            ahead of external candidates — so internal mobility is never missed. This page is the deliberate
            front door to that same pool.
          </div>
          <Sparkles className="w-4 h-4 text-primary/60 shrink-0 mt-1" />
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Kpi icon={Users} label="Internal candidates" value={all.length} accent="bg-primary/15 text-primary" />
        <Kpi icon={Building2} label="Current employees" value={employeeCount} accent="bg-emerald-500/15 text-emerald-400" />
        <Kpi icon={TrendingUp} label="Avg internal fit" value={avgFit != null ? `${avgFit}%` : "—"} accent="bg-violet-500/15 text-violet-400" />
        <Kpi icon={Activity} label="Active (30d)" value={activeCount} accent="bg-amber-500/15 text-amber-400" />
      </div>

      {/* Controls */}
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search by name, title, company, or skill…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border/50 p-1 bg-card/60">
          {filterTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap",
                filter === t.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
          className="px-3 py-2 text-sm bg-card/60 border border-border/50 rounded-lg outline-none focus:border-primary/50 text-foreground"
        >
          <option value="fit">Sort: Internal fit</option>
          <option value="name">Sort: Name</option>
          <option value="recent">Sort: Recently added</option>
        </select>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-[84px] bg-muted/20 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-8 text-center text-sm text-destructive">
            Couldn't load internal talent. Please refresh and try again.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="border-border/40 bg-card/60">
          <CardContent className="p-12 text-center">
            <Briefcase className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <h3 className="font-semibold text-foreground">No internal candidates yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {search || filter !== "all"
                ? "No one matches your current filters."
                : "As you save candidates and import employees, your internal bench will appear here — and the engine will surface them first in every search."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map(c => (
            <Row
              key={c.id}
              c={c}
              onToggleEmployee={(id, next) => toggleEmployee.mutate({ id, next })}
              toggling={togglingId === c.id}
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
