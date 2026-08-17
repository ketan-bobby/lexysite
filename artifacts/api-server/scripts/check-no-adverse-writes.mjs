#!/usr/bin/env node
/**
 * scripts/check-no-adverse-writes.mjs — CI guard against governance bypass
 *
 * Greps for any code path that directly writes an adverse final-decision
 * value to applications.stage outside the central enforcement service.
 *
 * The list of allowed sites is small and deliberately maintained here
 * — adding a new entry requires a human decision, which is the point.
 * Every other occurrence fails the build.
 *
 * What counts as "adverse":
 *   - stage = 'rejected'
 *   - stage = 'lapsed'   (also gated under CO SB24-205)
 *
 * Allowed sites:
 *   - artifacts/api-server/src/lib/governance/*    (the enforcement service)
 *   - artifacts/api-server/src/routes/applications.ts:human-decision wiring
 *     (PUT writes through applyHumanDecision; the residual `as any` stage
 *     write is the legacy column, not a governance bypass)
 *   - artifacts/api-server/src/routes/pipeline.ts:applicationId reject
 *     (also routes through applyHumanDecision)
 *   - GDPR cascades in dnc.ts + career-profile.ts (route the closures
 *     through applyHumanDecision post-commit; see T010h follow-up)
 *
 * Tests + this script itself + comments + docs are excluded.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SEARCH_DIRS = [join(ROOT, "src")];

/* Files explicitly allowed to mention an adverse stage write. Paths
 * are relative to api-server/. Add entries here only after a human
 * review — each one is a potential compliance gap. */
const ALLOWED_FILES = new Set([
  // Pure-math unit test — "rejected" appears only as literal fixture data for
  // the 4/5ths calculation; no DB write of any kind in the file.
  "src/lib/adverse-impact.test.ts",
  "src/lib/governance/decision-enforcement.ts",
  "src/lib/governance/decision-events.ts",
  "src/lib/governance/policy-resolver.ts",
  "src/lib/governance/jurisdictions.ts",
  // Routes that route through applyHumanDecision — the stage write is
  // a back-compat shim on the legacy column, not a governance bypass.
  "src/routes/applications.ts",
  "src/routes/pipeline.ts",
  "src/routes/outreach.ts",
  // GDPR cascades — these write inside a tx, then call applyHumanDecision
  // post-commit with finalDecision='candidate_withdrawn'.
  "src/routes/dnc.ts",
  "src/routes/career-profile.ts",
  // Candidate-initiated "not for this role" quick-reply. Per the
  // decision-enforcement service docstring, candidate-initiated
  // withdrawal is an explicitly-allowed direct write (it is not an
  // AI-authored adverse action). Each call site here is paired with
  // recordRejection(), which itself emits an audit row.
  "src/routes/outreach-reply.ts",
  // This script itself documents the patterns it looks for.
  "scripts/check-no-adverse-writes.mjs",
]);

/* Patterns considered an adverse stage write. Conservative — false
 * positives are fine; a maintainer can promote the file to the allow
 * list after review. */
const PATTERNS = [
  /stage\s*[:=]\s*["']rejected["']/,
  /stage\s*[:=]\s*["']lapsed["']/,
  /\.set\s*\(\s*\{[^}]*stage\s*:\s*["']rejected["']/,
  /\.set\s*\(\s*\{[^}]*stage\s*:\s*["']lapsed["']/,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const offenders = [];
for (const dir of SEARCH_DIRS) {
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file);
    if (ALLOWED_FILES.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    /* Strip block & line comments cheaply to reduce false positives. */
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const lines = stripped.split("\n");
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        if (p.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
          break;
        }
      }
    });
  }
}

if (offenders.length === 0) {
  console.log("[check-no-adverse-writes] ✓ no ungoverned adverse stage writes found");
  process.exit(0);
}

console.error("[check-no-adverse-writes] ✗ found ungoverned adverse stage writes:");
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.text}`);
}
console.error("");
console.error("Adverse stage writes must route through the governance enforcement service.");
console.error("If this site is legitimately allowed (e.g. it routes through applyHumanDecision),");
console.error("add it to ALLOWED_FILES in scripts/check-no-adverse-writes.mjs after review.");
process.exit(1);
