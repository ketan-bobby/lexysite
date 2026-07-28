/**
 * RecommendedActions.tsx — Priority-ranked recruiter action suggestions.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Displays a card list of AI-recommended next actions for the recruiter
 * (e.g. "3 candidates ready to advance", "Follow up on ghosted applications").
 * Each action shows a priority badge (High / Medium / Low), a detail line, a
 * CTA button, and navigates the recruiter to the relevant page when clicked.
 * Actions can also be injected via the `actions` prop for static usage.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  PRIORITY_CFG         Colour tokens per priority level
 *  useDashboardActions  Hook — fetches /api/agents/recommended-actions
 *  <ActionItem>         Single recommendation row with badge + CTA
 *  <RecommendedActions> Root: resolves actions (prop or API), renders list
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET /api/agents/recommended-actions   Returns Action[] sorted by priority
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/index.tsx        Dashboard "What to do next" panel
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Zap, Users, Send, Video, AlertTriangle, ArrowRight, CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, apiBase } from "@/lib/api";

const ICON_MAP: Record<string, React.ElementType> = {
  Users, Send, Video, AlertTriangle, Zap, CheckCircle2,
};

const PRIORITY_CFG = {
  high:   { cls: "bg-destructive/10 text-destructive border-destructive/25", dot: "bg-destructive",      icon: "text-destructive" },
  medium: { cls: "bg-signal-amber/10 text-signal-amber border-signal-amber/25", dot: "bg-signal-amber",  icon: "text-signal-amber" },
  low:    { cls: "bg-muted text-muted-foreground border-border",         dot: "bg-muted-foreground",     icon: "text-muted-foreground" },
};

interface Action {
  id: string;
  priority: "high" | "medium" | "low";
  label: string;
  detail: string;
  cta: string;
  icon: string;
  href: string;
  color: string;
  ctaVariant?: "default" | "outline" | "ghost";
}

interface Props {
  maxItems?: number;
  className?: string;
  actions?: Action[];
}

function useDashboardActions() {
  return useQuery<Action[]>({
    queryKey: ["dashboard-actions"],
    queryFn: () => apiFetch(`${apiBase}/analytics/dashboard`).then(r => r.json()).then(d => d.recommendedActions ?? []),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

export function RecommendedActions({ maxItems = 5, className, actions: propActions }: Props) {
  const { data: fetchedActions = [], isLoading } = useDashboardActions();
  const items = (propActions ?? fetchedActions).slice(0, maxItems);
  const urgentCount = items.filter(a => a.priority === "high").length;

  // Empty state collapses to a slim full-width banner instead of a tall card.
  if (!isLoading && items.length === 0) {
    return (
      <div className={cn(
        "flex items-center gap-3 h-14 px-4 rounded-xl border border-border/50 bg-card",
        className,
      )}>
        <CheckCircle2 className="w-5 h-5 text-signal-green shrink-0" />
        <span className="text-sm font-semibold text-foreground">All clear — no actions needed</span>
        <Link href="/agents" className="ml-auto shrink-0">
          <Button size="sm" variant="ghost" className="gap-1.5 text-xs font-semibold">
            <Zap className="w-3.5 h-3.5" /> Run agents
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <Card className={cn("border-border/50 overflow-hidden", className)}>
      <CardHeader className="pb-3 border-b border-border/30">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="w-4 h-4 text-primary" />
          Recommended Actions
          {urgentCount > 0 && (
            <Badge className="ml-auto bg-destructive/15 text-destructive border-destructive/25 text-[10px]">
              {urgentCount} urgent
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
            Loading…
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {items.map((action) => {
              const Icon = ICON_MAP[action.icon] ?? Zap;
              const pc = PRIORITY_CFG[action.priority] ?? PRIORITY_CFG.low;
              return (
                <div key={action.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors group">
                  <div className="w-8 h-8 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
                    <Icon className={cn("w-4 h-4", pc.icon)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", pc.dot)} />
                      <span className="text-xs font-semibold leading-tight text-foreground">{action.label}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{action.detail}</p>
                  </div>
                  <Link href={action.href} className="shrink-0">
                    <Button
                      size="sm"
                      variant={action.ctaVariant ?? "outline"}
                      className={cn(
                        "h-7 px-3 text-xs font-semibold transition-all",
                        action.ctaVariant === "default" && "shadow-sm",
                      )}
                    >
                      {action.cta} <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
