/**
 * Hotspot.tsx — Ambient pulsing-dot hint.
 *
 * Use this to draw a recruiter's eye to a specific control they keep missing.
 * Renders an absolutely-positioned cyan dot in the corner of its parent (or
 * wherever you place it). Once dismissed it stays hidden — dismissal is keyed
 * by the `id` prop and stored in localStorage.
 *
 * Example:
 *   <div className="relative inline-block">
 *     <Button>Generate ICP</Button>
 *     <Hotspot id="generate-icp" tooltip="Start here — generate the AI profile" />
 *   </div>
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const LS_PREFIX = "lexy:hotspot:";

interface HotspotProps {
  id: string;
  tooltip?: string;
  className?: string;
  /** Where to anchor inside the relatively-positioned parent. */
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

export function Hotspot({ id, tooltip, className, position = "top-right" }: HotspotProps) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(LS_PREFIX + id) === "1");
    } catch {
      setDismissed(false);
    }
  }, [id]);

  if (dismissed) return null;

  const dismiss = () => {
    try { localStorage.setItem(LS_PREFIX + id, "1"); } catch { /* noop */ }
    setDismissed(true);
  };

  const pos =
    position === "top-right"   ? "-top-1 -right-1" :
    position === "top-left"    ? "-top-1 -left-1"  :
    position === "bottom-right"? "-bottom-1 -right-1" :
                                 "-bottom-1 -left-1";

  return (
    <button
      type="button"
      aria-label={tooltip || "Hint"}
      title={tooltip}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); dismiss(); }}
      className={cn(
        "absolute z-30 w-3.5 h-3.5 rounded-full pointer-events-auto",
        "bg-primary shadow-[0_0_0_4px_rgba(6,182,212,0.25)]",
        "before:content-[''] before:absolute before:inset-0 before:rounded-full",
        "before:bg-primary before:animate-ping before:opacity-60",
        pos,
        className,
      )}
    />
  );
}

/** Reset every hotspot dismissal (used by the Help menu's "Show all hints" item). */
export function resetAllHotspots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch { /* noop */ }
}
