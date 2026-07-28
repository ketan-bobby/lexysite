/**
 * TourProvider.tsx — Global product-tour controller.
 *
 * Renders a single react-joyride instance for the whole app and exposes a
 * `useTour()` hook so any component can:
 *   - start a specific tour by id
 *   - check whether a tour has already been completed
 *   - reset all completion flags (so tours auto-launch again)
 *
 * Auto-launch behaviour: when the user visits a page that has an associated
 * tour AND that tour has never been completed for them, the tour starts after
 * a small delay so the page can finish rendering. Completion is tracked in
 * localStorage under "lexy:tour:<id>".
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Joyride, STATUS, type EventData, type TooltipRenderProps } from "react-joyride";
import { Sparkles, X, ArrowRight, ArrowLeft, Check } from "lucide-react";
import { tours, tourForPath, type TourId } from "./tours";

/**
 * BrandedTooltip — Custom Joyride tooltip with cyan/dark L3xy branding.
 *
 * Replaces the default plain Joyride bubble with a glowing card that has:
 *   - cyan gradient header with sparkle icon + "Tip x of y" pill
 *   - large title, body copy
 *   - clear primary Next/Done CTA, secondary Back, ghost Skip
 *   - close (X) button in top-right
 *   - subtle outer cyan glow so the eye locks onto it immediately
 */
function BrandedTooltip({
  index, size, step, backProps, primaryProps, skipProps, closeProps, tooltipProps, isLastStep,
}: TooltipRenderProps) {
  return (
    <div
      {...tooltipProps}
      className="w-[360px] max-w-[92vw] rounded-2xl overflow-hidden shadow-[0_0_0_1px_rgba(6,182,212,0.4)] border border-primary/40 bg-[#0a1218] text-[#e6f7fb] animate-in fade-in zoom-in-95 duration-300"
    >
      {/* Gradient header */}
      <div className="relative px-5 pt-5 pb-3 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent border-b border-primary/20">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/40 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-primary/90">
            Tip {index + 1} of {size}
          </span>
          <button
            {...closeProps}
            aria-label="Close tour"
            className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {step.title && (
          <h3 className="text-lg font-bold leading-tight text-white">{step.title}</h3>
        )}
      </div>

      {/* Body */}
      <div className="px-5 py-4 text-sm leading-relaxed text-[#cbe7f0]">
        {step.content}
      </div>

      {/* Footer */}
      <div className="px-5 pb-4 pt-1 flex items-center justify-between gap-2">
        <button
          {...skipProps}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              {...backProps}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-foreground/80 hover:text-foreground hover:bg-white/5 transition-all"
            >
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
          )}
          <button
            {...primaryProps}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold bg-primary text-primary-foreground hover:scale-[1.03] active:scale-95 transition-transform"
          >
            {isLastStep ? (<><Check className="w-3.5 h-3.5" /> Got it</>) : (<>Next <ArrowRight className="w-3.5 h-3.5" /></>)}
          </button>
        </div>
      </div>
    </div>
  );
}

const LS_PREFIX = "lexy:tour:";

interface TourContextValue {
  start: (id: TourId) => void;
  hasCompleted: (id: TourId) => boolean;
  resetAll: () => void;
  resetOne: (id: TourId) => void;
  activeTour: TourId | null;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}

function readCompleted(id: TourId): boolean {
  try {
    return localStorage.getItem(LS_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

function markCompleted(id: TourId): void {
  try {
    localStorage.setItem(LS_PREFIX + id, "1");
  } catch {
    /* localStorage may be blocked — fail silent. */
  }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [activeTour, setActiveTour] = useState<TourId | null>(null);
  const [run, setRun] = useState(false);

  /* ── Auto-launch on first visit to a page with a tour ─────────────────── */
  useEffect(() => {
    if (activeTour) return;
    const t = tourForPath(location);
    if (!t) return;
    if (readCompleted(t.id)) return;
    // Defer so target elements are mounted.
    const timer = setTimeout(() => {
      setActiveTour(t.id);
      setRun(true);
    }, 600);
    return () => clearTimeout(timer);
  }, [location, activeTour]);

  const start = useCallback((id: TourId) => {
    // Re-mount Joyride: turn off, then on next tick switch tours and run.
    setRun(false);
    setActiveTour(null);
    setTimeout(() => {
      setActiveTour(id);
      setRun(true);
    }, 50);
  }, []);

  const hasCompleted = useCallback((id: TourId) => readCompleted(id), []);

  const resetAll = useCallback(() => {
    try {
      Object.keys(tours).forEach(k => localStorage.removeItem(LS_PREFIX + k));
    } catch { /* noop */ }
  }, []);

  const resetOne = useCallback((id: TourId) => {
    try { localStorage.removeItem(LS_PREFIX + id); } catch { /* noop */ }
  }, []);

  const handleCallback = useCallback((data: EventData) => {
    const { status } = data;
    // Joyride manages step advancement internally now. We only react to terminal states.
    if (([STATUS.FINISHED, STATUS.SKIPPED] as string[]).includes(status)) {
      if (activeTour) markCompleted(activeTour);
      setRun(false);
      setActiveTour(null);
    }
  }, [activeTour]);

  const value = useMemo<TourContextValue>(() => ({
    start, hasCompleted, resetAll, resetOne, activeTour,
  }), [start, hasCompleted, resetAll, resetOne, activeTour]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {activeTour && (
        <Joyride
          key={activeTour}
          steps={tours[activeTour].steps}
          run={run}
          continuous
          scrollToFirstStep
          onEvent={handleCallback}
          locale={{
            back: "Back",
            close: "Close",
            last: "Done",
            next: "Next",
            skip: "Skip tour",
          }}
          tooltipComponent={BrandedTooltip}
          options={{
            zIndex: 10000,
            primaryColor: "#06b6d4",
            backgroundColor: "#0a1218",
            textColor: "#e6f7fb",
            arrowColor: "#0a1218",
            overlayColor: "rgba(2, 6, 12, 0.78)",
            spotlightRadius: 12,
            showProgress: true,
            buttons: ["back", "primary", "skip", "close"],
          }}
          styles={{
            spotlight: {
              stroke: "rgba(6, 182, 212, 0.75)",
              strokeWidth: 2,
              filter: "drop-shadow(0 0 18px rgba(6, 182, 212, 0.65))",
            },
          }}
        />
      )}
    </TourContext.Provider>
  );
}
