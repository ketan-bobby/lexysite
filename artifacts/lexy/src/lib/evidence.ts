/**
 * lib/evidence.ts — Honest evidence labeling for outcome-calibrated scores.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * With sparse data the engine can show a confident-looking percentage that
 * stands on one or two signals. These helpers translate the score's backing
 * (signal count + confidence) into an honest band so the UI can show "based on
 * N signals" and an explicit "insufficient data" state instead of a bare number.
 *
 * This is presentation/labeling ONLY — it never changes how scores are computed.
 *
 * Thresholds:
 *   0 signals                         → "none"         (no evidence yet)
 *   <2 signals OR confidence < 40     → "insufficient" (number not meaningful)
 *   confidence < 70                   → "limited"      (some evidence)
 *   otherwise                         → "solid"        (well-supported)
 */

import { pluralize } from "@/lib/utils";

export type EvidenceLevel = "none" | "insufficient" | "limited" | "solid";

export interface Evidence {
  level: EvidenceLevel;
  /** True when the headline number is not yet statistically meaningful. */
  insufficient: boolean;
  /** Short band label, e.g. "Low confidence". */
  bandLabel: string;
  /** "Based on 2 signals" / "No signals yet". */
  signalLabel: string;
  /** Confidence as a 0–100 number (null when unknown). */
  confidence: number | null;
  /** Number of agent signal groups backing the score. */
  signalCount: number;
  /** Tailwind classes for a band chip (text + bg + border). */
  tone: string;
  /** Tailwind background class for a status dot. */
  dotTone: string;
}

const TONES: Record<EvidenceLevel, { tone: string; dotTone: string; bandLabel: string }> = {
  none: {
    bandLabel: "No data yet",
    tone: "bg-slate-500/10 text-slate-400 border-slate-500/25",
    dotTone: "bg-slate-400",
  },
  insufficient: {
    bandLabel: "Insufficient data",
    tone: "bg-amber-500/10 text-amber-400 border-amber-500/25",
    dotTone: "bg-amber-400",
  },
  limited: {
    bandLabel: "Limited evidence",
    tone: "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
    dotTone: "bg-yellow-400",
  },
  solid: {
    bandLabel: "Well supported",
    tone: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
    dotTone: "bg-emerald-400",
  },
};

export function getEvidence(
  confidence?: number | null,
  signalCount?: number | null,
): Evidence {
  const sc = signalCount ?? 0;
  const conf = confidence ?? null;

  let level: EvidenceLevel;
  if (sc === 0) {
    level = "none";
  } else if (sc < 2 || (conf != null && conf < 40)) {
    level = "insufficient";
  } else if (conf != null && conf < 70) {
    level = "limited";
  } else {
    level = "solid";
  }

  const signalLabel =
    sc === 0 ? "No signals yet" : `Based on ${pluralize(sc, "signal")}`;

  return {
    level,
    insufficient: level === "none" || level === "insufficient",
    bandLabel: TONES[level].bandLabel,
    signalLabel,
    confidence: conf,
    signalCount: sc,
    tone: TONES[level].tone,
    dotTone: TONES[level].dotTone,
  };
}
