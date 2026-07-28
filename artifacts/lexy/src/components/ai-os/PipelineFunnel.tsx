/**
 * PipelineFunnel.tsx — Horizontal pipeline funnel visualization.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Renders the recruiting pipeline as a set of horizontal bars, one per stage,
 * each bar's width proportional to that stage's candidate count. Bars grow from
 * 0 → their target width the first time the chart scrolls into view, staggered
 * 80ms per bar (500ms ease-out each). Honors prefers-reduced-motion by showing
 * the bars at full width immediately with no animation.
 *
 * ── Props ─────────────────────────────────────────────────────────────────────
 *  stages     { name, value }[]  — pipeline stages in order (widest first)
 *  className   optional wrapper classes
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

interface Stage {
  name: string;
  value: number;
}

interface Props {
  stages: Stage[];
  className?: string;
  /** Where the empty-state "Run agents →" link points. */
  runAgentsHref?: string;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function PipelineFunnel({ stages, className, runAgentsHref = "/jobs" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Start "grown" if the user prefers reduced motion so the bars render at their
  // final width with no transition; otherwise wait for scroll-into-view.
  const [grown, setGrown] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (grown) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setGrown(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [grown]);

  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <Card className={cn("elevated border-border", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" /> AI Pipeline Funnel
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="How the funnel is counted"
                  className="ml-0.5 inline-flex text-muted-foreground/70 hover:text-foreground transition-colors"
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[15rem] font-normal leading-relaxed">
                Counts all live pipeline participants. Each stage shows candidates
                who reached it or beyond, so these totals can exceed the visible
                “Total Candidates” count and the “formal applications” figure.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-visible">
        <div ref={ref} className="space-y-2.5">
          {stages.length === 0 ? (
            <div className="relative overflow-visible">
              {/* Ghost funnel — very faint muted placeholder bars (no accent, no
                  numbers), kept low-contrast so the overlaid message stays the
                  focal point instead of competing with the bars. */}
              <div className="space-y-2.5" aria-hidden="true">
                {[100, 52, 31, 14].map((w, i) => (
                  <div
                    key={i}
                    className="h-4 rounded-lg"
                    style={{ width: `${w}%`, backgroundColor: "hsl(var(--line) / 0.15)" }}
                  />
                ))}
              </div>
              {/* Floating "preview chips" — small cards styled like real UI that
                  hint at what the funnel will show once agents run. Tucked into
                  the corners so they never collide with the centered message. */}
              <div
                aria-hidden="true"
                className="preview-chip absolute z-20 pointer-events-none"
                style={{
                  top: "-6px",
                  right: "-24px",
                  transform: "rotate(-2deg)",
                  ["--chip-to" as any]: "rotate(-2deg)",
                  ["--chip-from" as any]: "translateY(6px) rotate(-2deg)",
                  animationDelay: "0ms",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderRadius: "10px",
                  boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                  padding: "10px 14px",
                }}
              >
                <div className="text-[11px] uppercase tracking-wide" style={{ color: "hsl(var(--muted))" }}>
                  Sourced
                </div>
                <div className="text-[14px] font-semibold">
                  — awaiting data
                </div>
              </div>
              <div
                aria-hidden="true"
                className="preview-chip absolute z-20 pointer-events-none"
                style={{
                  bottom: "0px",
                  left: "-6px",
                  transform: "translateY(30%) rotate(1.5deg)",
                  ["--chip-to" as any]: "translateY(30%) rotate(1.5deg)",
                  ["--chip-from" as any]: "translateY(calc(30% + 6px)) rotate(1.5deg)",
                  animationDelay: "200ms",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderRadius: "10px",
                  boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                  padding: "10px 14px",
                }}
              >
                <div className="text-[11px] uppercase tracking-wide" style={{ color: "hsl(var(--muted))" }}>
                  Match rate
                </div>
                <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "hsl(var(--accent))" }} />
                  Ready to calculate
                </div>
              </div>
              {/* Message centered over the ghost bars on a legible card scrim so
                  the copy never collides with the bars behind it. */}
              <div className="absolute inset-0 flex items-center justify-center px-4">
                <div className="flex flex-col items-center gap-1 rounded-xl bg-card/85 px-5 py-3 text-center shadow-sm ring-1 ring-border/60 backdrop-blur-sm">
                  <p className="text-xs text-muted-foreground">
                    No pipeline data yet — run agents on a job to populate the funnel
                  </p>
                  <Link href={runAgentsHref} className="text-xs font-medium text-primary hover:opacity-80">
                    Run agents →
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            stages.map((s, i) => {
              const opacity = [1, 0.75, 0.5, 0.3][i % 4];
              // Give any non-zero stage a visible sliver even at low proportions.
              const targetPct = s.value > 0 ? Math.max((s.value / max) * 100, 5) : 0;
              return (
                <div key={s.name} className="flex items-center gap-3">
                  <div className="w-28 shrink-0 text-right text-[11px] font-semibold text-muted-foreground truncate">
                    {s.name}
                  </div>
                  <div className="flex-1 h-8 rounded-lg bg-muted/30 overflow-hidden">
                    <div
                      className="h-full rounded-lg ease-out"
                      style={{
                        width: grown ? `${targetPct}%` : "0%",
                        backgroundColor: `hsl(var(--primary) / ${opacity})`,
                        transitionProperty: "width",
                        transitionDuration: "350ms",
                        transitionDelay: grown ? `${i * 80}ms` : "0ms",
                      }}
                    />
                  </div>
                  <div className="w-8 shrink-0 text-right text-[11px] font-bold tabular-nums text-foreground">
                    {s.value}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
