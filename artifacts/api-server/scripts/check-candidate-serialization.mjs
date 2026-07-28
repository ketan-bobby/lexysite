#!/usr/bin/env node
/**
 * scripts/check-candidate-serialization.mjs — CI guard for the mapCandidate() field-level chokepoint.
 *
 * `mapCandidate()` (src/routes/candidates.ts) is an EXPLICIT employer-facing ALLOWLIST: it
 * decides WHICH fields of a candidate row ever reach an employer, and deliberately DROPS the
 * privacy-posture columns (discoveryPaused, matchOnlyVisibility, hideFromCurrentEmployer,
 * currentEmployerDomain, blockedCompanyDomains, weeklyDigestLastSentAt) plus createdAt (a
 * job-seeking / sourcing-recency signal). See the Step-3 field-leak audit.
 *
 * A field-strip only helps if mapCandidate() is the ONLY path a full candidate row reaches a
 * response. The regression it replaced was a blind `{ ...candidateRow }` spread that let every
 * column ride along. This guard fails the build on any raw candidate-row spread (`...c`,
 * `...candidate`, …) or bare `res.json(candidateRow)` in the two files that own the candidate
 * response shape, so the next hand-written read cannot silently re-open the leak.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────────
 * The two files that read full candidatesTable rows and serialize them to employers. Other
 * route files serve NARROW column projections (`.select({ ... })`), not full rows, so a raw
 * spread there cannot carry a posture column. If a new file starts serializing full candidate
 * rows, add it to SCOPED_FILES.
 *
 * ─── What is flagged ─────────────────────────────────────────────────────────
 *  • An object spread of a candidate-row variable: `...c` / `...candidate` / `...merged` /
 *    `...existing` / `...updated` / `...created` / `...cand` / `...row`.
 *    (`...mapCandidate(c)` is NOT matched — the token after `...` is `mapCandidate`, and the
 *    safe idiom `const mapped = mapCandidate(c); { ...mapped }` uses a name outside the set.)
 *  • A bare `res.json(<candidateVar>)` / `.json(<candidateVar>)` of one of those variables.
 *
 * ─── What is NOT flagged ─────────────────────────────────────────────────────
 *  • `...mapCandidate(...)` — the chokepoint itself.
 *  • Any spread carrying an explicit `// candidate-serialization-exempt: <reason>` justification
 *    within the ~6 lines above it (each a reviewed, documented waiver — e.g. a transient row that
 *    is re-mapped before the response, a spread of already-mapped output, or a non-candidatesTable
 *    row such as a synthesized sourced_candidates row that has no posture columns).
 *  • Comments, and this script.
 *
 * ─── KNOWN GAP ───────────────────────────────────────────────────────────────
 * Line-oriented; it cannot follow indirection (a candidate row aliased to a non-listed name and
 * then spread, or built into a plain object elsewhere). The enforced convention is that the
 * candidate row keeps one of the listed names at the spread site — a reviewer catches the rest.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/** The files that own the employer-facing candidate response shape (read full rows). */
const SCOPED_FILES = [
  "src/routes/candidates.ts",
  "src/routes/communication.ts",
];

/** How far above a flagged line an exempt marker may sit. */
const EXEMPT_LOOKBACK = 6;
const EXEMPT_MARKER = "candidate-serialization-exempt";

/** Candidate-row variable names that must never be spread raw into a response. */
const CAND_VARS = "c|cand|candidate|merged|existing|updated|created|row";
/* A raw spread of a candidate-row variable: `...c` (word-bounded so `...cand` vs `...c` are
 * both caught, and `...mapCandidate(` — token `mapCandidate` — is not). */
const RAW_SPREAD = new RegExp(`\\.\\.\\.(?:${CAND_VARS})\\b`);
/* A bare `res.json(c)` / `.json(candidate)` of a candidate-row variable. */
const BARE_JSON = new RegExp(`\\.json\\(\\s*(?:${CAND_VARS})\\s*\\)`);

/** Per-line comment mask so we never match a pattern inside a comment. */
function computeCommentMask(lines) {
  const isComment = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) {
      isComment[i] = true;
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("//")) { isComment[i] = true; continue; }
    if (t.startsWith("/*")) {
      isComment[i] = true;
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
  }
  return isComment;
}

const offenders = [];
for (const rel of SCOPED_FILES) {
  const file = join(ROOT, rel);
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    console.error(`[check-candidate-serialization] ✗ scoped file missing: ${rel}`);
    process.exit(1);
  }
  const lines = src.split("\n");
  const isComment = computeCommentMask(lines);

  for (let i = 0; i < lines.length; i++) {
    if (isComment[i]) continue;
    const line = lines[i];
    if (!RAW_SPREAD.test(line) && !BARE_JSON.test(line)) continue;

    /* Honour a nearby reviewed exemption marker. */
    let exempt = false;
    for (let j = i; j >= Math.max(0, i - EXEMPT_LOOKBACK); j--) {
      if (lines[j].includes(EXEMPT_MARKER)) { exempt = true; break; }
    }
    if (exempt) continue;

    offenders.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
  }
}

if (offenders.length === 0) {
  console.log("[check-candidate-serialization] ✓ every full candidate-row serialization routes through mapCandidate()");
  process.exit(0);
}

console.error("[check-candidate-serialization] ✗ found raw candidate-row serialization bypassing mapCandidate():");
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.text}`);
}
console.error("");
console.error("Employer-facing candidate rows must be serialized through mapCandidate()");
console.error("(src/routes/candidates.ts) so privacy-posture columns + createdAt are stripped by");
console.error("the explicit allowlist. Replace the raw spread with `mapCandidate(row)`. If a site");
console.error("genuinely serves a non-candidatesTable row (e.g. a sourced_candidates row) or an");
console.error("already-mapped value, add a `// candidate-serialization-exempt: <reason>` comment");
console.error("directly above it explaining why.");
process.exit(1);
