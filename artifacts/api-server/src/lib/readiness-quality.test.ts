import { test } from "node:test";
import assert from "node:assert/strict";
import { answerSubstance, computeInterviewQuality } from "./readiness-quality";

const turns = (...answers: string[]) => answers.map((content) => ({ role: "user", content }));

/* ── the core bug: short-dense vs long-padded ───────────────────────────── */

const SHORT_DENSE = "Led migration to Kubernetes in 2023; cut deploy time 40% for a team of 12.";

const LONG_PADDED =
  "Well, you know, I think that basically I have always been someone who " +
  "really likes to work hard and I feel like I am a very good team player " +
  "and I always try my best in everything that I do because I think that " +
  "working hard is really important and being a good team player is also " +
  "really important and I always try to do my best.";

test("short dense answer outscores long padded answer (the volume-bias fix)", () => {
  const dense = computeInterviewQuality(turns(SHORT_DENSE));
  const padded = computeInterviewQuality(turns(LONG_PADDED));
  assert.ok(dense > padded, `dense (${dense}) must beat padded (${padded})`);
});

test("padded verbosity no longer earns near-full credit", () => {
  const padded = computeInterviewQuality(turns(LONG_PADDED));
  // Old metric gave this ~100 (full ratio + full depth). Must be well below.
  assert.ok(padded <= 70, `padded scored ${padded}, expected <= 70`);
});

test("short dense answers are not shown as 'getting started'", () => {
  const dense = computeInterviewQuality(turns(SHORT_DENSE, SHORT_DENSE));
  // Old metric: ~40% (75 chars vs 120 benchmark * 0.6 + 0.4). Must be solid now.
  assert.ok(dense >= 65, `dense scored ${dense}, expected >= 65`);
});

/* ── invariants preserved from the old metric ───────────────────────────── */

test("no candidate turns → floor of 5", () => {
  assert.equal(computeInterviewQuality([]), 5);
  assert.equal(computeInterviewQuality([{ role: "assistant", content: "Hi!" }]), 5);
});

test("only one-word / sub-30-char replies → floor of 5", () => {
  assert.equal(computeInterviewQuality(turns("yes", "no", "maybe idk")), 5);
});

test("one-word replies still drag down a mixed transcript", () => {
  const allGood = computeInterviewQuality(
    turns(SHORT_DENSE, SHORT_DENSE, SHORT_DENSE, SHORT_DENSE),
  );
  const mixed = computeInterviewQuality(turns(SHORT_DENSE, "yes", "no", "sure"));
  assert.ok(mixed < allGood, `mixed (${mixed}) < allGood (${allGood})`);
});

test("output is clamped to [5, 100] and rounded", () => {
  const q = computeInterviewQuality(
    turns(
      "In 2021 I shipped the Stripe integration, grew ARR 30% to $4M, " +
        "managed 8 engineers across Berlin and Madrid using Terraform and AWS.",
    ),
  );
  assert.ok(q >= 5 && q <= 100 && Number.isInteger(q));
});

/* ── fairness: script-agnostic behaviour ────────────────────────────────── */

test("space-less script (Chinese) with specifics is not penalised for tokenisation", () => {
  const zh =
    "我在2022年带领12人团队完成了支付平台迁移,部署时间缩短了40%,并将系统可用性提升到99.9%。";
  const q = computeInterviewQuality(turns(zh));
  assert.ok(q >= 60, `Chinese dense answer scored ${q}, expected >= 60`);
});

test("answers without any numbers still earn credit from named specifics + density", () => {
  const noNumbers =
    "I designed the onboarding flow for Acme using Figma, ran usability " +
    "sessions with enterprise customers, then handed a component library to Engineering.";
  const q = computeInterviewQuality(turns(noNumbers));
  assert.ok(q >= 55, `no-number specific answer scored ${q}, expected >= 55`);
});

/* ── anti-gaming: markers alone cannot buy a high score ─────────────────── */

test("numeric spam does not earn a high score", () => {
  const spam = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23";
  const q = computeInterviewQuality(turns(spam));
  // markers max out, but density of numeric filler + short depth keep it modest;
  // must not reach the "Detailed" (>=80) band.
  assert.ok(q < 80, `numeric spam scored ${q}, expected < 80`);
});

test("repeated-token gibberish with a number scores low", () => {
  const gibberish =
    "blah blah blah blah blah blah blah blah blah blah blah blah blah " +
    "blah blah blah blah blah blah blah blah blah blah blah 40% blah";
  const q = computeInterviewQuality(turns(gibberish));
  assert.ok(q <= 60, `gibberish scored ${q}, expected <= 60`);
  const genuine = computeInterviewQuality(turns(SHORT_DENSE));
  assert.ok(q < genuine, `gibberish (${q}) must score below genuine (${genuine})`);
});

/* ── candidate-facing band: strong concise transcript is not "low quality" ── */

test("strong concise transcript clears the low-quality tip threshold (q >= 60)", () => {
  // In computeReadinessScore, q < 0.6 shows "redo the interview" coaching and
  // shrinks interview-derived points. A concise substantive transcript must clear it.
  const q = computeInterviewQuality(
    turns(
      SHORT_DENSE,
      "Built the pricing model in SQL and dbt; raised gross margin 6 points in 2024.",
      "Mentored 3 juniors; two promoted within a year at Globex.",
    ),
  );
  assert.ok(q >= 60, `concise strong transcript scored ${q}, expected >= 60`);
});

/* ── answerSubstance unit behaviour ─────────────────────────────────────── */

test("answerSubstance: empty → 0, dense-with-markers ≈ high, padding ≈ low", () => {
  assert.equal(answerSubstance(""), 0);
  const dense = answerSubstance(SHORT_DENSE);
  const padded = answerSubstance(LONG_PADDED);
  assert.ok(dense > 0.7, `dense substance ${dense}`);
  assert.ok(padded < 0.35, `padded substance ${padded}`);
});
