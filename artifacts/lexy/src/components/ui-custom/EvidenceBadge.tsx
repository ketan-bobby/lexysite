/**
 * EvidenceBadge.tsx — Honest evidence chip for outcome-calibrated scores.
 *
 * Renders the confidence band + signal-count backing a score (e.g.
 * "Insufficient data · based on 1 signal"). Use it next to any hireProbability
 * surface so a sparse, confident-looking number reads honestly. Presentation
 * only — derives everything from getEvidence(confidence, signalCount).
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getEvidence } from "@/lib/evidence";

export function EvidenceBadge({
  confidence,
  signalCount,
  className,
  showSignals = true,
}: {
  confidence?: number | null;
  signalCount?: number | null;
  className?: string;
  /** When true, append "· based on N signals" to the band label. */
  showSignals?: boolean;
}) {
  const ev = getEvidence(confidence, signalCount);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[9px] px-1.5 py-0 h-4 rounded-full border font-medium cursor-default whitespace-nowrap",
              ev.tone,
              className,
            )}
          >
            <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", ev.dotTone)} />
            {ev.bandLabel}
            {showSignals && <span className="opacity-70">· {ev.signalLabel}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-[220px]">
          <p className="font-medium">{ev.bandLabel}</p>
          <p className="text-muted-foreground mt-0.5">
            {ev.signalLabel}
            {ev.confidence != null && ` · ${ev.confidence}% confidence`}
          </p>
          {ev.insufficient && (
            <p className="text-muted-foreground mt-1">
              This score rests on limited evidence — treat it as preliminary until more agent
              signals are collected.
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
