#!/usr/bin/env node
/**
 * scripts/check-platform-pool-write.mjs — CI guard for the platform-pool
 * WRITE chokepoint (companion to check-platform-pool-read.mjs).
 *
 * Ruling (July 2026): entry into the shared platform pool
 * (candidates.pool = 'platform') requires an explicit, logged candidate
 * opt-in. The ONLY code allowed to write that value is the chokepoint
 * `src/lib/discovery-consent.ts` (grantDiscoveryOptIn). History: the old
 * `ensureCandidateUser` helper silently promoted every portal-invited or
 * applying candidate to the platform pool — this guard exists so that
 * class of conflation cannot silently return.
 *
 * ─── What is flagged ─────────────────────────────────────────────────────────
 * Any line assigning the literal "platform" to a `pool` key
 * (`pool: "platform"`, `"pool": 'platform'`, `pool = "platform"`) outside
 * the chokepoint / allowlist. This catches both `.set({...})` updates and
 * `.values({...})` inserts — an INSERT born into the platform pool is just
 * as much a consent bypass as an UPDATE.
 *
 * ─── What is NOT flagged ─────────────────────────────────────────────────────
 *  • Reads/comparisons: `pool === "platform"`, `eq(candidatesTable.pool,
 *    "platform")`, `pool !== "platform"` (the read guard owns those).
 *  • Type unions: `pool: "platform" | "tenant"`.
 *  • Test files (they seed fixtures deliberately).
 *  • Lines carrying `// platform-pool-write-exempt:` within the lookback
 *    window — each is a reviewed waiver with justification.
 *
 * ─── KNOWN GAP allowlist ─────────────────────────────────────────────────────
 *  (empty) — the former candidate-import.ts gap was closed by ruling
 *  (July 2026): bulk-import now REQUIRES a tenantId and always writes
 *  pool='tenant'. No path outside the chokepoint writes 'platform'.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SEARCH_DIRS = [join(ROOT, "src")];

const ALLOWED_FILES = new Set([
  "src/lib/discovery-consent.ts",            // the chokepoint itself
]);

/* KNOWN GAP: pre-existing surfaces awaiting a separate ruling. Adding a file
 * here requires user sign-off; each entry must carry a reason. */
const KNOWN_GAP = new Map([]);

const EXEMPT_MARKER = "platform-pool-write-exempt";
const EXEMPT_LOOKBACK = 6;

/* pool key assigned the literal platform: `pool: "platform"` / `'pool': "platform"`
 * / `pool = "platform"`. A `|` after the literal (type union) is excluded below. */
const WRITE_RE = /(?:\bpool\b|\b\w*[pP]ool\b|["']pool["'])\s*[:=]\s*["']platform["']/;
/* Type-union / comparison shapes to spare. */
const UNION_RE = /["']platform["']\s*\|/;
const COMPARE_RE = /[=!]==?\s*["']platform["']|["']platform["']\s*[=!]==?/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) yield p;
  }
}

const violations = [];
const gapsSeen = [];

for (const dir of SEARCH_DIRS) {
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file);
    if (/\.test\.(ts|tsx|mts)$/.test(rel)) continue;
    if (ALLOWED_FILES.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    let inBlock = false;
    lines.forEach((rawLine, i) => {
      /* Strip comments: track /* … *​/ block state and drop `//` tails.
       * (The exempt-marker scan below still sees raw lines.) */
      const wasInBlock = inBlock;
      if (inBlock) { if (rawLine.includes("*/")) inBlock = false; }
      else if (rawLine.includes("/*") && !rawLine.slice(rawLine.indexOf("/*")).includes("*/")) inBlock = true;
      if (wasInBlock) return;
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return;
      const line = rawLine.split("//")[0];
      if (!WRITE_RE.test(line)) return;
      if (UNION_RE.test(line) || COMPARE_RE.test(line)) return;
      /* eq(...) / comparisons where pool is a column ref, e.g.
       * eq(candidatesTable.pool, "platform") — the key form `pool:` isn't
       * present there, so WRITE_RE already skips them; this is belt+braces
       * for `pool = "platform"` inside a raw SQL WHERE string. */
      if (/\bwhere\b|\bWHERE\b/.test(line) && /=\s*'platform'/.test(line)) return;
      for (let k = Math.max(0, i - EXEMPT_LOOKBACK); k <= i; k++) {
        if (lines[k].includes(EXEMPT_MARKER)) return;
      }
      if (KNOWN_GAP.has(rel)) { gapsSeen.push(`${rel}:${i + 1}`); return; }
      violations.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
}

if (gapsSeen.length) {
  console.log(`[check-platform-pool-write] KNOWN GAP (documented, pending ruling):`);
  for (const g of gapsSeen) console.log(`  - ${g}  (${KNOWN_GAP.get(g.split(":")[0])})`);
}

if (violations.length) {
  console.error(`\n[check-platform-pool-write] FAIL — pool='platform' written outside the opt-in chokepoint:`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(`\nOnly src/lib/discovery-consent.ts (grantDiscoveryOptIn) may promote a candidate`);
  console.error(`to the platform pool. Route the write through the chokepoint, or — for a reviewed`);
  console.error(`non-promotion write — add a '// ${EXEMPT_MARKER}: <reason>' marker.`);
  process.exit(1);
}
console.log(`[check-platform-pool-write] OK — no unauthorized platform-pool writes.`);
