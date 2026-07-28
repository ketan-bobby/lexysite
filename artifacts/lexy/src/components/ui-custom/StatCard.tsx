/**
 * StatCard.tsx — Reusable KPI / metric display card.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * A glassmorphic card that renders a single numeric metric with an optional
 * icon, trend badge (±%), description line, and a glow-colour accent behind the
 * icon.  When an `href` prop is supplied the entire card becomes a navigation
 * link via Wouter.
 *
 * ── Props ─────────────────────────────────────────────────────────────────────
 *  title        Metric label (displayed uppercase + spaced)
 *  value        Numeric or string value to display in large type
 *  icon         Optional ReactNode rendered in the top-right icon slot
 *  trend        { value: number; isPositive: boolean } — shows a +/- pill
 *  description  Secondary caption below the value
 *  glowColor    Tailwind class for the icon glow (default: bg-primary/40)
 *  href         If set, wraps the card in a <Link>
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/analytics.tsx        Dashboard analytics KPIs
 *  pages/recruiter/index.tsx (dashboard) Pipeline summary stats
 *  pages/recruiter/jobs/[id].tsx        Per-job metric header
 */

import { cn } from "@/lib/utils";
import { ReactNode } from "react";
import { Link } from "wouter";

interface StatCardProps {
  title:        string;
  value:        string | number;
  icon?:        ReactNode;
  trend?:       { value: number; isPositive: boolean };
  description?: string;
  className?:   string;
  glowColor?:   string;
  href?:        string;
}

export function StatCard({ title, value, icon, trend, description, className, glowColor, href }: StatCardProps) {
  const inner = (
    <div className={cn(
      "relative overflow-hidden rounded-xl border border-white/8 p-6 transition-all hover-elevate group",
      "bg-card",
      href && "cursor-pointer hover:border-primary/30",
      className,
    )} style={{ boxShadow: "0 1px 3px rgba(15,23,42,0.05)" }}>

      {/* subtle top-edge highlight */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <div className="flex justify-between items-start">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-2">
            <h2 className="text-4xl font-bold tracking-tight text-foreground">{value}</h2>
            {trend && (
              <span className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded-full",
                trend.isPositive
                  ? "text-emerald-400 bg-emerald-500/15 border border-emerald-500/20"
                  : "text-rose-400 bg-rose-500/15 border border-rose-500/20",
              )}>
                {trend.isPositive ? "+" : "-"}{Math.abs(trend.value)}%
              </span>
            )}
          </div>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>

        {icon && (
          <div className="relative shrink-0">
            {/* glow behind icon */}
            <div className={cn(
              "absolute inset-0 rounded-xl blur-md opacity-40 group-hover:opacity-60 transition-opacity",
              glowColor ?? "bg-primary/40",
            )} />
            <div className={cn(
              "relative w-12 h-12 rounded-xl flex items-center justify-center border border-white/10",
              "bg-gradient-to-br from-primary/20 to-primary/5 text-primary",
            )}>
              {icon}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
