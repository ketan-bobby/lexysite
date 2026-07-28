/**
 * components/intelligence/SignalCoveragePanel.tsx — AI Signal Coverage Indicator
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Shows how much of the three critical intelligence signals (screening,
 * interview, verification) have been collected, either at the job level
 * (aggregate %) or the candidate level (present / absent).
 *
 * ─── Three display modes ─────────────────────────────────────────────────────
 *   "job"       — accepts a records[] array; computes aggregate % per signal
 *                 across all candidates in the job. Used in ExecutiveJobView.
 *   "candidate" — accepts a single signalFreshness array for one candidate;
 *                 shows present/absent with a freshness decay indicator.
 *   "mini"      — compact single-line bars; used inside decision-queue cards.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/intelligence/CandidateIntelligenceCard.tsx  (candidate mode)
 *   components/intelligence/ExecutiveJobView.tsx            (job mode)
 *   pages/recruiter/decision-queue.tsx                      (mini mode)
 */

import { cn } from "@/lib/utils";

interface SignalEntry {
  agent: string;
  present: boolean;
  decay: number | null;
  lastUpdated: string | null;
}

interface SignalCoveragePanelProps {
  mode: "job" | "candidate" | "mini";
  /** Job mode: pass all records' signalFreshness arrays */
  recordSignals?: SignalEntry[][];
  /** Candidate / mini mode: pass the single candidate's signal freshness */
  signalFreshness?: SignalEntry[];
  className?: string;
}

const TRACKED: { key: string; label: string; hex: string }[] = [
  { key: "screening",    label: "Screening",    hex: "#22d3ee" },
  { key: "interview",    label: "Interview",    hex: "#a78bfa" },
  { key: "verification", label: "Verification", hex: "#4ade80" },
];

function coveragePct(records: SignalEntry[][], agent: string): number {
  if (records.length === 0) return 0;
  const present = records.filter(sf => sf.some(s => s.agent === agent && s.present)).length;
  return Math.round((present / records.length) * 100);
}

function isPresent(sf: SignalEntry[], agent: string): boolean {
  return sf.some(s => s.agent === agent && s.present);
}

function decayFor(sf: SignalEntry[], agent: string): number | null {
  return sf.find(s => s.agent === agent)?.decay ?? null;
}

// Signal-coverage % bands (aggregate collection %; own cutoffs, not the match/fit band).
const COVERAGE_STRONG = 80, COVERAGE_WEAK = 50;

/* ── Job-level full panel ─────────────────────────────────────────────────── */
function JobPanel({ recordSignals }: { recordSignals: SignalEntry[][] }) {
  return (
    <div className="space-y-2.5">
      {TRACKED.map(({ key, label, hex }) => {
        const pct = coveragePct(recordSignals, key);
        const missing = 100 - pct;
        const badPct = pct < COVERAGE_WEAK;
        const warnPct = pct < COVERAGE_STRONG;
        const displayHex = badPct ? "#fb7185" : warnPct ? "#facc15" : hex;
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">{label}</span>
              <span className="flex items-center gap-1.5">
                <span className="font-black tabular-nums" style={{ color: displayHex }}>{pct}% covered</span>
                {missing > 0 && <span className="text-muted-foreground">· {missing}% missing</span>}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, background: displayHex, boxShadow: `0 0 4px ${displayHex}66` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Signal decay below this % counts as "stale" (freshness band; own cutoff, not the match band).
const STALE_DECAY_MAX = 40;

/* ── Candidate-level panel ────────────────────────────────────────────────── */
function CandidatePanel({ signalFreshness }: { signalFreshness: SignalEntry[] }) {
  return (
    <div className="space-y-2">
      {TRACKED.map(({ key, label, hex }) => {
        const present = isPresent(signalFreshness, key);
        const decay = decayFor(signalFreshness, key);
        const displayHex = !present ? "#64748b" : (decay ?? 100) < STALE_DECAY_MAX ? "#facc15" : hex;
        const status = !present ? "Missing" : (decay ?? 100) < STALE_DECAY_MAX ? `Stale (${decay}%)` : `Fresh (${decay}%)`;
        return (
          <div key={key} className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full shrink-0" style={{ background: displayHex }} />
            <span className="text-xs text-muted-foreground flex-1">{label}</span>
            <span className="text-xs font-medium tabular-nums" style={{ color: displayHex }}>{status}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Mini mode (for QueueCard) ────────────────────────────────────────────── */
function MiniPanel({ signalFreshness }: { signalFreshness: SignalEntry[] }) {
  return (
    <div className="flex items-center gap-3">
      {TRACKED.map(({ key, label, hex }) => {
        const present = isPresent(signalFreshness, key);
        const decay = decayFor(signalFreshness, key);
        const displayHex = !present ? "#475569" : (decay ?? 100) < STALE_DECAY_MAX ? "#facc15" : hex;
        return (
          <div key={key} className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: displayHex }} />
            <span className="text-[10px] text-muted-foreground">{label.slice(0, 4)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function SignalCoveragePanel({
  mode,
  recordSignals = [],
  signalFreshness = [],
  className,
}: SignalCoveragePanelProps) {
  return (
    <div className={cn(className)}>
      {mode === "job"       && <JobPanel recordSignals={recordSignals} />}
      {mode === "candidate" && <CandidatePanel signalFreshness={signalFreshness} />}
      {mode === "mini"      && <MiniPanel signalFreshness={signalFreshness} />}
    </div>
  );
}
