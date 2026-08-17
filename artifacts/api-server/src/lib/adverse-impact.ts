/**
 * adverse-impact.ts — PURE math for the four-fifths (80%) rule adverse-impact
 * monitor (EEOC Uniform Guidelines). Extracted from routes/analytics.ts so the
 * calculation is unit-testable without a database (tasks: "add tests that
 * prove the fairness math stays correct").
 *
 * NO database access and NO demographics-table imports live here — the route
 * fetches rows and passes plain data in. Every function is deterministic.
 *
 * Semantics locked in by src/lib/adverse-impact.test.ts:
 *  - Analysis unit = ONE (candidate, job) pair, never an application row.
 *  - Furthest level = max(current stage level, highest event level, 1).
 *  - Groups below MIN_GROUP_N applicants contribute no ratio (insufficientData).
 *  - Reference group = highest selection rate among qualifying groups; ratios
 *    need ≥2 qualifying groups and a non-zero reference.
 *  - impactRatio < 0.8 ⇒ flagged.
 */

export const MIN_GROUP_N = 30;
export const FOUR_FIFTHS = 0.8;

/* Funnel levels: applied(1) → screened(2) → interviewed(3) → offer(4) → hired(5).
 * Terminal rejected/withdrawn map to 1 on the live stage; the event log recovers
 * the furthest level actually reached before the terminal transition. */
export const STAGE_LEVEL: Record<string, number> = {
  sourced: 1,
  applied: 1,
  rejected: 1,
  withdrawn: 1,
  // Reaching the screening stage IS the "screened" milestone (level 2) — the
  // candidate has entered screening, which is what the 4/5ths screened-rate
  // denominator/numerator measures. Terminal rejected/withdrawn stay at 1; the
  // event log recovers the furthest level actually reached before exit.
  screening: 2,
  verification: 2,
  shortlisted: 2,
  phone_screen: 2,
  assessment: 2,
  interview_scheduled: 2,
  interview: 3,
  interview_completed: 3,
  hm_review: 3,
  offer: 4,
  offer_recommended: 4,
  offer_extended: 4,
  offer_accepted: 4,
  offer_declined: 4,
  hired: 5,
  started: 5,
};
export const EVENT_LEVEL: Record<string, number> = {
  CANDIDATE_CREATED: 1,
  JOB_MATCHED: 1,
  OUTREACH_SENT: 1,
  OUTREACH_OPENED: 1,
  OUTREACH_REPLIED: 1,
  REJECTED: 1,
  WITHDRAWN: 1,
  INTERVIEW_INVITED: 2,
  RECRUITER_REVIEWED: 2,
  RECRUITER_SHORTLISTED: 2,
  // Actually starting/completing an interview IS the "interviewed" milestone
  // (level 3) — only the invite (above) stays at level 2.
  INTERVIEW_STARTED: 3,
  INTERVIEW_COMPLETED: 3,
  INTERVIEW_SCORE_GENERATED: 3,
  SUBMITTED_TO_HIRING_MANAGER: 3,
  HIRING_MANAGER_INTERVIEW_SCHEDULED: 3,
  HIRING_MANAGER_INTERVIEW_COMPLETED: 3,
  OFFER_RECOMMENDED: 4,
  OFFER_EXTENDED: 4,
  OFFER_ACCEPTED: 4,
  OFFER_DECLINED: 4,
  HIRED: 5,
  STARTED: 5,
  ROLE_OUTCOME_REPORTED: 5,
};
export const ADVERSE_MILESTONES = [
  { key: "screened", label: "Screened", level: 2 },
  { key: "interviewed", label: "Interviewed", level: 3 },
  { key: "offer", label: "Offer", level: 4 },
  { key: "hired", label: "Hired", level: 5 },
] as const;

export interface Unit {
  level: number;
  gender: string | null;
  race: string[] | null;
  vet: string | null;
  dis: string | null;
}

export interface BaseRow {
  candidateId: string;
  jobId: string;
  stage: string | null;
  gender: string | null;
  raceEthnicity: string[] | null;
  veteranStatus: string | null;
  disabilityStatus: string | null;
}

export interface EventRow {
  candidateId: string | null;
  jobId: string | null;
  eventType: string | null;
}

/** Furthest event-implied level per (candidate, job): `candidateId::jobId` → level. */
export function buildEventMax(evRows: EventRow[]): Map<string, number> {
  const evMax = new Map<string, number>();
  for (const e of evRows) {
    const lvl = EVENT_LEVEL[e.eventType as string] ?? 1;
    const k = `${e.candidateId}::${e.jobId}`;
    if (lvl > (evMax.get(k) ?? 0)) evMax.set(k, lvl);
  }
  return evMax;
}

/**
 * Collapse application rows to ONE unit per (candidate, job) — a candidate may
 * have several application rows for the same job (re-applies, merges); counting
 * each as a separate applicant would inflate both denominators and reached
 * counts and skew the 4/5ths ratio. We keep the furthest level seen across
 * those rows and any of their (identical, same-candidate) demographics.
 */
export function buildUnits(baseRows: BaseRow[], evMax: Map<string, number>): Unit[] {
  const unitMap = new Map<string, Unit>();
  for (const r of baseRows) {
    const k = `${r.candidateId}::${r.jobId}`;
    const sLvl = STAGE_LEVEL[r.stage as string] ?? 1;
    const eLvl = evMax.get(k) ?? 0;
    const level = Math.max(sLvl, eLvl, 1);
    const existing = unitMap.get(k);
    if (existing) {
      existing.level = Math.max(existing.level, level);
    } else {
      unitMap.set(k, {
        level,
        gender: r.gender,
        race: r.raceEthnicity,
        vet: r.veteranStatus,
        dis: r.disabilityStatus,
      });
    }
  }
  return [...unitMap.values()];
}

export interface GroupResult {
  group: string;
  appliedN: number;
  reachedN: number;
  selectionRate: number;
  insufficientData: boolean;
  impactRatio: number | null;
  flagged: boolean;
  isReference: boolean;
}

export interface MilestoneResult {
  milestone: string;
  label: string;
  insufficientData: boolean;
  referenceGroup: string | null;
  groups: GroupResult[];
}

export function analyzeAttribute(
  units: Unit[],
  key: string,
  label: string,
  groupsOf: (u: Unit) => string[],
): { key: string; label: string; milestones: MilestoneResult[] } {
  /* group label -> furthest levels of its members. NULL (prefer-not-to-say)
   * yields an empty group list and is excluded entirely. */
  const groupLevels = new Map<string, number[]>();
  for (const u of units) {
    for (const g of groupsOf(u)) {
      if (!groupLevels.has(g)) groupLevels.set(g, []);
      groupLevels.get(g)!.push(u.level);
    }
  }
  const milestones = ADVERSE_MILESTONES.map((m) => {
    const raw = [...groupLevels.entries()].map(([group, levels]) => {
      const appliedN = levels.length;
      const reachedN = levels.filter((l) => l >= m.level).length;
      const insufficientData = appliedN < MIN_GROUP_N;
      return {
        group,
        appliedN,
        reachedN,
        selectionRate: appliedN > 0 ? reachedN / appliedN : 0,
        insufficientData,
      };
    });
    const qualifying = raw.filter((g) => !g.insufficientData);
    let referenceGroup: string | null = null;
    let maxRate = 0;
    for (const g of qualifying)
      if (g.selectionRate > maxRate) {
        maxRate = g.selectionRate;
        referenceGroup = g.group;
      }
    /* Need at least two qualifying groups AND a non-zero reference rate to
     * compute a meaningful ratio; otherwise the milestone is insufficient. */
    const canCompare = qualifying.length >= 2 && maxRate > 0;
    const groups: GroupResult[] = raw
      .map((g) => {
        if (g.insufficientData || !canCompare) {
          return { ...g, impactRatio: null as number | null, flagged: false, isReference: false };
        }
        const impactRatio = g.selectionRate / maxRate;
        return {
          ...g,
          impactRatio,
          flagged: impactRatio < FOUR_FIFTHS,
          isReference: g.group === referenceGroup,
        };
      })
      .sort((a, b) => b.appliedN - a.appliedN);
    return {
      milestone: m.key,
      label: m.label,
      insufficientData: !canCompare,
      referenceGroup: canCompare ? referenceGroup : null,
      groups,
    };
  });
  return { key, label, milestones };
}

/** All four protected attributes, exactly as the route reports them. */
export function analyzeAllAttributes(units: Unit[]) {
  return [
    analyzeAttribute(units, "gender", "Gender", (u) => (u.gender ? [u.gender] : [])),
    analyzeAttribute(units, "raceEthnicity", "Race / Ethnicity", (u) =>
      u.race && u.race.length > 0 ? u.race : [],
    ),
    analyzeAttribute(units, "veteranStatus", "Veteran status", (u) => (u.vet ? [u.vet] : [])),
    analyzeAttribute(units, "disabilityStatus", "Disability status", (u) => (u.dis ? [u.dis] : [])),
  ];
}
