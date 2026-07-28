#!/usr/bin/env node
/**
 * check-classb-read.mjs — CI guard for reads of CLASS-B tables (candidate data
 * with NO database-level tenant isolation).
 *
 * ── WHAT "CLASS B" MEANS ─────────────────────────────────────────────────────
 * A dev-DB audit (2026-07) found that of all candidate-data tables, only four
 * carry a live Postgres RLS policy. Every other candidate table falls into one
 * of two classes, distinguished by the `relforcerowsecurity` catalog flag:
 *   • CLASS A (enabled=f, forced=t): RLS was authored in a migration but the
 *     dev fingerprint stripped it. PROD RE-APPLIES it, so prod has a DB backstop.
 *   • CLASS B (enabled=f, forced=f): the table was NEVER in any RLS migration.
 *     There is NO DB-level tenant isolation in dev OR prod. Application code is
 *     the SOLE thing standing between one tenant and another tenant's rows.
 * Both waves of the 2026-07 employer-facing leak audit were CLASS-B fan-out
 * reads (candidate_job_intelligence by-candidate; a sourced/intel join). This
 * guard exists so a NEW unscoped Class-B read cannot merge silently again.
 *
 * ── TWO TIERS OF CONTROL (honest about strength) ─────────────────────────────
 * HIGH_RISK tables — candidate_job_intelligence + hiring_manager_shares — are
 * the two CONFIRMED prod-impacting leaks. They get the STRONG control: a raw
 * read is allowed ONLY inside the canonical scoped-accessor module
 * (src/lib/class-b-access.ts), OR with a named `classBRead(...)` exemption, OR a
 * reviewed ALLOWLIST entry. A bare tenant predicate does NOT auto-pass them —
 * the read must physically go through code that GUARANTEES the scope, or be an
 * explicitly reasoned exemption. This is choke-point soundness for those two.
 *
 * All other Class-B tables get the TRIPWIRE: each read's QUERY SPAN (the drizzle
 * builder chain, NOT the whole function) must contain a tenant-column predicate
 * (.tenantId / .viewerTenantId / .clientTenantId), OR a named exemption, OR an
 * allowlist entry. Query-span scoping is the load-bearing refinement: a function
 * that authorizes a candidate row via `canAccessTenant(candidate.tenantId)` and
 * THEN does an unscoped `from(intel).where(eq(intel.candidateId, id))` — exactly
 * the shape of the by-candidate leak — is FLAGGED, because the tenant token lives
 * outside the read's own builder chain. A whole-function scan would have passed
 * that buggy code; the query span does not.
 *
 * ── FALSE POSITIVES (safe reads this WILL flag → need a named exemption) ──────
 *   • A by-id single-row read authorized upstream by a token/session, not by a
 *     tenant column (e.g. hiring_manager_shares fetched by share token).
 *   • A read scoped by an in-memory `.filter(r => allowed.has(r.tenantId))` AFTER
 *     the await — the DB span carries no predicate.
 *   • An aggregate/count read that returns no per-candidate PII.
 *   • A candidate-SELF-owned read scoped by candidates.userId (portal), not tenant.
 *   • A dynamic builder that appends `.where(...tenantId...)` conditionally in a
 *     later statement (span ends at the first `;`).
 * These are legitimate; each is resolved by a `classBRead(CLASS_B_READ_EXEMPTION.X)`
 * marker whose named reason states WHY the read is safe without a tenant predicate.
 *
 * ── FALSE NEGATIVES (unsafe reads this WILL MISS — the holes) ─────────────────
 * These two are the holes a FUTURE leak could be driven through. They are
 * recorded here (and in docs/SECURITY_REVIEW_2026-07.md §5) so the next reader
 * knows the tripwire's exact limit rather than trusting it blindly:
 *   (FN-1) A tenant column present in the span for a NON-FILTERING reason — e.g.
 *          `.select({ t: intel.tenantId })` or `.orderBy(intel.tenantId)` with NO
 *          `where` that filters by it. The span contains `.tenantId`, so the read
 *          PASSES though it is unscoped. The guard checks presence of a tenant
 *          column in the chain, NOT that it sits inside a WHERE that filters rows.
 *   (FN-2) A raw `sql\`...\`` / `db.execute(sql\`...\`)` read that names the table
 *          in a string literal instead of the drizzle symbol. The detector keys
 *          on the imported table SYMBOL; a string-literal table name is invisible
 *          to it and bypasses the registry entirely.
 * The ONLY sound mechanism against both is the choke-point accessor (the HIGH_RISK
 * tier). Extending accessors to the full Class-B registry is tracked follow-up
 * debt; until then, these two FNs are the tripwire's stated ceiling.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────
 * Scans src/routes/*.ts + src/lib/*.ts (every HTTP surface + schedulers/engines).
 * READS only: from()/leftJoin()/innerJoin()/rightJoin() of a Class-B symbol.
 * INSERT/UPDATE/DELETE are out of scope (this audit is employer-facing reads).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIRS = [join(ROOT, "src", "routes"), join(ROOT, "src", "lib")];

/* ── The Class-B registry — candidate-data tables with NO DB-level isolation ──
 * Source of truth for "which tables rely entirely on app-code sealing". If you
 * add a candidate-data table that is not in an RLS migration, add it here. */
const HIGH_RISK = new Set([
  "candidateJobIntelligenceTable",
  "hiringManagerSharesTable",
]);

const TRIPWIRE = new Set([
  "interviewSummariesTable",
  "candidateCareerProfilesTable",
  "candidateDemographicsTable",
  "candidateAiConsentTable",
  "candidateEmbeddingsTable",
  "candidateSkillScoresTable",
  "candidateAchievementsTable",
  "candidateActivityStreaksTable",
  "candidateProgressSnapshotsTable",
  "candidateRecommendationProgressTable",
  "candidateMarketEventsSentTable",
  "candidateConnectionEventsTable",
  "candidateConnectionInsightsTable",
  "candidateEventsTable",
  "candidateExternalClicksTable",
  "candidateOutcomesTable",
  "candidateDisclosureAcksTable",
  "outreachRepliesTable",
  "outreachConversationDraftsTable",
  "outreachStepMessagesTable",
  "outreachAutopilotRunsTable",
  "outreachSequenceStepsTable",
  "connectionEventsTable",
  "connectionScoresTable",
  "decisionEventsTable",
  "aiDecisionLogTable",
  "sttTranscribeEventsTable",
  "appealsRequestsTable",
  "aiMessageGenerationsTable",
]);

const ALL_SYMBOLS = [...HIGH_RISK, ...TRIPWIRE];

/* Canonical scoped-accessor module: the ONLY place a HIGH_RISK raw read may live
 * without a named exemption. Reads here are guaranteed-scoped by construction. */
const ACCESSOR_FILES = new Set(["src/lib/class-b-access.ts"]);

/* Canonical scope helpers from src/lib/class-b-access.ts. For the two HIGH_RISK
 * tables a bare `.tenantId` column in the span is NOT accepted (that would be the
 * FN-1 select/orderBy hole on the highest-value data) — the query span MUST call
 * one of these helpers, which RETURN a tenant-filtering SQL predicate. This is a
 * distinct, greppable token that a select/orderBy projection cannot accidentally
 * satisfy, giving these two tables a stronger guarantee than the tripwire tier. */
const HIGH_RISK_SCOPE_HELPER_RE = /\b(intelTenantScope|hmShareScope|cjiTenantScope)\s*\(/;

/* A read reference: from()/<x>Join() of a Class-B symbol (word-boundary). */
function readRe(symbol) {
  return new RegExp(`\\.(?:from|leftJoin|innerJoin|rightJoin|fullJoin)\\(\\s*${symbol}\\b`, "g");
}

/* Tenant-column predicate anywhere in the QUERY SPAN. Any table's tenant column
 * counts — a join that scopes via the parent's tenant column is correct. NOTE
 * (FN-1): this matches a tenant column used for select/orderBy too, not only a
 * filtering where(); that residual hole is documented in the header. */
const TENANT_PRED_RE = /\.(tenantId|viewerTenantId|clientTenantId)\b/;
const EXEMPT_RE = /\bclassBRead\b/;

const KNOWN_GAP_PREFIX = "KNOWN GAP:";

/* Reviewed baseline (external JSON so the ~130-entry pre-existing list does not
 * bloat this script). Key = "<relfile> <scope> [<symbol>]"; value = reason.
 *   • VERIFIED-CONTROLLED: … — safe by a mechanism the scanner cannot observe
 *     (each individually classified — NEVER a bulk "these are all fine").
 *   • KNOWN GAP: … — a genuine pre-existing unscoped read this guard surfaced,
 *     tracked as honest debt (re-printed loudly every run, fix + remove).
 * Do NOT hand-add entries: a NEW unscoped read must be fixed or exempted in
 * code, never appended to the baseline. Regenerate intentionally with
 * `node scripts/check-classb-read.mjs --emit-baseline` only when consciously
 * accepting the current set as reviewed debt. */
const BASELINE_PATH = join(__dirname, "classb-read-baseline.json");
const EMIT_BASELINE = process.argv.includes("--emit-baseline");

function loadBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    return new Map(Object.entries(parsed.reads ?? {}));
  } catch {
    return new Map();
  }
}
const ALLOWLIST = loadBaseline();

const REG_RE = /(?:[A-Za-z0-9_$]*[Rr]outer|app)\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
const DEF_RE =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[(<]|const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g;

/* Length-preserving comment strip: replaces comment characters with spaces
 * (newlines kept) so every index into `clean` still maps to the same offset —
 * and therefore the same line — in the raw source. Getting this wrong shifts
 * every reported line number and silently corrupts the query-span extraction. */
function stripComments(src) {
  const blanked = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanked)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_full, pre, cmt) => pre + blanked(cmt));
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

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

function enclosingScope(scopes, idx) {
  let best = null;
  for (const s of scopes) {
    if (s.start <= idx && idx < s.end) {
      if (!best || s.start > best.start) best = s;
    }
  }
  return best;
}

/* QUERY SPAN of a read at `idx`: from the statement start (the greatest of the
 * last `;`, `{`, `}` before idx) to the next `;`. This is the drizzle builder
 * chain — where()/join() come after from(), so the whole predicate is captured,
 * while an unrelated tenant token elsewhere in the function is NOT. */
function querySpan(clean, idx) {
  let start = 0;
  for (const ch of [";", "{", "}"]) {
    const p = clean.lastIndexOf(ch, idx);
    if (p > start) start = p;
  }
  start = start + 1;
  let end = clean.indexOf(";", idx);
  if (end === -1) end = clean.length;
  return clean.slice(start, end);
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
let accessor = 0;
let scoped = 0;
let exempt = 0;
let allowlisted = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const raw = readFileSync(file, "utf8");
  const clean = stripComments(raw);
  const scopes = collectScopes(clean);
  const isAccessorFile = ACCESSOR_FILES.has(rel);

  for (const symbol of ALL_SYMBOLS) {
    const re = readRe(symbol);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      readsFound++;
      const idx = m.index;
      const scope = enclosingScope(scopes, idx);
      const scopeKey = scope ? scope.key : "<module>";
      const span = querySpan(clean, idx);
      /* A named exemption is a deliberate statement in the ENCLOSING scope, not
       * the read chain — `classBRead(REASON)` sits on its own line beside the
       * read, so we test the scope body, not just the builder span. */
      const scopeBody = scope ? clean.slice(scope.start, scope.end) : span;
      const key = `${rel} ${scopeKey} [${symbol}]`;
      const line = lineOf(raw, idx);

      if (HIGH_RISK.has(symbol)) {
        if (isAccessorFile) {
          accessor++;
          continue;
        }
        /* STRONG control: a bare .tenantId does NOT pass — only the canonical
         * scope helper in the span, or a reasoned exemption in the scope. */
        if (HIGH_RISK_SCOPE_HELPER_RE.test(span)) {
          scoped++;
          continue;
        }
        if (EXEMPT_RE.test(scopeBody)) {
          exempt++;
          continue;
        }
        if (ALLOWLIST.has(key)) {
          allowlisted++;
          continue;
        }
        offenders.push({ file: rel, line, key, symbol, tier: "HIGH_RISK" });
        continue;
      }

      // TRIPWIRE tier
      if (TENANT_PRED_RE.test(span)) {
        scoped++;
        continue;
      }
      if (EXEMPT_RE.test(scopeBody)) {
        exempt++;
        continue;
      }
      if (ALLOWLIST.has(key)) {
        allowlisted++;
        continue;
      }
      offenders.push({ file: rel, line, key, symbol, tier: "TRIPWIRE" });
    }
  }
}

/* --emit-baseline: freeze the CURRENT offender set as reviewed debt. Every entry
 * defaults to "KNOWN GAP: needs-scoping-review" — an HONEST default that blesses
 * NOTHING as safe; it merely records "this read predates the guard and its
 * upstream authorization has not been individually verified". Reasons are then
 * hand-promoted to "VERIFIED-CONTROLLED: …" one read at a time as each is
 * actually reviewed. This is deliberately the opposite of a bulk pass. */
if (EMIT_BASELINE) {
  const existing = ALLOWLIST;
  const reads = {};
  for (const o of offenders.sort((a, b) => a.key.localeCompare(b.key))) {
    reads[o.key] = existing.get(o.key) ?? `${KNOWN_GAP_PREFIX} needs-scoping-review (${o.tier})`;
  }
  const payload = {
    _comment:
      "Reviewed baseline for check-classb-read.mjs. VERIFIED-CONTROLLED: = individually reviewed safe; KNOWN GAP: = unverified pre-existing debt. Regenerate only with --emit-baseline. Never hand-add a NEW read.",
    generatedAt: new Date().toISOString().slice(0, 10),
    reads,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n");
  const gaps = Object.values(reads).filter((r) => r.startsWith(KNOWN_GAP_PREFIX)).length;
  console.log(
    `[check-classb-read] wrote baseline: ${Object.keys(reads).length} entries (${gaps} KNOWN GAP, ${Object.keys(reads).length - gaps} VERIFIED-CONTROLLED) → ${relative(ROOT, BASELINE_PATH)}`,
  );
  process.exit(0);
}

const summary = `[check-classb-read] scanned ${files.length} src files, ${readsFound} Class-B read(s) (${accessor} via accessor, ${scoped} query-span-scoped, ${exempt} named-exempt, ${allowlisted} allowlisted)`;

const knownGaps = [...ALLOWLIST].filter(([, why]) => why.startsWith(KNOWN_GAP_PREFIX));
if (knownGaps.length > 0) {
  console.warn(
    `[check-classb-read] ⚠ ${knownGaps.length} KNOWN GAP Class-B read(s) tracked in the baseline allowlist (fix + remove):`,
  );
  for (const [key, why] of knownGaps) {
    console.warn(`  ${key} — ${why.slice(KNOWN_GAP_PREFIX.length).trim()}`);
  }
}

if (offenders.length === 0) {
  console.log(`${summary} — ✓ every Class-B read is accessor-routed, query-span-scoped, named-exempt, or reviewed`);
  process.exit(0);
}

console.error(`${summary}`);
console.error(
  `[check-classb-read] ✗ ${offenders.length} Class-B read(s) with NO tenant scope and NO named exemption:`,
);
for (const o of offenders) {
  console.error(`  [${o.tier}] ${o.file}:${o.line}  (${o.key})`);
}
console.error("");
console.error("Every Class-B read must either:");
console.error("  1. (HIGH_RISK tables) live in the canonical accessor src/lib/class-b-access.ts; or");
console.error("  2. carry a tenant predicate (.tenantId/.viewerTenantId/.clientTenantId) in its query span; or");
console.error("  3. declare a NAMED exemption: classBRead(CLASS_B_READ_EXEMPTION.X)  (src/lib/class-b-read.ts); or");
console.error("  4. if safe by a mechanism this scanner cannot see, add the scope to ALLOWLIST");
console.error("     in scripts/check-classb-read.mjs with a justification (human review required).");
process.exit(1);
