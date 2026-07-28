#!/usr/bin/env node
/**
 * scripts/check-stage-choke-point.mjs — CI guard for the pipeline-stage choke-point (ticket 4d)
 *
 * Every candidate pipeline-stage TRANSITION must route through the single
 * transactional choke-point `lib/change-candidate-stage.ts`, which writes the
 * stage column(s) + a candidate_events(STAGE_CHANGED) row + a thin-pointer
 * audit_logs row ATOMICALLY. This script fails the build on any raw write to
 * `applications.stage` or sourced `rawData.stage` outside that file.
 *
 * ─── What is flagged ─────────────────────────────────────────────────────────
 * A stage assignment (`stage: "…"` / `stage: someVar` / `stage: map[x]`) whose
 * nearest enclosing Drizzle call is `.set(` / `.update(` — i.e. an UPDATE to an
 * existing row. That is a transition and must go through the choke-point.
 *
 * ─── What is NOT flagged ─────────────────────────────────────────────────────
 *  • Creations: a `stage:` inside a `.values(` / `.insert(` (Group 4 — an initial
 *    stage on a brand-new row is not a transition; those keep CANDIDATE_CREATED /
 *    JOB_MATCHED creation events).
 *  • Reads: `stage: someTable.stage` select projections (value has a dotted path).
 *  • Optional type props: `stage?: …`.
 *  • The choke-point itself + this script + tests.
 *  • Any line carrying an explicit `// stage-write-exempt:` justification within
 *    the ~18 lines above it (each such marker is a reviewed, documented waiver —
 *    e.g. a sourced row with no canonical candidateId to key the event/audit
 *    rows, or a write inside a GDPR-erasure transaction that cannot nest the
 *    choke-point's own transaction without deadlocking).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SEARCH_DIRS = [join(ROOT, "src")];

/** Only the choke-point may write a stage column freely. */
const ALLOWED_FILES = new Set([
  "src/lib/change-candidate-stage.ts",
  "scripts/check-stage-choke-point.mjs",
]);

/** How far above a flagged line an exempt marker may sit. */
const EXEMPT_LOOKBACK = 18;
/** How far up we scan to classify the enclosing call as update vs insert. */
const CONTEXT_LOOKBACK = 25;

const EXEMPT_MARKER = "stage-write-exempt";

/* A stage-column key: `stage:` or a quoted `"stage":` / `'stage':`.
 * `stage?:` (optional type prop) is NOT matched — the `?` breaks `\bstage\b\s*:`. */
const STAGE_KEY = /(?:\bstage\b|["']stage["'])\s*:/;
/* A dotted value (`stage: someTable.stage`) is a select projection / read, not a
 * column write — exclude it so reads don't get flagged. This deliberately also
 * spares the rare `stage: otherRow.stage` copy; inline literals/vars/exprs are
 * the write convention this gate enforces. */
const STAGE_READ_VALUE = /(?:\bstage\b|["']stage["'])\s*:\s*[A-Za-z_$][\w$]*\s*\./;

const UPDATE_CALL = /\.(set|update)\s*\(/;
const INSERT_CALL = /\.(values|insert)\s*\(/;
/* Read calls whose object literal may carry a `stage` projection (`.returning({
 * stage })`, a nested `.select({ stage })`). If one encloses the line before any
 * .set/.values, it is a read, not a stage-column write. */
const READ_CALL = /\.(select|returning)\s*\(/;

/* ─── KNOWN GAP ──────────────────────────────────────────────────────────────
 * This line-oriented scan cannot follow indirection: `.set(patchVar)` where
 * `patchVar` is an object literal built elsewhere with a `stage` field will NOT
 * be flagged (no `stage:` on the .set line). The enforced convention is that
 * stage writes are inline at the .set/.values call site (all current sites are),
 * so a reviewer catches any indirected write. Broadening to real dataflow
 * analysis is out of scope for a build gate. */
/* Non-DB sinks that also carry a descriptive `stage:` (event metadata, JSON
 * responses, return payloads). If one of these encloses the stage line before
 * any .set/.values, it is NOT a column write. */
const NONDB_BOUNDARY =
  /(\.json\s*\(|res\.(json|status|send)\s*\(|logCandidateEvent\s*\(|logEvent\s*\(|logAudit\s*\(|\breturn\b)/;
/* `metadata: { … stage: … }` on a single line — a descriptive event field. */
const METADATA_INLINE = /\bmetadata\s*:/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

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
for (const dir of SEARCH_DIRS) {
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file);
    if (ALLOWED_FILES.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const isComment = computeCommentMask(lines);

    for (let i = 0; i < lines.length; i++) {
      if (isComment[i]) continue;
      const line = lines[i];
      if (!STAGE_KEY.test(line)) continue;
      if (STAGE_READ_VALUE.test(line)) continue; // `stage: table.stage` — a read

      /* Same-line descriptive `stage:` — event metadata or a JSON/return
       * payload, not a column write. */
      const stageAt = line.search(STAGE_KEY);
      const metaAt = line.search(METADATA_INLINE);
      if (metaAt !== -1 && metaAt < stageAt) continue;
      if (NONDB_BOUNDARY.test(line)) continue;

      /* Classify enclosing call: scan up for the nearest .set/.update
       * (transition → flag) vs .values/.insert (creation → skip). Bail if a
       * non-DB sink (res.json/logCandidateEvent/return/metadata) or a read call
       * (.select/.returning) encloses the line first — not a stage-column write. */
      let isUpdate = false;
      let isInsert = false;
      let nonWrite = false;
      for (let j = i; j >= Math.max(0, i - CONTEXT_LOOKBACK); j--) {
        if (isComment[j]) continue;
        if (j < i && (NONDB_BOUNDARY.test(lines[j]) || METADATA_INLINE.test(lines[j]) || READ_CALL.test(lines[j]))) { nonWrite = true; break; }
        if (UPDATE_CALL.test(lines[j])) { isUpdate = true; break; }
        if (INSERT_CALL.test(lines[j])) { isInsert = true; break; }
      }
      if (nonWrite) continue;              // descriptive/read stage, not a column write
      if (isInsert && !isUpdate) continue; // Group 4 creation — exempt
      if (!isUpdate) continue;             // couldn't tie to an update — don't false-flag

      /* Honour a nearby reviewed exemption marker. */
      let exempt = false;
      for (let j = i; j >= Math.max(0, i - EXEMPT_LOOKBACK); j--) {
        if (lines[j].includes(EXEMPT_MARKER)) { exempt = true; break; }
      }
      if (exempt) continue;

      offenders.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }
}

if (offenders.length === 0) {
  console.log("[check-stage-choke-point] ✓ all pipeline-stage transitions route through changeCandidateStage()");
  process.exit(0);
}

console.error("[check-stage-choke-point] ✗ found raw pipeline-stage writes outside the choke-point:");
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.text}`);
}
console.error("");
console.error("Pipeline-stage transitions must route through changeCandidateStage()");
console.error("(lib/change-candidate-stage.ts) so the stage + candidate_events(STAGE_CHANGED)");
console.error("+ audit_logs pointer are written atomically. If a site genuinely cannot use");
console.error("the choke-point (e.g. no canonical candidateId, or a write inside a GDPR");
console.error("erasure transaction), add a `// stage-write-exempt: <reason>` comment directly");
console.error("above it explaining why.");
process.exit(1);
