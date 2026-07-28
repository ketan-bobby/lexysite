#!/usr/bin/env node
/**
 * check-internal-search-tenant-scope.mjs — CI guard: the internal-first talent
 * discovery chokepoint (searchInternalDatabase in routes/sourcing.ts) must
 * constrain its candidate read to COMPANY-OWNED rows only (pool='tenant'), so an
 * employer's internal search can never surface a personal platform-pool
 * job-seeker profile. This is the inverse of check-platform-pool-read.mjs: that
 * guard protects employer-facing reads of the SHARED pool; this one protects the
 * one read that must EXCLUDE it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Thesis A ("clients discover their OWN internal talent first") requires a PURE
 * firewall between an employer and personal/job-seeking profiles. The internal
 * search originally filtered candidatesTable by tenantId ALONE, which was only
 * INCIDENTALLY safe — it relied on platform profiles always carrying a sentinel
 * tenantId that never collides with a real customer tenant. The enforced rule is
 * an explicit `eq(candidatesTable.pool, "tenant")` predicate. This guard fails
 * the build if a future change drops that predicate or renames/removes the
 * chokepoint function, so the firewall can never silently degrade back to the
 * accidental coincidence.
 *
 * Proven at runtime by internal-search-firewall-seal.test.ts (a platform profile
 * whose tenantId DELIBERATELY collides with the querying company is never
 * returned; a genuinely tenant-owned candidate is).
 *
 * SCOPE / LIMITATION
 * ------------------
 * Targeted, not a broad scanner: most candidate reads legitimately INCLUDE the
 * platform pool, so a blanket "every candidate read must be pool='tenant'" rule
 * would be wrong. searchInternalDatabase is currently the ONLY internal-first
 * discovery path. If another such path is added, add it to CHOKEPOINTS below so
 * it is held to the same rule.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Each chokepoint: the file + the internal-first discovery function whose
// candidate read MUST be constrained to company-owned (pool='tenant') rows.
const CHOKEPOINTS = [
  { file: "src/routes/sourcing.ts", fn: "searchInternalDatabase" },
];

// The required company-owned constraint, in the forms Drizzle would express it.
// Tolerates whitespace and an optional `as any` cast on the column reference.
const TENANT_POOL_RE =
  /eq\(\s*(?:candidatesTable|\w+)(?:\s+as\s+any)?\.pool(?:\s+as\s+any)?\s*,\s*["']tenant["']\s*\)/;

/* Body of a named function: the first `{` whose preceding non-whitespace char is
 * `)` (end of params) or `>` (end of a return type), to its brace-matched close. */
function bodyOf(src, defIndex) {
  let open = -1;
  for (let i = src.indexOf("{", defIndex); i !== -1; i = src.indexOf("{", i + 1)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] === ")" || src[j] === ">") { open = i; break; }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const offenders = [];
let checked = 0;

for (const { file, fn } of CHOKEPOINTS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), "utf8");
  } catch {
    offenders.push(`${file} — file not found (internal-search chokepoint moved? update CHOKEPOINTS)`);
    continue;
  }
  const clean = stripComments(raw);
  const defRe = new RegExp(`function\\s+${fn}\\s*[(<]`);
  const m = defRe.exec(clean);
  if (!m) {
    offenders.push(`${file} — function ${fn}() not found (renamed/removed? update CHOKEPOINTS and re-verify the firewall)`);
    continue;
  }
  const body = bodyOf(clean, m.index);
  if (!body) {
    offenders.push(`${file} — could not parse body of ${fn}()`);
    continue;
  }
  checked++;
  if (!TENANT_POOL_RE.test(body)) {
    offenders.push(
      `${file} — ${fn}() is missing the company-owned firewall predicate eq(candidatesTable.pool, "tenant"). ` +
      `Without it the internal search reverts to a tenantId-only filter, which leaks personal platform-pool profiles ` +
      `whose tenantId collides with a customer tenant.`,
    );
  }
}

const summary = `[check-internal-search-tenant-scope] checked ${checked}/${CHOKEPOINTS.length} internal-first discovery chokepoint(s)`;

if (offenders.length === 0) {
  console.log(`${summary} — ✓ every internal-first candidate read is constrained to company-owned rows (pool='tenant')`);
  process.exit(0);
}

console.error(summary);
console.error(`[check-internal-search-tenant-scope] ✗ ${offenders.length} problem(s):`);
for (const o of offenders) console.error(`  ${o}`);
console.error("");
console.error("The internal-talent firewall (thesis A) requires the internal search to read ONLY company-owned");
console.error("rows (pool='tenant'). Restore the explicit eq(candidatesTable.pool, \"tenant\") predicate, or if the");
console.error("chokepoint was intentionally renamed/moved, update CHOKEPOINTS in this script and re-verify with");
console.error("internal-search-firewall-seal.test.ts.");
process.exit(1);
