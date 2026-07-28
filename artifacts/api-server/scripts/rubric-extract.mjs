/* Shared extractor for the per-answer grader's PROMPT CONTRACT.
 *
 * The grading behavior is defined by more than the rubric sentence: it also
 * depends on the full user-prompt template (incl. the ${...focusLine} slot),
 * the system prompt, the focus-line composition, and FAIRNESS_DIRECTIVE.
 * Two hashes are locked:
 *   - rubricSha256:   the rubric sentence span only (also lockstep-checked
 *                     byte-identical across the 3 copies) — what the AI
 *                     calibration probe actually exercises.
 *   - contractSha256: ALL grading-relevant SOURCE spans below, concatenated
 *                     with labels. Any edit to any span (wording OR
 *                     interpolation slots) changes this hash and fails the
 *                     build until recalibration passes.
 *
 * Live copies (rubric kept in byte-lockstep):
 *   - src/routes/interviews.ts        (POST /answer)         — canonical
 *   - src/lib/ai-queue/handlers.ts    (/end + queue gradeAnswer)
 *   - scripts/regrade-stale-interview-scores.mjs (backfill)
 * Template-literal concatenation seams (`" + "` in the .mjs copy) are
 * collapsed before matching. Every span pattern asserts an EXACT expected
 * match count per file — a moved/duplicated span fails loudly instead of
 * silently hashing the wrong text.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RUBRIC_FILES = [
  "src/routes/interviews.ts",
  "src/lib/ai-queue/handlers.ts",
  "scripts/regrade-stale-interview-scores.mjs",
];

const RUBRIC_RE =
  /Rate this interview answer from 0 to 100[\s\S]*?prevents understanding\./g;
/* Full user-prompt template: rubric through the end of the enclosing literal
 * (covers focusLine slot, Question/Answer framing, Return JSON instruction). */
const USER_PROMPT_RE = /Rate this interview answer from 0 to 100[^`]*`/g;
/* System prompt literal (covers FAIRNESS_DIRECTIVE slot + any language line). */
const SYSTEM_PROMPT_RE = /You are a rigorous interviewer grading a single answer[^`]*`/g;
/* focusLine composition in handlers.ts (grader + summary + /end variants). */
const FOCUS_LINE_RE =
  /const (?:graderFocusLine|summaryFocusLine|focusLine) = endFocusDir[\s\S]*?: "";/g;
const FAIRNESS_RE = /export const FAIRNESS_DIRECTIVE =[\s\S]*?;/;

function loadCollapsed(relFile) {
  const src = readFileSync(path.join(ROOT, relFile), "utf8");
  return src.replace(/`\s*\+\s*\r?\n?\s*`/g, "");
}

function matchExactly(src, re, count, label, file) {
  const m = src.match(re) ?? [];
  if (m.length !== count) {
    throw new Error(
      `[rubric-extract] expected exactly ${count} match(es) of ${label} in ${file}, found ${m.length} — the grading prompt moved or was duplicated; update scripts/rubric-extract.mjs anchors deliberately.`,
    );
  }
  return m;
}

export function extractRubric(relFile) {
  return matchExactly(loadCollapsed(relFile), RUBRIC_RE, 1, "rubric span", relFile)[0];
}

export function liveRubric() {
  return extractRubric(RUBRIC_FILES[0]); // interviews.ts is canonical
}

/** All grading-relevant source spans, labeled, in a fixed order. */
export function contractSpans() {
  const spans = [];
  for (const f of RUBRIC_FILES) {
    const src = loadCollapsed(f);
    spans.push([`${f}#user-prompt`, matchExactly(src, USER_PROMPT_RE, 1, "user-prompt template", f)[0]]);
    spans.push([`${f}#system-prompt`, matchExactly(src, SYSTEM_PROMPT_RE, 1, "system-prompt template", f)[0]]);
  }
  const handlersSrc = loadCollapsed("src/lib/ai-queue/handlers.ts");
  matchExactly(handlersSrc, FOCUS_LINE_RE, 3, "focus-line composition", "src/lib/ai-queue/handlers.ts").forEach(
    (s, i) => spans.push([`handlers.ts#focus-line-${i}`, s]),
  );
  const fairnessSrc = readFileSync(path.join(ROOT, "src/lib/fairness.ts"), "utf8");
  const fm = fairnessSrc.match(FAIRNESS_RE);
  if (!fm) throw new Error("[rubric-extract] FAIRNESS_DIRECTIVE not found in src/lib/fairness.ts");
  spans.push(["fairness.ts#directive", fm[0]]);
  return spans;
}

export function rubricSha256(rubric) {
  return createHash("sha256").update(rubric, "utf8").digest("hex");
}

export function contractSha256() {
  const h = createHash("sha256");
  for (const [label, text] of contractSpans()) h.update(`\u0000${label}\u0000${text}`, "utf8");
  return h.digest("hex");
}

export const LOCK_PATH = path.join(ROOT, "scripts", "rubric-calibration.lock.json");
