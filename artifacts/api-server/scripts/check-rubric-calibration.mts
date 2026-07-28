/* check:rubric-calibration — standing AI calibration probe with HARD gates.
 *
 * Runs the LIVE per-answer grader rubric (extracted from src/routes/interviews.ts,
 * never a stale copy) over the full variant matrix — A STAR+substantive,
 * B rambling+substantive, C STAR+thin, D rambling+thin, E narrative+substantive —
 * across 2 questions × REPS (default 2), then enforces pass/fail gates:
 *
 *   GATE 1 (fairness, the reason this exists): narrative-vs-STAR gap.
 *     mean(A) − mean(E) must be ≤ 10 points per question. A and E carry the SAME
 *     verifiable facts; only the telling differs (STAR-coached vs communal
 *     chronological narrative). A wider gap = the grader rewards Western interview
 *     coaching, i.e. a REAL fairness regression to fix immediately — never waive.
 *   GATE 2: empty-STAR stays out of the strong band — mean(C) ≤ 75 per question.
 *   GATE 3: substance is not harmed — mean(B) ≥ 75 and mean(E) ≥ 75 per question.
 *   GATE 4: thin answers stay low — mean(D) ≤ 60 per question.
 *
 * On PASS: writes scripts/rubric-calibration.lock.json (rubric sha256 + results).
 * The deterministic build gate check:rubric-lockstep compares the live rubric's
 * sha to this lock, so any future prompt edit FAILS THE BUILD until this probe
 * is re-run and passes. Run: pnpm run check:rubric-calibration  (needs AI creds;
 * run via bash/workflow env, not the sandbox).
 *
 * scripts/rubric-probe.mts remains the exploratory OLD-vs-NEW comparison tool;
 * THIS file is the enforcement gate. Variant texts are mirrored from the probe —
 * keep them stable so runs stay comparable across time.
 */
import { writeFileSync } from "node:fs";
import { generateJSON } from "../src/lib/ai";
import { FAIRNESS_DIRECTIVE } from "../src/lib/fairness";
// @ts-ignore — plain-JS helper shared with the deterministic lockstep check
import { liveRubric, rubricSha256, contractSha256, LOCK_PATH } from "./rubric-extract.mjs";

const TAG = "[check-rubric-calibration]";
const REPS = Number(process.env.REPS ?? 2);
const NARRATIVE_GAP_MAX = 10;

const QUESTIONS: Record<string, string> = {
  behavioral: "Tell me about a time you had to resolve a conflict within your team.",
  technical: "Describe how you improved the performance of a slow system you were responsible for.",
};

const VARIANTS: Record<string, Record<string, string>> = {
  A_star_substantive: {
    behavioral:
      "Situation: two senior engineers on my team of six disagreed over migrating our billing service to event-driven architecture, and PR reviews had stalled for two weeks. Task: as tech lead I needed to unblock the Q3 billing launch. Action: I ran a two-day spike where each wrote a prototype against our real invoice replay dataset of 1.2 million events; we measured p99 latency and failure recovery. Result: the event-driven prototype cut reconciliation errors by 40%, both engineers agreed on the data, and we shipped three weeks early. The dissenting engineer later led the rollout.",
    technical:
      "Situation: our search API p95 latency had degraded to 2.4 seconds. Task: I owned getting it under 500ms before the enterprise renewal. Action: I profiled with flame graphs, found 60% of time in N+1 permission checks, batched them into a single Redis MGET, and added a 30-second materialized permission cache. Result: p95 dropped to 320ms, infra cost fell 18%, and the renewal closed.",
  },
  B_ramble_substantive: {
    behavioral:
      "Oh, there was this whole thing with the billing migration, right, so two of our senior folks basically stopped approving each other's PRs for like two weeks, one wanted event-driven and one didn't, and I'm the lead so it lands on me, and honestly what worked was I just said fine, both of you build it, two days, against the real data — we had this replay set, 1.2 million invoice events — and we measured it, p99 and recovery, and the event-driven one had 40% fewer reconciliation errors so that settled it, we actually shipped three weeks early and funnily enough the guy who was against it ended up leading the rollout.",
    technical:
      "So the search API had gotten really bad, like 2.4 seconds at p95, and we had this enterprise renewal hanging on it, so I got flame graphs going and it turned out 60% of the time was these N+1 permission checks, one per document, madness, so I batched them into one Redis MGET and put a 30-second cache on the materialized permissions and boom, 320ms p95, and infra cost actually went down 18% too, and the renewal went through.",
  },
  C_star_thin: {
    behavioral:
      "Situation: there was a disagreement between two colleagues on my team about a technical direction. Task: as the team lead, it was my responsibility to resolve the conflict and keep the project moving. Action: I brought both parties together, facilitated an open and respectful discussion, made sure each side felt heard, and guided the team toward alignment on a shared solution. Result: the conflict was resolved, team morale improved, and we successfully delivered the project on time. It taught me the importance of communication and empathy in leadership.",
    technical:
      "Situation: a system I was responsible for was experiencing performance issues. Task: I needed to identify the bottlenecks and improve the system's speed. Action: I analyzed the system thoroughly, identified the key areas for improvement, and implemented industry best practices and optimizations. Result: the system's performance improved significantly and stakeholders were very satisfied with the outcome. This experience strengthened my problem-solving and analytical skills.",
  },
  D_ramble_thin: {
    behavioral:
      "Yeah so conflicts happen, you know, people disagree, that's normal on teams, and I think the main thing is you just have to talk it out, like I always try to get people talking and usually things work out, I mean in my experience if you just listen to people they calm down, and yeah we always managed to sort things out one way or another and keep going, communication is really the key I'd say.",
    technical:
      "I mean performance stuff comes up all the time, and generally you just have to dig in and find what's slow, right, there are tools for that, and I've done that kind of thing, found slow parts and made them faster, caching and things like that usually, and it worked out fine, the systems got faster and everyone was happy with it.",
  },
  E_narrative_substantive: {
    behavioral:
      "In my last team we were six people working on the billing service, and I remember the period when we had to decide about moving to event-driven processing. Two of our most experienced colleagues saw it very differently, and for some two weeks the work slowed because they would not approve each other's changes. In our team we believe decisions should come from evidence, not seniority, so I proposed that we let the system itself answer: each of them built their approach and we replayed our real history — 1.2 million invoice events — through both, watching the p99 latency and how each recovered from failures. When we all sat together and saw the event-driven version made 40% fewer reconciliation mistakes, the disagreement simply dissolved. We finished three weeks before the deadline, and the colleague who had opposed the change asked to lead the rollout himself, which made me happy.",
    technical:
      "There was a time our search service had become painfully slow — people were waiting almost two and a half seconds, 2.4 at p95, and an important enterprise customer's renewal depended on fixing it. I spent the first days simply watching the system with flame graphs, the way you listen before you speak, and what I found was that 60% of the time went to permission checks done one by one for every document. So we gathered them into a single Redis MGET call and kept a short 30-second cache of the materialized permissions. Afterward the waiting time came down to 320 milliseconds, our infrastructure bill fell by 18%, and the customer stayed with us.",
  },
};

async function grade(rubric: string, question: string, answer: string): Promise<number> {
  const res = await generateJSON<{ score: number; feedback: string }>(
    `${rubric}\nQuestion: ${question}\nAnswer: ${answer}\nReturn JSON: { "score": number, "feedback": string (1 honest sentence in English) }`,
    `You are a rigorous interviewer grading a single answer. Be honest and calibrated — never inflate a weak or non-serious answer. Respond with valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
    "en",
  );
  return Math.min(100, Math.max(0, Math.round(res.score ?? 0)));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  const rubric = liveRubric();
  const sha = rubricSha256(rubric);
  console.log(`${TAG} live rubric sha ${sha.slice(0, 12)}…, REPS=${REPS}`);

  const means: Record<string, Record<string, number>> = {};
  for (const [vName, byQ] of Object.entries(VARIANTS)) {
    means[vName] = {};
    for (const [qName, qText] of Object.entries(QUESTIONS)) {
      const scores: number[] = [];
      for (let i = 0; i < REPS; i++) scores.push(await grade(rubric, qText, byQ[qName]));
      means[vName][qName] = mean(scores);
      console.log(`${TAG} ${vName} ${qName}: [${scores.join(", ")}] mean=${means[vName][qName]}`);
    }
  }

  const failures: string[] = [];
  for (const q of Object.keys(QUESTIONS)) {
    const gap = means.A_star_substantive[q] - means.E_narrative_substantive[q];
    if (gap > NARRATIVE_GAP_MAX)
      failures.push(
        `GATE 1 FAIRNESS REGRESSION (${q}): narrative-vs-STAR gap ${gap.toFixed(1)} > ${NARRATIVE_GAP_MAX}. ` +
          `Identical facts, different telling — the rubric is rewarding interview coaching. FIX THE PROMPT NOW; do not waive or re-roll.`,
      );
    if (means.C_star_thin[q] > 75)
      failures.push(`GATE 2 (${q}): empty-STAR mean ${means.C_star_thin[q]} > 75 — structure-without-substance is back in the strong band.`);
    if (means.B_ramble_substantive[q] < 75)
      failures.push(`GATE 3 (${q}): rambling+substantive mean ${means.B_ramble_substantive[q]} < 75 — substance is being punished.`);
    if (means.E_narrative_substantive[q] < 75)
      failures.push(`GATE 3 (${q}): narrative+substantive mean ${means.E_narrative_substantive[q]} < 75 — narrative substance is being punished.`);
    if (means.D_ramble_thin[q] > 60)
      failures.push(`GATE 4 (${q}): thin-rambling mean ${means.D_ramble_thin[q]} > 60 — vague answers are being inflated.`);
  }

  if (failures.length) {
    for (const f of failures) console.error(`${TAG} ✗ ${f}`);
    console.error(`${TAG} FAILED — lock NOT updated; check:rubric-lockstep will keep the build red until the prompt is fixed and this passes.`);
    process.exit(1);
  }

  writeFileSync(
    LOCK_PATH,
    JSON.stringify(
      {
        _comment:
          "Written ONLY by a passing run of check:rubric-calibration. Never hand-edit — check:rubric-lockstep (build gate) verifies the live rubric sha against this.",
        rubricSha256: sha,
        contractSha256: contractSha256(),
        probedAt: new Date().toISOString(),
        reps: REPS,
        narrativeGapMax: NARRATIVE_GAP_MAX,
        means,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${TAG} ✓ all gates passed — lock updated (${LOCK_PATH})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
