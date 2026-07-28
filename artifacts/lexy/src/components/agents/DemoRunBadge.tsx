/**
 * DemoRunBadge — marks data produced by a simulated ("demo") agent run.
 *
 * Rendered wherever a candidate whose source is "agent_simulated" appears, and
 * on a simulated run's live feed, so recruiters can tell demo data apart from
 * real sourcing at a glance. Uses theme-aware amber tokens (works in both light
 * and dark modes).
 */
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

export function DemoRunBadge({ className, size = "sm" }: { className?: string; size?: "sm" | "xs" }) {
  return (
    <span
      title="Simulated demo sourcing run — this data was generated for demonstration."
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-semibold uppercase tracking-wide",
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        size === "xs" ? "text-[8px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5",
        className,
      )}
    >
      <FlaskConical className={size === "xs" ? "w-2.5 h-2.5" : "w-3 h-3"} />
      Demo run
    </span>
  );
}

/** True when a candidate/record was created by a simulated agent run. */
export function isSimulatedSource(source?: string | null): boolean {
  return source === "agent_simulated";
}
