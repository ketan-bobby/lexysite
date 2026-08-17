/**
 * adverse-impact.test.ts — locks in the four-fifths (80%) rule math
 * (lib/adverse-impact.ts). These tests are the guardrail the fairness
 * dashboard stands on: if a change silently alters a level mapping, the unit
 * collapse, or the ratio/flag logic, this suite fails.
 *
 * Run: pnpm --filter @workspace/api-server run test:adverse-impact
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_GROUP_N,
  FOUR_FIFTHS,
  STAGE_LEVEL,
  EVENT_LEVEL,
  ADVERSE_MILESTONES,
  buildEventMax,
  buildUnits,
  analyzeAttribute,
  analyzeAllAttributes,
  type BaseRow,
  type Unit,
} from "./adverse-impact.js";

/* ── helpers ────────────────────────────────────────────────────────────────── */

function unitsForGroups(
  spec: Record<string, { n: number; reached: number; level?: number }>,
): Unit[] {
  /* Build units where `reached` members of each gender group sit at `level`
   * (default 2 = screened) and the rest at level 1. */
  const units: Unit[] = [];
  for (const [gender, { n, reached, level = 2 }] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) {
      units.push({ level: i < reached ? level : 1, gender, race: null, vet: null, dis: null });
    }
  }
  return units;
}

function genderMilestone(units: Unit[], milestoneKey = "screened") {
  const res = analyzeAttribute(units, "gender", "Gender", (u) => (u.gender ? [u.gender] : []));
  const m = res.milestones.find((x) => x.milestone === milestoneKey)!;
  return m;
}

/* ── level-map invariants (compliance semantics) ────────────────────────────── */

test("INTERVIEW_STARTED counts as interviewed (level 3), the invite does not", () => {
  assert.equal(EVENT_LEVEL.INTERVIEW_STARTED, 3);
  assert.equal(EVENT_LEVEL.INTERVIEW_INVITED, 2);
});

test("terminal rejected/withdrawn stages stay at level 1 (event log recovers the real furthest level)", () => {
  assert.equal(STAGE_LEVEL.rejected, 1);
  assert.equal(STAGE_LEVEL.withdrawn, 1);
});

test("screening stage IS the screened milestone (level 2); hired/started are level 5", () => {
  assert.equal(STAGE_LEVEL.screening, 2);
  assert.equal(STAGE_LEVEL.hired, 5);
  assert.equal(STAGE_LEVEL.started, 5);
  assert.equal(EVENT_LEVEL.HIRED, 5);
});

test("milestone levels are the canonical funnel: screened 2 → interviewed 3 → offer 4 → hired 5", () => {
  assert.deepEqual(
    ADVERSE_MILESTONES.map((m) => [m.key, m.level]),
    [
      ["screened", 2],
      ["interviewed", 3],
      ["offer", 4],
      ["hired", 5],
    ],
  );
});

/* ── buildEventMax ──────────────────────────────────────────────────────────── */

test("buildEventMax keeps the MAX level per (candidate,job) and defaults unknown events to 1", () => {
  const evMax = buildEventMax([
    { candidateId: "c1", jobId: "j1", eventType: "OUTREACH_SENT" }, // 1
    { candidateId: "c1", jobId: "j1", eventType: "INTERVIEW_STARTED" }, // 3
    { candidateId: "c1", jobId: "j1", eventType: "INTERVIEW_INVITED" }, // 2 (must not lower)
    { candidateId: "c1", jobId: "j2", eventType: "SOME_FUTURE_EVENT" }, // unknown → 1
  ]);
  assert.equal(evMax.get("c1::j1"), 3);
  assert.equal(evMax.get("c1::j2"), 1);
});

/* ── buildUnits: (candidate,job) collapse + furthest-level reconstruction ───── */

test("unit = (candidate,job): duplicate application rows collapse to ONE unit with the furthest level", () => {
  const rows: BaseRow[] = [
    {
      candidateId: "c1",
      jobId: "j1",
      stage: "rejected",
      gender: "woman",
      raceEthnicity: null,
      veteranStatus: null,
      disabilityStatus: null,
    },
    {
      candidateId: "c1",
      jobId: "j1",
      stage: "interview",
      gender: "woman",
      raceEthnicity: null,
      veteranStatus: null,
      disabilityStatus: null,
    },
    {
      candidateId: "c1",
      jobId: "j2",
      stage: "applied",
      gender: "woman",
      raceEthnicity: null,
      veteranStatus: null,
      disabilityStatus: null,
    },
  ];
  const units = buildUnits(rows, new Map());
  assert.equal(units.length, 2, "3 app rows → 2 (candidate,job) units");
  assert.deepEqual(units.map((u) => u.level).sort(), [1, 3]);
});

test("furthest level = max(stage level, event level, 1) — event log recovers pre-rejection progress", () => {
  const rows: BaseRow[] = [
    {
      candidateId: "c1",
      jobId: "j1",
      stage: "rejected",
      gender: "man",
      raceEthnicity: null,
      veteranStatus: null,
      disabilityStatus: null,
    },
  ];
  const evMax = buildEventMax([
    { candidateId: "c1", jobId: "j1", eventType: "INTERVIEW_COMPLETED" },
  ]);
  const [u] = buildUnits(rows, evMax);
  assert.equal(u.level, 3, "rejected AFTER interviewing still counts as interviewed");
});

test("unknown stage and no events floors at level 1 (never 0, never NaN)", () => {
  const [u] = buildUnits(
    [
      {
        candidateId: "c1",
        jobId: "j1",
        stage: "weird_new_stage",
        gender: null,
        raceEthnicity: null,
        veteranStatus: null,
        disabilityStatus: null,
      },
    ],
    new Map(),
  );
  assert.equal(u.level, 1);
});

/* ── analyzeAttribute: the 4/5ths rule itself ───────────────────────────────── */

test("flags a group whose impact ratio is below 0.8 and marks the reference group", () => {
  // reference: 30 men, 20 reached (rate .667); 30 women, 10 reached (rate .333) → ratio 0.5 < 0.8
  const m = genderMilestone(
    unitsForGroups({ man: { n: 30, reached: 20 }, woman: { n: 30, reached: 10 } }),
  );
  const men = m.groups.find((g) => g.group === "man")!;
  const women = m.groups.find((g) => g.group === "woman")!;
  assert.equal(m.insufficientData, false);
  assert.equal(m.referenceGroup, "man");
  assert.equal(men.isReference, true);
  assert.equal(men.flagged, false);
  assert.ok(Math.abs(women.impactRatio! - 0.5) < 1e-9);
  assert.equal(women.flagged, true);
});

test("does NOT flag at exactly the 4/5ths boundary (ratio 0.8 is compliant)", () => {
  // rates: 1.0 vs 0.8 → ratio exactly 0.8
  const m = genderMilestone(
    unitsForGroups({ man: { n: 30, reached: 30 }, woman: { n: 30, reached: 24 } }),
  );
  const women = m.groups.find((g) => g.group === "woman")!;
  assert.ok(Math.abs(women.impactRatio! - FOUR_FIFTHS) < 1e-9);
  assert.equal(women.flagged, false, "0.8 exactly must not flag — flag requires strictly below");
});

test("a group below MIN_GROUP_N gets no ratio (insufficientData) and can never be flagged", () => {
  const m = genderMilestone(
    unitsForGroups({
      man: { n: MIN_GROUP_N, reached: 25 },
      woman: { n: MIN_GROUP_N, reached: 25 },
      nonbinary: { n: 5, reached: 0 }, // tiny group with 0% selection — must NOT flag
    }),
  );
  const small = m.groups.find((g) => g.group === "nonbinary")!;
  assert.equal(small.insufficientData, true);
  assert.equal(small.impactRatio, null);
  assert.equal(small.flagged, false);
  assert.equal(m.insufficientData, false, "the two qualifying groups still compare");
});

test("fewer than two qualifying groups ⇒ whole milestone insufficient, no ratios fabricated", () => {
  const m = genderMilestone(
    unitsForGroups({ man: { n: 40, reached: 30 }, woman: { n: 10, reached: 1 } }),
  );
  assert.equal(m.insufficientData, true);
  assert.equal(m.referenceGroup, null);
  for (const g of m.groups) {
    assert.equal(g.impactRatio, null);
    assert.equal(g.flagged, false);
  }
});

test("zero reference rate (nobody reached the milestone) ⇒ insufficient, not division by zero", () => {
  const m = genderMilestone(
    unitsForGroups({ man: { n: 30, reached: 0 }, woman: { n: 30, reached: 0 } }),
  );
  assert.equal(m.insufficientData, true);
  for (const g of m.groups) assert.equal(g.impactRatio, null);
});

test("null demographics (prefer-not-to-say) are excluded from every group and denominator", () => {
  const units = unitsForGroups({ man: { n: 30, reached: 15 }, woman: { n: 30, reached: 15 } });
  units.push(
    ...Array.from({ length: 50 }, () => ({
      level: 5,
      gender: null,
      race: null,
      vet: null,
      dis: null,
    })),
  );
  const m = genderMilestone(units);
  assert.equal(
    m.groups.reduce((s, g) => s + g.appliedN, 0),
    60,
    "50 null-gender units contribute nothing",
  );
});

test("multi-select race fans one unit into EACH selected group", () => {
  const units: Unit[] = [
    ...Array.from({ length: 30 }, (_, i) => ({
      level: i < 15 ? 2 : 1,
      gender: null,
      race: ["asian"],
      vet: null,
      dis: null,
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      level: i < 15 ? 2 : 1,
      gender: null,
      race: ["black", "asian"],
      vet: null,
      dis: null,
    })),
  ];
  const res = analyzeAttribute(units, "raceEthnicity", "Race / Ethnicity", (u) =>
    u.race && u.race.length > 0 ? u.race : [],
  );
  const m = res.milestones.find((x) => x.milestone === "screened")!;
  assert.equal(
    m.groups.find((g) => g.group === "asian")!.appliedN,
    60,
    "dual-select counts in both groups",
  );
  assert.equal(m.groups.find((g) => g.group === "black")!.appliedN, 30);
});

test("selection rate counts units AT OR ABOVE the milestone level (hired implies interviewed)", () => {
  const units = unitsForGroups({
    man: { n: 30, reached: 12, level: 5 },
    woman: { n: 30, reached: 12, level: 5 },
  });
  const interviewed = genderMilestone(units, "interviewed");
  const hired = genderMilestone(units, "hired");
  assert.equal(interviewed.groups[0].reachedN, 12);
  assert.equal(hired.groups[0].reachedN, 12);
});

test("analyzeAllAttributes reports exactly the four protected attributes in canonical order", () => {
  const attrs = analyzeAllAttributes([]);
  assert.deepEqual(
    attrs.map((a) => a.key),
    ["gender", "raceEthnicity", "veteranStatus", "disabilityStatus"],
  );
  for (const a of attrs) assert.equal(a.milestones.length, ADVERSE_MILESTONES.length);
});

test("groups are sorted by applicant count descending (stable report layout)", () => {
  const m = genderMilestone(
    unitsForGroups({ man: { n: 35, reached: 20 }, woman: { n: 60, reached: 40 } }),
  );
  assert.deepEqual(
    m.groups.map((g) => g.group),
    ["woman", "man"],
  );
});
