/**
 * pages/recruiter/market-intelligence.tsx — Market Intelligence Q&A (Step 1).
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The front door for the Market Intelligence layer. Step 1 ships the four
 * read-only DATA TOOLS (no AI reasoning yet): a recruiter enters a role
 * (+ optional skills / location) and the page runs all four tools against
 * real platform data, showing each tool's raw honest result:
 *   • Hiring Velocity   — median days-to-fill + sourced-to-hire ratio
 *   • Candidate Supply  — recent sourcing-search yield + trend + recency
 *   • Comp Signal       — anonymized aggregate salary expectations (k≥5)
 *   • Internal Bench    — does YOUR own pool already have these people?
 *
 * ─── Honest-empty doctrine ──────────────────────────────────────────────────
 * A tool that has no/insufficient data says so explicitly ({status:"no_data",
 * reason}) — the UI renders the reason verbatim, never a fake 0.
 *
 * ─── Route ──────────────────────────────────────────────────────────────────
 *   /market-intelligence  (App.tsx, recruiter roles)
 */
import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiBase, apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Handshake,
  LineChart, Users, DollarSign, Building2, Search, Loader2, Clock,
  TrendingUp, TrendingDown, Minus, Sparkles, ShieldCheck, ChevronDown,
  UserCheck, ArrowRight, BookOpen, UserPlus, type LucideIcon,
} from "lucide-react";
import { Link } from "wouter";
import { EngageLinxDialog } from "@/components/linx/engage-linx";

/* ─── Types (mirror the tool contract) ───────────────────────────────────── */
type NoData = { status: "no_data"; asOf: string; reason: string };
type Ok<T> = { status: "ok"; asOf: string } & T;
type ToolResult<T> = Ok<T> | NoData;

interface Velocity { medianDaysToFill: number; p25DaysToFill: number; p75DaysToFill: number; sourcedToHireRatio: number | null; sampleSize: number; sourcedSampleSize: number; scope: string }
interface Supply { searchesInWindow: number; totalCandidatesFound: number; avgFoundPerSearch: number; trend: "up" | "down" | "flat" | null; windowDays: number; basedOn: string }
interface Comp { sampleSize: number; medianLow: number; medianHigh: number; p25Low: number; p75High: number; note: string }
interface Bench { matchCount: number; currentEmployeeCount: number; topMatches: Array<{ candidateId: string; name: string; title: string; matchScore: number; isCurrentEmployee: boolean }>; note: string }

interface QueryParams { role: string; skills: string; location: string }

/* ─── Step 2: Ask Lexy (reasoning layer) ─────────────────────────────────── */
interface AskSource {
  tool: string;
  params: { role: string; skills?: string[]; location?: string };
  asOf: string;
  status: "ok" | "no_data";
  sampleSize?: number;
  summary: string;
}
interface BenchMatch { candidateId: string; name: string; title: string; matchScore: number; isCurrentEmployee: boolean }
interface AskResult {
  answer: string;
  confidence: string;
  sources: AskSource[];
  coverage: { toolsCalled: number; okCount: number; noDataCount: number; sufficient: boolean };
  /** Structured internal-bench matches from the REAL tool call — actionable cards. */
  benchMatches?: BenchMatch[];
  /** SEPARATE lower-trust channel: server-scrubbed general industry guidance
   *  (cold start only). Rendered visually distinct, never mixed into answer. */
  generalGuidance?: string;
}

/** One turn in the chat: the recruiter's question + Lexy's grounded answer. */
interface ChatTurn {
  id: number;
  question: string;
  result?: AskResult;
  error?: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  get_internal_bench: "Internal bench",
  get_candidate_supply: "Candidate supply",
  get_hiring_velocity: "Hiring velocity",
  get_comp_signal: "Comp signal",
};

async function askLexy(question: string): Promise<AskResult> {
  const res = await apiFetch(`${apiBase}/market-intelligence/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function runTool<T>(path: string, p: QueryParams): Promise<ToolResult<T>> {
  const qs = new URLSearchParams({ role: p.role });
  if (p.skills.trim()) qs.set("skills", p.skills);
  if (p.location.trim()) qs.set("location", p.location);
  const res = await apiFetch(`${apiBase}/market-intelligence/${path}?${qs}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function fmtMoney(n: number) {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}

/* ─── Shared card chrome ─────────────────────────────────────────────────── */
function ToolCard({
  icon: Icon, title, subtitle, result, isLoading, error, children,
}: {
  icon: LucideIcon; title: string; subtitle: string;
  result: ToolResult<any> | undefined; isLoading: boolean; error: unknown;
  children: (ok: Ok<any>) => React.ReactNode;
}) {
  return (
    <Card data-testid={`card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking real platform data…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive py-2">Tool failed to run. Try again.</p>
        ) : !result ? null : result.status === "no_data" ? (
          <div className="py-2">
            <Badge variant="outline" className="mb-2">No data</Badge>
            <p className="text-sm text-muted-foreground">{result.reason}</p>
          </div>
        ) : (
          children(result)
        )}
        {result && (
          <p className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="w-3 h-3" /> as of {new Date(result.asOf).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Ask Lexy chat pieces ───────────────────────────────────────────────── */

/** Visible coverage indicator: how many of the 4 data categories backed the
 *  answer. When the lower-trust guidance channel is present, the badge says so
 *  honestly — it must NEVER launder "generic advice attached" into a
 *  full/partial-coverage look. */
function CoverageBadge({ coverage, hasGuidance }: { coverage: AskResult["coverage"]; hasGuidance?: boolean }) {
  if (!coverage.sufficient) {
    return (
      <Badge variant="outline" className="text-[10px] border-orange-400/60 text-orange-600 dark:text-orange-400" data-testid="badge-coverage">
        {hasGuidance ? "No platform data · general guidance only" : "Insufficient data"}
      </Badge>
    );
  }
  if (hasGuidance) {
    // Thin data (guidance only fires at ≤1 category) — never show this as clean coverage.
    return (
      <Badge variant="outline" className="text-[10px] border-amber-400/60 text-amber-600 dark:text-amber-400" data-testid="badge-coverage">
        Limited platform data ({coverage.okCount}/4) + general guidance
      </Badge>
    );
  }
  const full = coverage.okCount === 4;
  return (
    <Badge
      variant="secondary"
      className={`text-[10px] ${full ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : ""}`}
      data-testid="badge-coverage"
    >
      {full ? "Full coverage" : `Partial coverage · ${coverage.okCount}/4 data sources`}
    </Badge>
  );
}

/** Structurally SEPARATE lower-trust block: general industry guidance for
 *  cold-start tenants. Dashed amber chrome + explicit label so it can never
 *  be mistaken for platform data. Content is already server-scrubbed of any
 *  specific figures. */
function GeneralGuidanceBlock({ text }: { text: string }) {
  return (
    <div
      className="rounded-lg border border-dashed border-amber-400/60 bg-amber-500/5 px-4 py-3 space-y-1.5"
      data-testid="block-general-guidance"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <BookOpen className="w-3.5 h-3.5 shrink-0" />
        General industry guidance — not from your platform data
      </p>
      <p className="text-sm whitespace-pre-line text-muted-foreground" data-testid="text-general-guidance">{text}</p>
    </div>
  );
}

/** Cold-start next steps: turn a thin-data answer into action, not a dead end. */
function ThinDataActions() {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="row-thin-data-actions">
      <Link href="/jobs">
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" data-testid="button-start-sourcing">
          <Search className="w-3.5 h-3.5" /> Start a sourcing search
        </Button>
      </Link>
      <Link href="/candidates">
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" data-testid="button-add-candidates">
          <UserPlus className="w-3.5 h-3.5" /> Add candidates
        </Button>
      </Link>
    </div>
  );
}

/** Actionable internal-bench candidate cards — the internal-first doctrine, clickable. */
function BenchMatchCards({ matches }: { matches: BenchMatch[] }) {
  return (
    <div className="space-y-1.5" data-testid="ask-bench-matches">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
        <Building2 className="w-3.5 h-3.5 text-primary" /> Already in your talent pool — start here
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {matches.slice(0, 6).map(m => (
          <Link key={m.candidateId} href={`/candidates/${m.candidateId}`}>
            <div
              className="group flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 hover:border-primary/50 hover:bg-muted/60 cursor-pointer transition-colors"
              data-testid={`card-bench-match-${m.candidateId}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate flex items-center gap-1.5">
                  {m.name || "Unnamed candidate"}
                  {m.isCurrentEmployee && (
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 gap-0.5">
                      <UserCheck className="w-2.5 h-2.5" /> Employee
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground truncate">{m.title || "No title on file"}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs font-semibold">{m.matchScore}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Collapsible citation list — every claim traceable to a tool, timestamp, sample size. */
function SourceList({ sources }: { sources: AskSource[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-toggle-sources"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          Sources ({sources.length} tool call{sources.length === 1 ? "" : "s"})
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 space-y-1.5" data-testid="ask-sources">
        {sources.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs rounded-md border px-2.5 py-1.5">
            <Badge variant={s.status === "ok" ? "secondary" : "outline"} className="text-[10px]">
              {TOOL_LABEL[s.tool] ?? s.tool}
            </Badge>
            <span className="text-muted-foreground">{s.summary}</span>
            <span className="text-muted-foreground/70 ml-auto flex items-center gap-1 shrink-0">
              {s.sampleSize != null && <span>n={s.sampleSize}</span>}
              <Clock className="w-3 h-3" /> {new Date(s.asOf).toLocaleString()}
            </span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One chat turn: the recruiter's question bubble + Lexy's grounded answer block. */
function ChatTurnView({ turn }: { turn: ChatTurn }) {
  return (
    <div className="space-y-2" data-testid={`chat-turn-${turn.id}`}>
      {/* Question bubble (right-aligned) */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2 text-sm" data-testid="text-question">
          {turn.question}
        </div>
      </div>

      {/* Answer */}
      {!turn.result && !turn.error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground pl-1">
          <Loader2 className="w-4 h-4 animate-spin" /> Consulting your hiring data…
        </div>
      )}
      {turn.error && (
        <p className="text-sm text-destructive pl-1" data-testid="text-ask-error">
          Couldn't get an answer — try again.
        </p>
      )}
      {turn.result && (
        <div className="max-w-[95%] space-y-2.5">
          <div className="rounded-2xl rounded-tl-sm border bg-muted/40 px-4 py-3">
            <p className="text-sm whitespace-pre-line" data-testid="text-answer">{turn.result.answer}</p>
          </div>

          {/* Internal bench first — actionable cards, not just text */}
          {turn.result.benchMatches && turn.result.benchMatches.length > 0 && (
            <BenchMatchCards matches={turn.result.benchMatches} />
          )}

          {/* SEPARATE lower-trust channel: labeled generic guidance (cold start) */}
          {turn.result.generalGuidance && <GeneralGuidanceBlock text={turn.result.generalGuidance} />}

          {/* Thin/zero data → make the next step actionable, not a dead end */}
          {(!turn.result.coverage.sufficient || turn.result.coverage.okCount <= 1) && <ThinDataActions />}

          {/* Mandatory confidence line + visible coverage indicator */}
          <div className="flex flex-wrap items-center gap-2" data-testid="row-confidence">
            <CoverageBadge coverage={turn.result.coverage} hasGuidance={Boolean(turn.result.generalGuidance)} />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-[1px] text-primary" />
              <span data-testid="text-confidence">{turn.result.confidence}</span>
            </p>
          </div>

          {/* Collapsible citations from ACTUAL tool executions */}
          {turn.result.sources.length > 0 && <SourceList sources={turn.result.sources} />}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */
export default function MarketIntelligence() {
  const [form, setForm] = useState<QueryParams>({ role: "", skills: "", location: "" });
  const [submitted, setSubmitted] = useState<QueryParams | null>(null);
  const [question, setQuestion] = useState("");
  const [linxOpen, setLinxOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const nextId = useRef(1);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const ask = useMutation({ mutationFn: askLexy });
  useEffect(() => {
    if (turns.length > 0) chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);
  const submitQuestion = () => {
    const q = question.trim();
    if (q.length < 5 || ask.isPending) return;
    const id = nextId.current++;
    setTurns(ts => [...ts, { id, question: q }]);
    setQuestion("");
    ask.mutate(q, {
      onSuccess: result => setTurns(ts => ts.map(t => (t.id === id ? { ...t, result } : t))),
      onError: () => setTurns(ts => ts.map(t => (t.id === id ? { ...t, error: true } : t))),
    });
  };
  const enabled = !!submitted;

  const velocity = useQuery({
    queryKey: ["mi-velocity", submitted],
    queryFn: () => runTool<Velocity>("hiring-velocity", submitted!),
    enabled,
  });
  const supply = useQuery({
    queryKey: ["mi-supply", submitted],
    queryFn: () => runTool<Supply>("candidate-supply", submitted!),
    enabled,
  });
  const comp = useQuery({
    queryKey: ["mi-comp", submitted],
    queryFn: () => runTool<Comp>("comp-signal", submitted!),
    enabled,
  });
  const bench = useQuery({
    queryKey: ["mi-bench", submitted],
    queryFn: () => runTool<Bench>("internal-bench", submitted!),
    enabled,
  });

  const TrendIcon = ({ t }: { t: Supply["trend"] }) =>
    t === "up" ? <TrendingUp className="w-4 h-4 text-emerald-600" />
    : t === "down" ? <TrendingDown className="w-4 h-4 text-orange-500" />
    : t === "flat" ? <Minus className="w-4 h-4 text-muted-foreground" />
    : null;

  return (
    <AppLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <LineChart className="w-6 h-6 text-primary" /> Market Intelligence
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Ask about a role and see what your own hiring data says — days to fill, candidate
              supply, salary expectations, and who you already have. Every figure comes from real
              platform data; when there isn't enough, it says so honestly.
            </p>
          </div>
          {/* Alternate entry point for the LINX cross-tenant help request —
              same form as the work-order wizard, with a job picker. */}
          <Button
            variant="outline"
            className="gap-2 shrink-0"
            onClick={() => setLinxOpen(true)}
            data-testid="button-engage-linx"
          >
            <Handshake className="w-4 h-4" /> Engage LINX
          </Button>
        </div>
        <EngageLinxDialog open={linxOpen} onClose={() => setLinxOpen(false)} />

        {/* ── Ask Lexy (Step 2: reasoning layer) ─────────────────────────── */}
        <Card data-testid="card-ask-lexy">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="w-4 h-4 text-primary" /> Ask Lexy
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Ask a hiring question in plain language. Lexy answers only from the four data tools
              below — every claim is cited, and if the data is thin it says so instead of guessing.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Chat history */}
            {turns.length > 0 && (
              <div className="space-y-5 max-h-[28rem] overflow-y-auto pr-1" data-testid="ask-chat">
                {turns.map(t => <ChatTurnView key={t.id} turn={t} />)}
                <div ref={chatEndRef} />
              </div>
            )}

            <form
              className="flex gap-3"
              onSubmit={e => { e.preventDefault(); submitQuestion(); }}
            >
              <Input
                data-testid="input-question"
                placeholder='e.g. "I have to hire 5 design engineers, where should I find them?"'
                value={question}
                onChange={e => setQuestion(e.target.value)}
              />
              <Button type="submit" data-testid="button-ask" disabled={question.trim().length < 5 || ask.isPending}>
                {ask.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                Ask
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <form
              className="grid gap-3 sm:grid-cols-[2fr_2fr_1.5fr_auto]"
              onSubmit={e => { e.preventDefault(); if (form.role.trim().length >= 2) setSubmitted({ ...form }); }}
            >
              <Input
                data-testid="input-role"
                placeholder="Role, e.g. Design Engineer"
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
              />
              <Input
                data-testid="input-skills"
                placeholder="Skills (comma-separated, optional)"
                value={form.skills}
                onChange={e => setForm(f => ({ ...f, skills: e.target.value }))}
              />
              <Input
                data-testid="input-location"
                placeholder="Location (optional)"
                value={form.location}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              />
              <Button type="submit" data-testid="button-run" disabled={form.role.trim().length < 2}>
                <Search className="w-4 h-4 mr-1" /> Check
              </Button>
            </form>
          </CardContent>
        </Card>

        {!submitted ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Enter a role above to run the four market checks.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <ToolCard
              icon={Building2}
              title="Internal Bench"
              subtitle="The free answer first — people already in your own talent pool"
              result={bench.data} isLoading={bench.isLoading} error={bench.error}
            >
              {(r: Ok<Bench>) => (
                <div className="space-y-3">
                  <div className="flex gap-6">
                    <Stat label="Matches in your pool" value={r.matchCount} />
                    <Stat label="Current employees" value={r.currentEmployeeCount} />
                  </div>
                  <div className="space-y-1">
                    {r.topMatches.slice(0, 5).map(m => (
                      <Link key={m.candidateId} href={`/candidates/${m.candidateId}`}>
                        <div className="flex items-center justify-between text-sm rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer">
                          <span className="truncate">
                            {m.name}
                            <span className="text-muted-foreground"> — {m.title || "No title"}</span>
                            {m.isCurrentEmployee && <Badge variant="secondary" className="ml-2 text-[10px]">Employee</Badge>}
                          </span>
                          <span className="text-xs font-medium shrink-0 ml-2">{m.matchScore}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{r.note}</p>
                </div>
              )}
            </ToolCard>

            <ToolCard
              icon={LineChart}
              title="Hiring Velocity"
              subtitle="How long comparable roles took to fill, from your pipeline history"
              result={velocity.data} isLoading={velocity.isLoading} error={velocity.error}
            >
              {(r: Ok<Velocity>) => (
                <div className="space-y-3">
                  <div className="flex gap-6">
                    <Stat label="Median days to fill" value={r.medianDaysToFill} />
                    <Stat label="Typical range" value={`${r.p25DaysToFill}–${r.p75DaysToFill}d`} />
                    <Stat
                      label="Sourced-to-hire"
                      value={r.sourcedToHireRatio == null ? "—" : `${Math.round(r.sourcedToHireRatio * 100)}%`}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Based on {r.sampleSize} completed hire(s){r.sourcedSampleSize > 0 ? ` · ${r.sourcedSampleSize} sourced pipeline entries` : ""} · {r.scope} scope
                  </p>
                </div>
              )}
            </ToolCard>

            <ToolCard
              icon={Users}
              title="Candidate Supply"
              subtitle="What the sourcing agent actually found for comparable searches"
              result={supply.data} isLoading={supply.isLoading} error={supply.error}
            >
              {(r: Ok<Supply>) => (
                <div className="space-y-3">
                  <div className="flex gap-6 items-end">
                    <Stat label="Candidates found" value={r.totalCandidatesFound} />
                    <Stat label="Avg per search" value={r.avgFoundPerSearch} />
                    <div className="flex items-center gap-1 pb-1">
                      <TrendIcon t={r.trend} />
                      <span className="text-xs text-muted-foreground">
                        {r.trend == null ? "no prior-period data" : `trend: ${r.trend}`}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{r.basedOn}</p>
                </div>
              )}
            </ToolCard>

            <ToolCard
              icon={DollarSign}
              title="Comp Signal"
              subtitle="Anonymized salary expectations from matching candidate profiles"
              result={comp.data} isLoading={comp.isLoading} error={comp.error}
            >
              {(r: Ok<Comp>) => (
                <div className="space-y-3">
                  <div className="flex gap-6">
                    <Stat label="Median expectation" value={`${fmtMoney(r.medianLow)}–${fmtMoney(r.medianHigh)}`} />
                    <Stat label="Broader range" value={`${fmtMoney(r.p25Low)}–${fmtMoney(r.p75High)}`} />
                    <Stat label="Sample" value={r.sampleSize} />
                  </div>
                  <p className="text-xs text-muted-foreground">{r.note}</p>
                </div>
              )}
            </ToolCard>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
