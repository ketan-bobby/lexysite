/**
 * fairness-firewall.test.ts — Demographics isolation guard (Task #21, Step 3)
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * Voluntary self-identification data (candidate_demographics) is a strict
 * compliance firewall: under EEO (US) and GDPR Article 9 (EU) it may be
 * collected only on a voluntary basis, decoupled from any screening / hiring
 * decision, and NEVER visible to the people (or models) making those decisions
 * on an individual basis.
 *
 * The only way that firewall holds in practice is if NO scoring, interview, or
 * recruiter candidate-detail code path ever reads the demographics table. This
 * test enforces that mechanically: any reference to `candidateDemographicsTable`
 * or the raw `candidate_demographics` table name outside the small allow-list
 * below fails the build. Adding a new entry to the allow-list is therefore a
 * deliberate, reviewable act — exactly the friction we want around protected
 * data.
 *
 * ─── Allow-list rationale ─────────────────────────────────────────────────────
 *   routes/career-profile.ts — the candidate's OWN self-serve GET/PATCH/DELETE
 *                              of their disclosure (the candidate may see and
 *                              edit their own data; nobody else may).
 *   routes/analytics.ts      — aggregate-only, k-anonymised /analytics/diversity,
 *                              the auditor /analytics/aedt-export, and the
 *                              admin-only 4/5ths /analytics/adverse-impact. None
 *                              expose an individual recruiter-facing record.
 *   routes/admin-deletion.ts — GDPR right-to-erasure cascade (deletes the row).
 *   lib/fairness-firewall.test.ts — this guard names the tokens it forbids.
 *
 * Run via: pnpm --filter @workspace/api-server run test:fairness
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, ".."); // api-server/src

/* Files allowed to reference the demographics table. Paths are relative to
 * api-server/src and use forward slashes. Add an entry ONLY after a human
 * review confirms it does not expose individual demographics to a
 * decision-maker. */
const ALLOWED = new Set<string>([
  "routes/career-profile.ts",
  "routes/analytics.ts",
  "routes/admin-deletion.ts",
  "lib/fairness-firewall.test.ts",
]);

/* Tokens that indicate a code path touches the walled-off table. */
const TOKENS = [/candidateDemographicsTable/, /candidate_demographics/];

/* Files that MUST stay clean — explicitly enumerated so a reviewer can see the
 * exact decision/interview/recruiter surfaces the firewall protects. These are
 * a documented subset of "everything not in ALLOWED"; the broad sweep below is
 * the real guard. */
const SENSITIVE = [
  "routes/candidates.ts",
  "routes/interviews.ts",
  "routes/applications.ts",
  "routes/pipeline.ts",
  "routes/intelligence.ts",
  "lib/intelligence.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/* Strip block + line comments so a doc-comment mentioning the table name (e.g.
 * "does not join candidate_demographics") is not a false positive. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function referencesDemographics(file: string): boolean {
  const stripped = stripComments(readFileSync(file, "utf8"));
  return TOKENS.some((t) => t.test(stripped));
}

test("demographics table is referenced only inside the compliance firewall", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    if (ALLOWED.has(rel)) continue;
    if (referencesDemographics(file)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `candidate_demographics referenced outside the firewall allow-list: ${offenders.join(", ")}. ` +
      `If this is a legitimate, decoupled use, add it to ALLOWED in fairness-firewall.test.ts after review.`,
  );
});

test("scoring / interview / recruiter candidate-detail paths never read demographics", () => {
  for (const rel of SENSITIVE) {
    const full = join(SRC, rel);
    let exists = true;
    try { statSync(full); } catch { exists = false; }
    if (!exists) continue; // path renamed — the broad sweep above still guards it
    assert.equal(
      referencesDemographics(full),
      false,
      `${rel} must not read candidate_demographics — it is a hiring-decision surface.`,
    );
  }
});
