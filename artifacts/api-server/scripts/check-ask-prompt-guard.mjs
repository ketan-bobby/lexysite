/* check:ask-prompt-guard — deterministic build gate (no AI calls).
 *
 * Guards the Market Intelligence Q&A layer against FACT-FABRICATION DRIFT.
 * This is a prompt-CONTENT guard, not a data-access guard: the /ask system
 * prompt (ASK_SYSTEM_PROMPT in lib/market-intelligence-ask.ts) carries the
 * constraining language that forbids the model from asserting market facts
 * without a tool call. If a future edit removes or weakens that language —
 * or removes the server-side code guarantees that back it up — the build
 * fails here, by design.
 *
 * Two layers are checked:
 *   1. PROMPT LANGUAGE — required constraint phrases must survive verbatim-ish
 *      (regex, tolerant of small rewording but not of removal):
 *        - tool-sourced-facts-only rule ("ONLY the data tools", "only state
 *          facts returned by tool calls", never own knowledge/training data)
 *        - explicit insufficiency rule (say "no_data" gaps out loud, never
 *          estimate around them)
 *        - citation rule (cite tool + asOf recency)
 *        - internal-first rule (get_internal_bench FIRST)
 *        - mandatory confidence statement
 *   2. SERVER-SIDE GUARANTEES — the code paths that make the rules true even
 *      if the model ignores them:
 *        - sanitizeToolArgs() strips model-supplied tenant scope
 *        - zero-ok-tools ⇒ buildInsufficientAnswer() replaces the narrative
 *        - buildConfidenceLine() is always attached
 *        - every attempted tool call is recorded to the executions audit trail
 *
 * If you INTENTIONALLY change the prompt: keep (or strengthen) the constraint
 * language so these regexes still match, or update this guard IN THE SAME
 * commit with reviewer sign-off — silently weakening the grounding contract
 * is the exact failure mode this gate exists to catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TAG = "[check-ask-prompt-guard]";
const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "src", "lib", "market-intelligence-ask.ts");

const src = readFileSync(LIB, "utf8");
let failed = false;
const fail = (msg) => { failed = true; console.error(`${TAG} ✗ ${msg}`); };

/* ── Extract ASK_SYSTEM_PROMPT template literal ─────────────────────────── */
const promptMatch = src.match(/export const ASK_SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!promptMatch) {
  fail(`could not find "export const ASK_SYSTEM_PROMPT = \`…\`;" in ${LIB} — if it moved/renamed, update this guard in the same commit.`);
  process.exit(1);
}
const prompt = promptMatch[1];

/* ── Layer 1: required constraint language in the prompt ────────────────── */
const PROMPT_RULES = [
  {
    name: "tool-sourced-facts-only (header)",
    re: /using ONLY the data tools provided/i,
    why: `the model must be told up front it answers ONLY from tools`,
  },
  {
    name: "hard-rules block present",
    re: /HARD RULES/,
    why: `the absolute-constraints block must not be softened into suggestions`,
  },
  {
    name: "facts must come from tool calls in this conversation",
    re: /only state facts returned by tool calls in THIS conversation/i,
    why: `removing this invites answers from training data`,
  },
  {
    name: "no own-knowledge market claims",
    re: /Never state a specific number, location, salary figure, or market claim from your own knowledge or training data/i,
    why: `this is the direct anti-fabrication sentence`,
  },
  {
    name: "insufficiency must be explicit, no estimates",
    re: /insufficient data[\s\S]{0,200}?(say so explicitly)[\s\S]{0,300}?(never substitute an estimate|never.{0,40}estimate)/i,
    why: `gaps must be said out loud, never papered over with estimates`,
  },
  {
    name: "citation rule (tool + recency)",
    re: /cite which tool result each claim came from[\s\S]{0,120}?asOf/i,
    why: `every claim must be traceable to a tool result and its timestamp`,
  },
  {
    name: "internal-bench-first doctrine",
    re: /ALWAYS call get_internal_bench FIRST/i,
    why: `the caller's own pool is the free answer and must stay first`,
  },
  {
    name: "mandatory confidence statement",
    re: /confidence statement/i,
    why: `answers must end with an honest coverage/confidence line`,
  },
];
for (const rule of PROMPT_RULES) {
  if (!rule.re.test(prompt)) {
    fail(`ASK_SYSTEM_PROMPT lost required constraint "${rule.name}" — ${rule.why}. Restore the language (or update this guard with review) before building.`);
  }
}

/* ── Layer 2: server-side guarantee code markers ─────────────────────────── */
const CODE_RULES = [
  {
    name: "model-arg sanitization",
    re: /const args = sanitizeToolArgs\(/,
    why: `tool args must pass sanitizeToolArgs so tenant scope can never be model-supplied`,
  },
  {
    name: "deterministic insufficiency override",
    re: /if \(!coverage\.sufficient\) \{[\s\S]{0,300}?buildInsufficientAnswer\(/,
    why: `zero-data answers must be DETERMINISTIC (model narrative discarded), not prompt-hoped`,
  },
  {
    name: "confidence line always computed server-side",
    re: /const confidence = buildConfidenceLine\(/,
    why: `the confidence line is a server guarantee, not a model courtesy`,
  },
  {
    name: "tool-call audit trail recorded",
    re: /executions\.push\(\{ round, tool: name, outcome: result\.status/,
    why: `every executed tool call must be recorded for groundedness spot-checks`,
  },
  {
    name: "unknown tools rejected",
    re: /rejected_unknown_tool/,
    why: `the model must not be able to invent tool names`,
  },
  {
    name: "general-guidance specifics scrubber applied",
    re: /generalGuidance = scrubGuidanceSpecifics\(/,
    why: `the general-guidance channel must pass through the deterministic scrubber so fabricated specifics cannot be smuggled in as "general knowledge"`,
  },
  {
    name: "general-guidance prompt forbids specific numbers",
    re: /export const GENERAL_GUIDANCE_PROMPT = `[\s\S]*?NEVER state a specific number[\s\S]*?`;/,
    why: `the second-pass prompt must forbid specific figures (the scrubber is the backstop, not the only line)`,
  },
];
for (const rule of CODE_RULES) {
  if (!rule.re.test(src)) {
    fail(`server-side guarantee missing: "${rule.name}" — ${rule.why}.`);
  }
}

if (failed) process.exit(1);
console.log(`${TAG} ✓ ASK_SYSTEM_PROMPT constraint language intact (${PROMPT_RULES.length} rules) and server-side grounding guarantees present (${CODE_RULES.length} markers)`);
