/**
 * score-band-guard.test.ts — Anti-drift source scan (class-killer guard).
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────
 * The whole app was migrated so that score/quality colour bands never hard-code a
 * numeric cutoff inline. Match/fit surfaces go through @/lib/score-band; every
 * other quantity (interview score, readiness, risk, integrity, hire-rate, signal
 * decay, pipeline health, hire-probability) bands via a NAMED CONSTANT with a
 * one-line comment saying what it bands and why it differs.
 *
 * This test scans the lexy source tree and fails if a NEW anonymous inline band
 * cutoff appears in either of the two forms a colour/label band is written:
 *   1. the ternary form  — `x >= 70 ? ...`               (INLINE_CUTOFF)
 *   2. the flag form     — `const bad = pct < 50`         (ASSIGN_CUTOFF)
 *      i.e. a bare identifier compared to a literal, assigned to a boolean that
 *      then drives a colour ternary a few lines down (this split-across-lines
 *      idiom slipped past a ternary-only scan once — hence form 2).
 * Named-constant comparisons (`x >= FOO ?`, `const bad = pct < WEAK`) have no
 * digit after the operator and are invisible to the scan, which is the point:
 * the only way to satisfy the guard is to name the threshold (or, for a genuine
 * non-band numeric like a text-wrap / time / word-count, add it to ALLOWLIST
 * below with a reason).
 *
 * Note: the guard deliberately does NOT flag `if (x < 30)` statement-form
 * comparisons — the codebase is saturated with legitimate non-band ones (time /
 * date formatting, file sizes, HTTP status codes) so a generic if-form scan
 * would be pure noise. Multi-tier band logic in if-form must still be named by
 * convention; only the two high-signal literal-colour idioms are enforced here.
 *
 * If this test fails on a line you just added: either replace the literal with a
 * named const (preferred) or, if it is truly not a colour/score band, add a
 * precise marker to ALLOWLIST with a comment explaining why.
 *
 * Run via:
 *   pnpm --filter @workspace/lexy run test:score-band
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dirname, "..");

/* Anonymous inline band cutoff: an operator immediately followed by a 2–3 digit
 * literal and then a `?` (the ternary that picks a colour/label). Named-const
 * comparisons never match because there is no digit after the operator. */
const INLINE_CUTOFF = /(>=|<=|>|<)\s*\d{2,3}\s*\?/;

/* Boolean-flag band idiom: a bare identifier compared to a 2–3 digit literal and
 * assigned (`const bad = pct < 50`). The result then drives a colour ternary a
 * few lines down, so a ternary-only scan misses it. `= FOO` (a named const) has
 * no digit and is invisible; plain `= 80` and `=>` / `===` don't match because
 * an identifier, not a digit, must follow the `=`. */
const ASSIGN_CUTOFF = /=\s*[A-Za-z_]\w*\s*(>=|<=|>|<)\s*\d{2,3}\b/;

/* Files that legitimately compare against a numeric literal for a NON-band
 * reason (not a colour/score band). Each entry is a substring that must be
 * present on the flagged line, plus why it is exempt. */
const ALLOWLIST: { marker: string; why: string }[] = [
  { marker: "lastSpace > 40", why: "PDF text-wrap break point, not a score band" },
  { marker: ".length > 12", why: "goal-word-count truncation, not a score band" },
  { marker: ".length > 240", why: "job-description preview truncation, not a score band" },
  { marker: "elapsed < 60", why: "seconds→m:ss time format, not a score band" },
];

const SKIP_FILES = new Set(["score-band.ts", "intelligence-bands.ts"]);

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !SKIP_FILES.has(name)) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("no anonymous inline band cutoffs remain in lexy source", () => {
  const violations: string[] = [];
  for (const file of collect(SRC_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!INLINE_CUTOFF.test(line) && !ASSIGN_CUTOFF.test(line)) return;
      if (isCommentLine(line)) return;
      if (ALLOWLIST.some((a) => line.includes(a.marker))) return;
      violations.push(`${file.replace(SRC_DIR, "src")}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} anonymous inline band cutoff(s). Use a named const (or ALLOWLIST if truly non-band):\n` +
      violations.join("\n"),
  );
});
