/**
 * components/ai-os/MorningReport.tsx — the dashboard "Morning Report".
 *
 * ─── What this is ───────────────────────────────────────────────────────────
 * The since-you-were-gone digest that replaces the dashboard's status headline.
 * A greeting (time-of-day + first name) at title scale, then up to THREE report
 * sentences — each a full-width row that is itself a door: the whole row is
 * clickable and navigates to the exact filtered view it describes. Below the
 * digest sits a compact live-state line (the old "System Ready / active" dot).
 *
 * ─── Honesty contract ───────────────────────────────────────────────────────
 * The server emits FACTS (sentenceType + counts + linkTarget); this component
 * only renders copy and maps link targets to routes. It shows at most 3 rows —
 * the rest of the data lives on the pages the rows link to. If the endpoint
 * fails (or is still loading), it falls back to the plain static headline, so a
 * failure looks like the feature is simply absent — never like "all clear".
 *
 * ─── Endpoint ───────────────────────────────────────────────────────────────
 *   GET  /analytics/morning-report        — the digest
 *   POST /analytics/morning-report/seen   — advance the caller's watermark so
 *                                           the NEXT visit is scoped to "since
 *                                           now". Fired once, after this view
 *                                           has rendered; we deliberately do NOT
 *                                           refetch, so the digest stays stable
 *                                           for the length of this session.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { apiFetch, apiBase } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { cn, pluralize } from "@/lib/utils";

/* ── Response shape (mirror of the server contract) ───────────────────────── */
interface LinkTarget {
  view: string;
  params?: Record<string, string>;
}
interface ReportSentence {
  sentenceType: string;
  count: number;
  textParams: Record<string, number>;
  linkTarget: LinkTarget;
  rank: number;
}
interface NextAction {
  type: "run_sourcing" | "fix_contacts" | "source_role";
  count?: number;
  roleTitle?: string;
  linkTarget: LinkTarget;
}
interface MorningReportData {
  variant: "welcome" | "quiet" | "report";
  sinceLastSeen: string | null;
  generatedAt: string;
  sentences: ReportSentence[];
  /** welcome only: active roles the caller has configured. */
  rolesSetUp?: number;
  /** quiet only: active roles in scope. */
  rolesActive?: number;
  /** welcome + quiet: the single contextual door, if any. */
  nextAction?: NextAction | null;
}

/* ── Greeting ─────────────────────────────────────────────────────────────── */
function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function firstNameOf(name: string | undefined | null): string {
  const n = (name ?? "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0];
}

/* Short "since" phrase for the quiet variant, e.g. "since yesterday". */
function sincePhrase(iso: string | null): string {
  if (!iso) return "since your last visit";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "since your last visit";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return "in the last hour";
  const hours = Math.round(mins / 60);
  if (hours < 24) return `since ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "since yesterday";
  if (days < 7) return `since ${days} days ago`;
  return "since your last visit";
}

/* ── Fact → copy + route ──────────────────────────────────────────────────── */
interface RowSpec {
  count: number;
  phrase: string;
  extra?: string;
  href: string;
}

/* Map a server linkTarget to an in-app route. Every known view resolves to a
 * real filtered destination — there are no dead doors. */
function hrefFor(t: LinkTarget): string {
  switch (t.view) {
    case "approval_queue": return "/human-review";
    case "pipeline_blocked": return "/candidates?flag=blocked";
    case "run": return t.params?.runId ? `/runs/${t.params.runId}` : "/agents";
    case "run_history": return "/agents";
    case "inbox": return "/outreach/inbox";
    case "work_orders": return "/jobs";
    case "role": return t.params?.jobId ? `/jobs/${t.params.jobId}` : "/jobs";
    default: return "/agents";
  }
}

function describe(s: ReportSentence): RowSpec {
  const n = s.count;
  const href = hrefFor(s.linkTarget);
  switch (s.sentenceType) {
    case "awaiting_decision":
      return { count: n, phrase: `${n === 1 ? "candidate is" : "candidates are"} awaiting your decision`, href };
    case "blocked_work":
      return { count: n, phrase: `${n === 1 ? "candidate is" : "candidates are"} blocked — no valid email to reach them`, href };
    case "interrupted_failed":
      return { count: n, phrase: `agent ${pluralize(n, "run").replace(/^\d+\s/, "")} stopped before finishing`, href };
    case "completed_work": {
      const added = Number(s.textParams.candidatesAdded ?? 0);
      return {
        count: n,
        phrase: `agent ${pluralize(n, "run").replace(/^\d+\s/, "")} finished`,
        extra: added > 0 ? `${pluralize(added, "new candidate")} sourced` : undefined,
        href,
      };
    }
    case "replies_events": {
      const interested = Number(s.textParams.interested ?? 0);
      return {
        count: n,
        phrase: `new ${n === 1 ? "reply" : "replies"} from candidates`,
        extra: interested > 0 ? `${interested} interested` : undefined,
        href,
      };
    }
    default:
      return { count: n, phrase: "items need your attention", href };
  }
}

/* ── Live-state line (the old status dot; now under the digest) ───────────── */
function LiveStatusLine({ agentCount, className }: { agentCount: number; className?: string }) {
  const active = agentCount > 0;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className={cn("status-dot", active ? "status-dot--green status-dot--pulse" : "status-dot--gray")} />
      <span className={cn("text-[10px] font-bold uppercase tracking-widest", active ? "text-signal-green" : "text-muted-foreground")}>
        {active ? `System Active — ${agentCount} Agents Running` : "System Ready"}
      </span>
    </div>
  );
}

/* ── Static headline fallback (feature-absent state) ──────────────────────── */
function StaticHeadline({ agentCount }: { agentCount: number }) {
  const active = agentCount > 0;
  return (
    <div>
      <LiveStatusLine agentCount={agentCount} className="mb-1.5" />
      <h1 className="page-title">Hiring Operations</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {active
          ? "AI is actively working your pipeline right now."
          : "Run your first agent to start working your pipeline."}
      </p>
    </div>
  );
}

/* ── Digest row ───────────────────────────────────────────────────────────── */
function ReportRow({ spec }: { spec: RowSpec }) {
  return (
    <Link href={spec.href}>
      <div className="group flex items-baseline gap-3 py-2.5 border-b border-border last:border-0 cursor-pointer transition-colors hover:text-foreground -mx-2 px-2 rounded-md hover:bg-muted-bg/60">
        <span className="text-2xl font-bold tabular-nums text-primary leading-none shrink-0">
          {spec.count}
        </span>
        <span className="text-base text-foreground/90 leading-snug">
          {spec.phrase}
          {spec.extra ? (
            <span className="text-muted-foreground"> · {spec.extra}</span>
          ) : null}
        </span>
        <ChevronRight className="w-4 h-4 ml-auto self-center text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
      </div>
    </Link>
  );
}

/* ── Welcome line (first-ever visit, no runs yet) ─────────────────────────── */
function WelcomeLine({ rolesSetUp, nextAction }: { rolesSetUp: number; nextAction: NextAction | null }) {
  const href = hrefFor(nextAction?.linkTarget ?? { view: "work_orders" });
  return (
    <Link href={href}>
      <p className="group text-muted-foreground mt-1 text-sm cursor-pointer">
        {rolesSetUp > 0 ? (
          <>
            Welcome — {pluralize(rolesSetUp, "role")} {rolesSetUp === 1 ? "is" : "are"} set up.{" "}
            <span className="text-primary group-hover:underline">
              Run your first sourcing agent to start the pipeline.
            </span>
          </>
        ) : (
          <>
            Welcome.{" "}
            <span className="text-primary group-hover:underline">
              Create your first work order to start sourcing.
            </span>
          </>
        )}
      </p>
    </Link>
  );
}

/* ── Quiet line (history exists, nothing new since last seen) ──────────────── */
function QuietLine({
  sinceLastSeen,
  rolesActive,
  nextAction,
}: {
  sinceLastSeen: string | null;
  rolesActive: number;
  nextAction: NextAction | null;
}) {
  const rolesPhrase = rolesActive > 0 ? `${pluralize(rolesActive, "role")} active` : "No roles active";
  const status = `All quiet ${sincePhrase(sinceLastSeen)}. ${rolesPhrase}`;

  /* The next action is the only door here — current-state, not history. */
  let actionText: string | null = null;
  if (nextAction?.type === "fix_contacts") {
    const n = nextAction.count ?? 0;
    actionText = `${n} ${n === 1 ? "candidate needs" : "candidates need"} contact details before I can reach them`;
  } else if (nextAction?.type === "source_role" && nextAction.roleTitle) {
    actionText = `start sourcing for ${nextAction.roleTitle}`;
  }

  return (
    <p className="text-muted-foreground mt-1 text-sm">
      {status}
      {actionText && nextAction ? (
        <>
          {" — "}
          <Link href={hrefFor(nextAction.linkTarget)}>
            <span className="text-primary hover:underline cursor-pointer">{actionText}</span>
          </Link>
          .
        </>
      ) : (
        "."
      )}
    </p>
  );
}

/* ── Component ────────────────────────────────────────────────────────────── */
export function MorningReport({ agentCount }: { agentCount: number }) {
  const { user } = useAuth();

  const { data, isError, isLoading } = useQuery<MorningReportData>({
    queryKey: ["morning-report"],
    queryFn: () => apiFetch(`${apiBase}/analytics/morning-report`).then((r) => {
      if (!r.ok) throw new Error(`morning-report ${r.status}`);
      return r.json();
    }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  /* Advance the watermark once, after we've shown this digest, so the next
   * visit is scoped to "since now". Fire-and-forget; never refetch this view. */
  const marked = useRef(false);
  useEffect(() => {
    if (data && !marked.current) {
      marked.current = true;
      apiFetch(`${apiBase}/analytics/morning-report/seen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => { /* best-effort */ });
    }
  }, [data]);

  /* Failure or first paint → the plain static headline. A failed report must
   * look like the feature is absent, never like an empty "all clear". */
  if (isError || isLoading || !data) {
    return <StaticHeadline agentCount={agentCount} />;
  }

  const greeting = `${timeOfDay()}, ${firstNameOf(user?.name)}`;
  const rows = data.sentences.slice(0, 3).map(describe);

  return (
    <div>
      <h1 className="page-title">{greeting}</h1>

      {data.variant === "report" && rows.length > 0 ? (
        <div className="mt-3 max-w-2xl">
          {rows.map((spec, i) => (
            <ReportRow key={i} spec={spec} />
          ))}
        </div>
      ) : data.variant === "welcome" ? (
        <WelcomeLine
          rolesSetUp={data.rolesSetUp ?? 0}
          nextAction={data.nextAction ?? null}
        />
      ) : (
        <QuietLine
          sinceLastSeen={data.sinceLastSeen}
          rolesActive={data.rolesActive ?? 0}
          nextAction={data.nextAction ?? null}
        />
      )}

      <LiveStatusLine agentCount={agentCount} className="mt-4" />
    </div>
  );
}
