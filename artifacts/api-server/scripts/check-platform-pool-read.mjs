#!/usr/bin/env node
/**
 * check-platform-pool-read.mjs — CI guard: every read that INCLUDES shared
 * job-seeker rows (candidates.pool = "platform") must pass those rows through
 * the canonical privacy seal, OR carry a NAMED exemption, OR be a reviewed
 * ALLOWLIST entry. A raw platform-pool read that does none of these fails the
 * build, named explicitly.
 *
 * WHY THIS EXISTS
 * ---------------
 * A platform-pool candidate is a real person who self-registered on Lexy to
 * find a job. They can pause discovery, hide from their current employer, block
 * specific companies, ask to be shown only on genuine role matches, request
 * erasure (GDPR), or opt out of contact. The incident that motivated this guard
 * was an EMPLOYER-FACING read that returned platform rows without applying any
 * of those controls — a privacy leak. This is exactly the regression class the
 * guard prevents: a new (or moved) read of the shared pool that forgets the
 * seal can never merge silently again.
 *
 * THE CANONICAL SEAL  (single source of truth — routes/candidates.ts)
 * -------------------------------------------------------------------
 *   applyCandidateHardExclusions(rows)            // erased / DNC / pending_profile
 *   applyCandidatePrivacyFilter(rows, tenantId)   // paused / hide / block / match-only
 * An employer-facing platform read is satisfied when its enclosing function
 * calls one of these. No read path may re-implement these filters inline.
 *
 * WHAT COUNTS AS A "PLATFORM-POOL READ"  (the leak class)
 * ------------------------------------------------------
 * A drizzle predicate that INCLUDES platform rows in a result set:
 *     eq(<…>pool<…>, "platform")            // e.g. eq(candidatesTable.pool, "platform")
 *                                           //      eq((candidatesTable as any).pool, "platform")
 * or an inclusive raw-SQL equality:
 *     pool = 'platform'
 * EXCLUSIONS are safe and intentionally NOT matched:
 *     `pool IS DISTINCT FROM 'platform'`, `pool <> 'platform'`, `pool !== "platform"`
 * In-memory branch checks (`c.pool === "platform"`) are ALSO not matched — those
 * are the seal's own internals and post-read shaping, not a DB read to gate.
 *
 * WHAT SATISFIES THE GUARD  (any ONE, in the read's enclosing scope)
 * -----------------------------------------------------------------
 *   1. SEAL token   — applyCandidatePrivacyFilter | applyCandidateHardExclusions
 *   2. NAMED exempt — platformReadExemption(PLATFORM_READ_EXEMPTION.X)  (lib/platform-pool-read.ts)
 *   3. ALLOWLIST    — a reviewed entry below (VERIFIED-CONTROLLED or KNOWN GAP)
 *
 * NAMED EXEMPTIONS are for reads that are legitimately a DIFFERENT risk class
 * than "show these people to an employer":
 *   • SELF_DIRECTED_CANDIDATE_MESSAGING — a scheduler reading platform rows to
 *     email the candidate THEIR OWN mail (weekly digest, re-engagement). The
 *     candidate receiving their own account email is not employer exposure, so
 *     the employer-visibility seal is N/A; do-not-contact / erased suppression
 *     still applies and is done per-row in the messaging path. (Schedulers #8.)
 *   • AGGREGATE_ANALYTICS_COUNT — a query that counts platform rows into an
 *     aggregate metric and never returns per-candidate PII to an employer.
 * Each is a named constant in lib/platform-pool-read.ts (the marker throws on an
 * unknown reason, so an anonymous exemption cannot compile-and-run silently).
 *
 * SCOPE / LIMITATION
 * ------------------
 * The guard scans src/routes/*.ts AND src/lib/*.ts (routes reach every HTTP
 * surface incl. webhooks; lib reaches schedulers + engines, which are cron/loop
 * functions with no route registration). It detects the `eq(pool,"platform")` /
 * `pool = 'platform'` INCLUSIVE read forms. It does NOT catch a by-id single-row
 * SELECT that later branches on `candidate.pool === "platform"` in memory (there
 * is no pool predicate to key on) — those paths (the career-recording and
 * career-profile by-id reads) are covered by the seal helpers + code review, and
 * are enumerated in the Step-2 sweep. Precise claim: any INCLUSIVE platform-pool
 * DB read must carry a seal, a named exemption, or a reviewed allowlist entry.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIRS = [join(ROOT, "src", "routes"), join(ROOT, "src", "lib")];

/* ── Inclusive platform-pool read detectors ──────────────────────────────── */
/* Each matches a predicate that INCLUDES pool='platform' rows in a result set.
 * All are `;`-bounded (NOT newline-bounded) so a multi-LINE Drizzle predicate is
 * still caught. A post-match EXCLUSION_RE then drops the safe negations, so a
 * broad detector cannot misread `pool NOT IN (…)` / `notInArray` as inclusive. */
// eq(<pool>, "platform") — eq(candidatesTable.pool, "platform"),
//   eq((c as any).pool, "platform"), eq(candidatesTable.pool as any, "platform").
const EQ_READ_RE = /eq\([^;]*?\bpool\b[^;]*?,\s*["']platform["']\s*,?\s*\)/g;
// eq("platform", <pool>) — reversed argument order.
const EQ_REV_RE = /eq\(\s*["']platform["']\s*,[^;]*?\bpool\b[^;]*?\)/g;
// inArray(<pool>, [ … "platform" … ]) — inclusive set membership. \binArray
//   (word boundary) does NOT match notInArray, which EXCLUSION_RE also drops.
const INARRAY_READ_RE = /\binArray\([^;]*?\bpool\b[^;]*?\[[^\]]*?["']platform["']/g;
// raw-SQL inclusive equality `pool = 'platform'` (NOT `===`, NOT `IS DISTINCT FROM`).
const SQL_EQ_RE = /\bpool\b(?:\s+as\s+\w+)?\s*=\s*(?<!=)["']platform["']/g;
// raw-SQL inclusive membership `pool IN ( … 'platform' … )` (NOT `NOT IN`).
const SQL_IN_RE = /\bpool\b[^;]*?\bIN\b\s*\([^)]*?["']platform["']/gi;
const READ_RES = [EQ_READ_RE, EQ_REV_RE, INARRAY_READ_RE, SQL_EQ_RE, SQL_IN_RE];
// Safe negations a broad detector might otherwise sweep up — never a leak.
const EXCLUSION_RE = /IS DISTINCT FROM|\bNOT\s+IN\b|notInArray|!==|<>/i;

/* ── What satisfies the guard ─────────────────────────────────────────────── */
// The canonical seal is BOTH helpers together (hard exclusions AND the privacy
// filter). A read that applies only one is NOT sealed — it would still leak the
// other class (e.g. privacy-only would still expose erased/DNC rows). So the
// guard requires BOTH tokens in the enclosing scope, not merely one.
const SEAL_HARD_RE = /\bapplyCandidateHardExclusions\b/;
const SEAL_PRIVACY_RE = /\bapplyCandidatePrivacyFilter\b/;
const EXEMPT_RE = /\bplatformReadExemption\b/;

/* Reviewed baseline. Key = "<relfile> <scope>" where <scope> is either
 * "<METHOD> <path>" for a route handler or "fn:<name>" for a named function.
 *
 * TWO kinds of entry, distinguished by the `KNOWN GAP:` prefix:
 *   1. VERIFIED-CONTROLLED — the read is safe by a mechanism the span scanner
 *      cannot observe; human-reviewed.
 *   2. KNOWN GAP: — a genuine pre-existing gap this guard surfaced. Listed so
 *      the guard is green as a gate that blocks NEW raw reads, while these are
 *      tracked as debt, re-printed loudly every run, and must be fixed + removed
 *      (do NOT add new KNOWN GAP entries).
 */
const ALLOWLIST = new Map([
  // ── VERIFIED-CONTROLLED: employer-facing recommendation push over the whole
  //    platform pool. Both runPlatformRecommendation* entry points fetch the
  //    pool here and hand it to the SHARED evaluator evaluateJobAgainstCandidates(),
  //    which — before any talent_pool_submissions push or candidate match email —
  //    applies the FULL canonical seal per RECEIVING tenant (job.tenantId):
  //      applyCandidateHardExclusions()  → erased / DNC / pending_profile
  //      applyCandidatePrivacyFilter(job.tenantId) → paused / hide-from-employer
  //                                                   / block / match-only.
  //    The seal lives one function-hop away (in the shared evaluator, so the
  //    scan's single fetch is re-filtered per job), which this span scanner
  //    cannot observe — hence an allowlist entry rather than an inline match.
  //    Proven by candidate-privacy-seal-recommendation.test.ts (a hidden/blocked/
  //    DNC/erased/paused candidate is NEVER pushed to their own employer; a
  //    clean CONTROL candidate IS).
  ["src/lib/platform-recommendation-engine.ts fn:runPlatformRecommendationForJob", "VERIFIED-CONTROLLED: read feeds evaluateJobAgainstCandidates(), which applies applyCandidateHardExclusions + applyCandidatePrivacyFilter(job.tenantId) before any talent_pool_submissions push / candidate email; proven by candidate-privacy-seal-recommendation.test.ts"],
  ["src/lib/platform-recommendation-engine.ts fn:runPlatformRecommendationScan", "VERIFIED-CONTROLLED: same per-job seal in evaluateJobAgainstCandidates() (one shared platform fetch, privacy filter re-applied per receiving tenant) before any push / email; proven by candidate-privacy-seal-recommendation.test.ts"],
]);

const KNOWN_GAP_PREFIX = "KNOWN GAP:";

const REG_RE = /(?:router|app)\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
const DEF_RE =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[(<]|const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/* Body of a definition starting at `defIndex`: the first `{` whose preceding
 * non-whitespace char is `)` (end of params) or `>` (end of a return type), to
 * its brace-matched close. Skips `{` belonging to a return-type object literal. */
function bodyRange(src, defIndex) {
  let open = -1;
  for (let i = src.indexOf("{", defIndex); i !== -1; i = src.indexOf("{", i + 1)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] === ")" || src[j] === ">") {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return { start: open, end: src.length };
}

/* All scopes in a file: route handlers (keyed by METHOD + path) and named
 * functions (keyed by fn:name), each with a [start,end) range in the RAW source
 * so line numbers and containment are correct. */
function collectScopes(raw) {
  const scopes = [];
  let m;
  REG_RE.lastIndex = 0;
  const regs = [];
  while ((m = REG_RE.exec(raw)) !== null) {
    regs.push({ method: m[1].toUpperCase(), path: m[3], index: m.index });
  }
  for (let i = 0; i < regs.length; i++) {
    const start = regs[i].index;
    const end = i + 1 < regs.length ? regs[i + 1].index : raw.length;
    scopes.push({ key: `${regs[i].method} ${regs[i].path}`, start, end });
  }
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(raw)) !== null) {
    const name = m[1] || m[2];
    if (!name) continue;
    const range = bodyRange(raw, m.index);
    if (range) scopes.push({ key: `fn:${name}`, start: m.index, end: range.end });
  }
  return scopes;
}

/* Innermost scope containing `idx` (greatest start whose end is past idx). */
function enclosingScope(scopes, idx) {
  let best = null;
  for (const s of scopes) {
    if (s.start <= idx && idx < s.end) {
      if (!best || s.start > best.start) best = s;
    }
  }
  return best;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = SRC_DIRS.flatMap(walk);

const offenders = [];
let readsFound = 0;
let sealed = 0;
let exempt = 0;
let allowlisted = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const raw = readFileSync(file, "utf8");
  const clean = stripComments(raw);
  const scopes = collectScopes(clean);

  const seen = new Set();
  const matches = [];
  for (const re of READ_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (EXCLUSION_RE.test(m[0])) continue; // NOT IN / notInArray / DISTINCT FROM / !== / <>
      if (seen.has(m.index)) continue;       // same read caught by >1 detector
      seen.add(m.index);
      matches.push(m.index);
    }
  }
  if (matches.length === 0) continue;

  for (const idx of matches) {
    readsFound++;
    const scope = enclosingScope(scopes, idx);
    const spanText = scope ? clean.slice(scope.start, scope.end) : clean;
    const key = `${rel} ${scope ? scope.key : "<module>"}`;

    if (SEAL_HARD_RE.test(spanText) && SEAL_PRIVACY_RE.test(spanText)) {
      sealed++;
      continue;
    }
    if (EXEMPT_RE.test(spanText)) {
      exempt++;
      continue;
    }
    if (ALLOWLIST.has(key)) {
      allowlisted++;
      continue;
    }
    offenders.push({ key, file: rel, line: lineOf(raw, idx) });
  }
}

const summary = `[check-platform-pool-read] scanned ${files.length} src files, ${readsFound} platform-pool read(s) (${sealed} sealed, ${exempt} named-exempt, ${allowlisted} allowlisted)`;

/* Re-print KNOWN GAP baseline every run (incl. green) so the debt stays loud. */
const knownGaps = [...ALLOWLIST].filter(([, why]) => why.startsWith(KNOWN_GAP_PREFIX));
if (knownGaps.length > 0) {
  console.warn(
    `[check-platform-pool-read] ⚠ ${knownGaps.length} KNOWN GAP platform read(s) tracked in the baseline allowlist (fix + remove):`,
  );
  for (const [key, why] of knownGaps) {
    console.warn(`  ${key} — ${why.slice(KNOWN_GAP_PREFIX.length).trim()}`);
  }
}

if (offenders.length === 0) {
  console.log(`${summary} — ✓ every platform-pool read carries a seal, a named exemption, or a reviewed allowlist entry`);
  process.exit(0);
}

console.error(`${summary}`);
console.error(
  `[check-platform-pool-read] ✗ ${offenders.length} platform-pool read(s) with NO privacy seal and NO named exemption:`,
);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  (${o.key.slice(o.file.length + 1)})`);
}
console.error("");
console.error("Every read that INCLUDES pool='platform' rows must either:");
console.error("  1. pass the returned rows through the canonical seal in routes/candidates.ts");
console.error("     (applyCandidateHardExclusions + applyCandidatePrivacyFilter); or");
console.error("  2. declare a NAMED exemption in the same function:");
console.error("     platformReadExemption(PLATFORM_READ_EXEMPTION.X)  (see src/lib/platform-pool-read.ts); or");
console.error("  3. if controlled by a mechanism this scanner cannot see, add the scope to ALLOWLIST");
console.error("     in scripts/check-platform-pool-read.mjs with a justification (human review required).");
process.exit(1);
