#!/usr/bin/env node
/**
 * check-viewer-privacy-read.mjs — CI guard: every read that can EXPOSE
 * recruiter_view rows (candidate_action_events, eventType='recruiter_view')
 * must pass through the canonical viewer-privacy seal (lib/viewer-privacy.ts),
 * OR be a reviewed ALLOWLIST entry with a named reason. A raw sensitive read
 * that does neither fails the build, named explicitly.
 *
 * WHY THIS EXISTS
 * ---------------
 * recruiter_view rows are the "who viewed you" surface. The candidate's
 * CURRENT privacy settings (discovery paused, blocked company domains,
 * hide-from-current-employer) govern what they may be shown about being
 * seen — retroactively. The incident that motivated the seal was a reader
 * (market-event-emitter) that emailed candidates about views from tenants
 * they had blocked. This guard prevents the regression class: a NEW reader
 * of view events that forgets the seal can never merge silently again.
 *
 * THE CANONICAL SEAL  (single source of truth — lib/viewer-privacy.ts)
 * --------------------------------------------------------------------
 *   getViewerPrivacySeal(candidateId)   → { viewsPaused, viewNotHidden,
 *                                           isTenantExcluded, excludedViewerTenantIds }
 *   countSealedRecruiterViews(...)      → sealed COUNT helper
 * A sensitive read is satisfied when its enclosing scope resolves the seal
 * (getViewerPrivacySeal) AND applies it (countSealedRecruiterViews |
 * viewNotHidden | isTenantExcluded | viewsPaused). Resolving without applying
 * is NOT enough — that is exactly the half-done state that leaks.
 *
 * WHAT COUNTS AS A "SENSITIVE TOUCH"  (the leak class)
 * ----------------------------------------------------
 * Any statement over candidateActionEventsTable that can expose or forge
 * recruiter_view rows:
 *   1. A read explicitly targeting the type:
 *        eq(candidateActionEventsTable.eventType, "recruiter_view")
 *        event_type = 'recruiter_view'   (raw SQL)
 *   2. An UNFILTERED read — .from(candidateActionEventsTable) with NO
 *      eventType predicate in the statement. Such a result set INCLUDES
 *      recruiter_view rows, so it is sensitive by inclusion.
 *   3. A WRITE of a recruiter_view row: .insert(candidateActionEventsTable)
 *      whose values contain eventType: "recruiter_view", or an insert whose
 *      eventType is a VARIABLE (cannot be proven non-sensitive statically).
 *
 * INTENTIONALLY NOT MATCHED (never the exposure class)
 * ----------------------------------------------------
 *   • Reads typed to a DIFFERENT literal eventType (e.g.
 *     "mock_interview_completed", "role_open_at_target") — the candidate's
 *     own self-events; the DB predicate itself excludes recruiter_view rows.
 *   • Inserts with a non-recruiter_view LITERAL eventType — same reasoning.
 *   • .delete(candidateActionEventsTable) — deletion (DNC purge, GDPR
 *     erasure) removes data; it cannot expose a view to anyone.
 *   • In-memory comparisons (e.eventType === / !== "recruiter_view") — those
 *     are the seal's own application sites, not DB reads to gate.
 *   • lib/viewer-privacy.ts itself — the chokepoint.
 *
 * WHAT SATISFIES THE GUARD  (any ONE, in the touch's enclosing scope)
 * -------------------------------------------------------------------
 *   1. SEAL — getViewerPrivacySeal + an APPLICATION token (see above)
 *   2. ALLOWLIST — a reviewed entry below (VERIFIED-CONTROLLED or KNOWN GAP)
 *
 * REVIEWED BASELINE (2026-07-08) — every known toucher classified:
 *   • lib/weekly-digest-scheduler.ts — VERIFIED benign: recruiter_view counts
 *     go through getViewerPrivacySeal + countSealedRecruiterViews; its direct
 *     table reads are typed to the candidate's own self-events
 *     (mock_interview_completed / role_open_at_target) → not matched.
 *   • lib/achievement-engine.ts — VERIFIED benign: same pattern (sealed view
 *     counts; direct reads typed mock_interview_completed only).
 *   • routes/dnc.ts — deletion only (erasure cascade) → not matched.
 *   • lib/market-event-emitter.ts — routed through the seal since the
 *     original leak fix: viewsPaused/isTenantExcluded gate every view email,
 *     viewNotHidden seals the burst count. Its dedup read + canonical
 *     recruiter_view INSERT live in the same sealed scope → seal-satisfied,
 *     no allowlist entry needed. It is also the ONLY legitimate writer.
 *   • routes/career-profile.ts — engagement/progress reads sealed in scope;
 *     ONE allowlist entry for the GDPR self-export (below); log-action
 *     insert rejects reserved event types server-side.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIRS = [join(ROOT, "src", "routes"), join(ROOT, "src", "lib")];

/* The chokepoint itself — the only file allowed to touch view rows raw. */
const CHOKEPOINT_REL = join("src", "lib", "viewer-privacy.ts");

const TABLE = "candidateActionEventsTable";

/* ── Seal tokens ──────────────────────────────────────────────────────────── */
const SEAL_RESOLVE_RE = /\bgetViewerPrivacySeal\b/;
const SEAL_APPLY_RE = /\bcountSealedRecruiterViews\b|\bviewNotHidden\b|\bisTenantExcluded\b|\bviewsPaused\b/;

/* Reviewed baseline. Key = "<relfile> <scope>" where <scope> is either
 * "<METHOD> <path>" for a route handler or "fn:<name>" for a named function.
 * Two kinds of entry: VERIFIED-CONTROLLED (safe by a mechanism the span
 * scanner cannot observe; human-reviewed) and `KNOWN GAP:` (tracked debt —
 * re-printed loudly every run; fix + remove; do NOT add new ones). */
const ALLOWLIST = new Map([
  // GDPR/data-subject export: the CANDIDATE downloads their OWN raw rows
  // (keyed by their own candidateId resolved from the authenticated self).
  // The seal governs what the who-viewed-you DISPLAY surfaces show; a
  // data-subject access export is a different legal basis — the subject is
  // entitled to the raw records held about them, including view events from
  // since-blocked tenants. No employer or third party sees this payload.
  ["src/routes/career-profile.ts GET /portal/me/export", "VERIFIED-CONTROLLED: data-subject access export of the candidate's OWN rows (self-auth, self-keyed); display seal is N/A to a GDPR export payload; no third-party exposure"],
  // Candidate activity logger: eventType is caller-supplied (a variable, so
  // the scanner cannot prove it non-sensitive), but the handler REJECTS the
  // reserved system types ("recruiter_view", "role_open_at_target") with a
  // 400 before the insert — a candidate cannot forge view rows. If the
  // RESERVED_EVENT_TYPES check is ever removed, this entry must go with it.
  ["src/routes/career-profile.ts POST /portal/log-action", "VERIFIED-CONTROLLED: handler rejects RESERVED_EVENT_TYPES (recruiter_view, role_open_at_target) with 400 before insert; only benign self-event types reach the table"],
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

/* The `;`-bounded statement containing index `idx` — a multi-line Drizzle
 * chain is one statement, so a predicate anywhere in the chain is visible. */
function statementAt(src, idx) {
  let start = src.lastIndexOf(";", idx);
  start = start === -1 ? 0 : start + 1;
  let end = src.indexOf(";", idx);
  end = end === -1 ? src.length : end;
  return src.slice(start, end);
}

/* ── Sensitivity classification of a single statement ─────────────────────── */
// eq(<…>eventType<…>, "<literal>") — drizzle typed predicate (either arg order).
const EQ_TYPE_RE = /eq\((?:[^()]|\([^()]*\))*?\beventType\b(?:[^()]|\([^()]*\))*?,\s*["']([^"']+)["']\s*\)/g;
const EQ_TYPE_REV_RE = /eq\(\s*["']([^"']+)["']\s*,(?:[^()]|\([^()]*\))*?\beventType\b/g;
// raw-SQL equality: event_type = 'x' / eventType = 'x' (NOT ===, which is in-memory).
const SQL_TYPE_RE = /\bevent_?[tT]ype\b\s*=\s*(?!=)\s*["']([^"']+)["']/g;
// insert values: eventType: "literal"  |  eventType: <variable>  | shorthand `eventType,`
const INSERT_LITERAL_RE = /\beventType\s*:\s*["']([^"']+)["']/;
const INSERT_ANY_RE = /\beventType\s*[:,}]/;

function classifyStatement(stmt) {
  const isInsert = new RegExp(`\\.insert\\(\\s*${TABLE}`).test(stmt);
  const isDelete = new RegExp(`\\.delete\\(\\s*${TABLE}`).test(stmt);
  const isRead = new RegExp(`\\.from\\(\\s*${TABLE}`).test(stmt);

  if (isDelete && !isRead) return { kind: "delete", sensitive: false };

  if (isInsert) {
    const lit = stmt.match(INSERT_LITERAL_RE);
    if (lit) {
      return lit[1] === "recruiter_view"
        ? { kind: "insert", sensitive: true, why: `writes recruiter_view rows` }
        : { kind: "insert", sensitive: false };
    }
    // Variable / shorthand eventType — cannot prove non-sensitive statically.
    if (INSERT_ANY_RE.test(stmt)) {
      return { kind: "insert", sensitive: true, why: "insert with non-literal eventType (could write recruiter_view)" };
    }
    return { kind: "insert", sensitive: true, why: "insert with no visible eventType" };
  }

  if (isRead) {
    const types = [];
    for (const re of [EQ_TYPE_RE, EQ_TYPE_REV_RE, SQL_TYPE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(stmt)) !== null) types.push(m[1]);
    }
    if (types.length === 0) {
      return { kind: "read", sensitive: true, why: "unfiltered read (no eventType predicate — result includes recruiter_view rows)" };
    }
    if (types.includes("recruiter_view")) {
      return { kind: "read", sensitive: true, why: "reads recruiter_view rows" };
    }
    return { kind: "read", sensitive: false }; // typed to a self-event
  }

  return { kind: "other", sensitive: false }; // e.g. column refs in a join off another table's statement
}

/* ── Scan ─────────────────────────────────────────────────────────────────── */
const files = SRC_DIRS.flatMap(walk);

const offenders = [];
let touches = 0;
let sensitive = 0;
let sealedCount = 0;
let allowlisted = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  if (rel === CHOKEPOINT_REL) continue; // the chokepoint itself

  const raw = readFileSync(file, "utf8");
  if (!raw.includes(TABLE) && !/recruiter_view/.test(raw)) continue;

  const clean = stripComments(raw);
  const scopes = collectScopes(clean);

  /* Anchor on every statement that touches the table via .from/.insert/.delete
   * — one classification per statement (dedupe by statement start). */
  const anchorRe = new RegExp(`\\.(?:from|insert|delete)\\(\\s*${TABLE}`, "g");
  const seenStmt = new Set();
  let m;
  while ((m = anchorRe.exec(clean)) !== null) {
    const stmtStart = clean.lastIndexOf(";", m.index) + 1;
    if (seenStmt.has(stmtStart)) continue;
    seenStmt.add(stmtStart);
    touches++;

    const stmt = statementAt(clean, m.index);
    const cls = classifyStatement(stmt);
    if (!cls.sensitive) continue;
    sensitive++;

    const scope = enclosingScope(scopes, m.index);
    const spanText = scope ? clean.slice(scope.start, scope.end) : clean;
    const key = `${rel} ${scope ? scope.key : "<module>"}`;

    if (SEAL_RESOLVE_RE.test(spanText) && SEAL_APPLY_RE.test(spanText)) {
      sealedCount++;
      continue;
    }
    if (ALLOWLIST.has(key)) {
      allowlisted++;
      continue;
    }
    offenders.push({ key, file: rel, line: lineOf(raw, m.index), why: cls.why });
  }
}

const summary = `[check-viewer-privacy-read] scanned ${files.length} src files, ${touches} view-events touch(es), ${sensitive} sensitive (${sealedCount} sealed, ${allowlisted} allowlisted)`;

const knownGaps = [...ALLOWLIST].filter(([, why]) => why.startsWith(KNOWN_GAP_PREFIX));
if (knownGaps.length > 0) {
  console.warn(
    `[check-viewer-privacy-read] ⚠ ${knownGaps.length} KNOWN GAP view read(s) tracked in the baseline allowlist (fix + remove):`,
  );
  for (const [key, why] of knownGaps) {
    console.warn(`  ${key} — ${why.slice(KNOWN_GAP_PREFIX.length).trim()}`);
  }
}

if (offenders.length === 0) {
  console.log(`${summary} — ✓ every sensitive view-events touch is sealed or reviewed`);
  process.exit(0);
}

console.error(summary);
console.error(
  `[check-viewer-privacy-read] ✗ ${offenders.length} sensitive view-events touch(es) with NO viewer-privacy seal:`,
);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  (${o.key.slice(o.file.length + 1)}) — ${o.why}`);
}
console.error("");
console.error("Every read that can expose recruiter_view rows must either:");
console.error("  1. resolve AND apply the canonical seal in the same scope:");
console.error("     getViewerPrivacySeal(candidateId) + countSealedRecruiterViews /");
console.error("     viewNotHidden / isTenantExcluded / viewsPaused  (lib/viewer-privacy.ts); or");
console.error("  2. if controlled by a mechanism this scanner cannot see, add the scope to ALLOWLIST");
console.error("     in scripts/check-viewer-privacy-read.mjs with a justification (human review required).");
console.error("Writes of recruiter_view rows belong ONLY in lib/market-event-emitter.ts (recordRecruiterView).");
process.exit(1);
