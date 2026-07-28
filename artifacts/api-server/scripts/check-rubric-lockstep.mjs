/* check:rubric-lockstep — deterministic build gate (no AI calls).
 *
 * Enforces two invariants on the per-answer grader rubric:
 *   1. LOCKSTEP: all 3 live copies (interviews.ts /answer, ai-queue handlers.ts
 *      gradeAnswer, regrade-stale-interview-scores.mjs) carry byte-identical
 *      rubric wording.
 *   2. CALIBRATED: the rubric's sha256 matches scripts/rubric-calibration.lock.json,
 *      which is only (re)written by a PASSING run of the AI calibration probe
 *      (pnpm run check:rubric-calibration). Editing the prompt without re-running
 *      the probe matrix (incl. variant E narrative-vs-STAR fairness gate) fails
 *      the build by design — calibration is a standing check, not a one-off.
 */
import { readFileSync } from "node:fs";
import {
  RUBRIC_FILES,
  extractRubric,
  rubricSha256,
  contractSha256,
  LOCK_PATH,
} from "./rubric-extract.mjs";

const TAG = "[check-rubric-lockstep]";
let failed = false;

const rubrics = RUBRIC_FILES.map((f) => ({ f, text: extractRubric(f) }));
const canonical = rubrics[0].text;
for (const { f, text } of rubrics.slice(1)) {
  if (text !== canonical) {
    failed = true;
    console.error(`${TAG} ✗ rubric in ${f} differs from ${RUBRIC_FILES[0]} — the 3 copies must stay in lockstep.`);
  }
}

const sha = rubricSha256(canonical);
const contractSha = contractSha256();
let lock = null;
try {
  lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
} catch {
  failed = true;
  console.error(`${TAG} ✗ missing ${LOCK_PATH} — run: pnpm run check:rubric-calibration`);
}
if (lock && (lock.rubricSha256 !== sha || lock.contractSha256 !== contractSha)) {
  failed = true;
  const what = lock.rubricSha256 !== sha ? "rubric" : "grading prompt contract (user/system template, focus-line, or fairness directive)";
  console.error(
    `${TAG} ✗ ${what} changed since last calibration (rubric ${sha.slice(0, 12)}…/${String(lock.rubricSha256).slice(0, 12)}…, contract ${contractSha.slice(0, 12)}…/${String(lock.contractSha256).slice(0, 12)}…).\n` +
      `${TAG}   Re-run the calibration probe matrix (incl. variant E narrative-vs-STAR gate):\n` +
      `${TAG}     pnpm run check:rubric-calibration\n` +
      `${TAG}   A passing run updates the lock. A widened narrative-vs-STAR gap is a fairness regression to FIX, not to waive.`
  );
}

if (failed) process.exit(1);
console.log(`${TAG} ✓ 3 rubric copies in lockstep, calibration lock matches (rubric ${sha.slice(0, 12)}…, contract ${contractSha.slice(0, 12)}…, probed ${lock.probedAt})`);
