#!/usr/bin/env node
/**
 * check-codegen.mjs — CI parity check for OpenAPI codegen output
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 * Verifies that the committed contents of `lib/api-zod/src/generated` and
 * `lib/api-client-react/src/generated` match what `pnpm codegen` would
 * produce from the current `openapi.yaml`. If anything is out of date,
 * the script exits with code 1 and prints which files drifted, so CI can
 * fail builds that forget to regenerate the typed client + zod schemas.
 *
 * ─── How it works ────────────────────────────────────────────────────────────
 *   1. Snapshot every existing file under the two generated dirs into memory.
 *   2. Run `orval` to regenerate them in place (this is destructive — orval
 *      uses `clean: true`).
 *   3. Read every file back, compute byte-for-byte diffs against step 1.
 *   4. Restore the snapshot in ALL cases (clean, drift, or thrown error) so
 *      the developer's working tree is never left mutated by the check.
 *   5. Exit 0 if all bytes matched, 1 otherwise.
 *
 * ─── How to use ──────────────────────────────────────────────────────────────
 *   pnpm --filter @workspace/api-spec run check-codegen
 *
 * ─── Why not just `git diff`? ────────────────────────────────────────────────
 * Snapshot-and-restore works in any environment — sandboxes, fresh clones,
 * dirty trees — without depending on git state. It also makes the check
 * safe to run locally: the developer never has to worry that running it
 * will silently modify files they were in the middle of editing.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiSpecDir = join(__dirname, "..");
const repoRoot = join(apiSpecDir, "..", "..");

const TARGETS = [
  join(repoRoot, "lib", "api-zod", "src", "generated"),
  join(repoRoot, "lib", "api-client-react", "src", "generated"),
];

/** Recursively collect every file under `dir` into a {relPath -> bytes} map. */
function snapshot(dir) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  if (!existsSync(dir)) return out;
  /** @param {string} cur */
  function walk(cur) {
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        out.set(relative(dir, full), readFileSync(full));
      }
    }
  }
  walk(dir);
  return out;
}

/** Restore a {relPath -> bytes} snapshot under `dir`, wiping anything else there. */
function restore(dir, snap) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [rel, bytes] of snap) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
}

const snapshots = TARGETS.map((d) => ({ dir: d, snap: snapshot(d) }));

/** @type {string[]} */
let drifted = [];
/** @type {Error | null} */
let codegenError = null;
try {
  /* Run orval. We let stderr stream through so the human running this can
   * see exactly why codegen failed, but we don't let execSync's own crash
   * format leak to the user — we catch and report it cleanly below. */
  try {
    execSync("pnpm exec orval --config ./orval.config.ts", {
      cwd: apiSpecDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (err) {
    codegenError = err instanceof Error ? err : new Error(String(err));
  }

  if (!codegenError) {
    for (const { dir, snap } of snapshots) {
      const fresh = snapshot(dir);
      const allKeys = new Set([...snap.keys(), ...fresh.keys()]);
      for (const k of allKeys) {
        const a = snap.get(k);
        const b = fresh.get(k);
        if (!a || !b || !a.equals(b)) {
          drifted.push(join(relative(repoRoot, dir), k));
        }
      }
    }
  }
} finally {
  /* Always restore — even on a codegen failure mid-flight, we don't want the
   * developer's tree to be left in a half-regenerated state. Orval's
   * `clean: true` wipes the output dirs BEFORE producing anything new, so
   * a mid-run failure leaves the dirs empty until this restore runs.
   *
   * If restore itself fails (e.g., disk full, permission flip mid-run), we
   * must NOT swallow it: the developer's tree may be partially populated
   * or empty, and silent failure would leave them debugging a missing
   * generated file with no clue why. We catch and report loudly with the
   * exact path + relative path so they can recover from git. */
  for (const { dir, snap } of snapshots) {
    try {
      restore(dir, snap);
    } catch (err) {
      console.error("");
      console.error("✖✖✖ RESTORE FAILED for " + relative(repoRoot, dir));
      console.error("    " + (err instanceof Error ? err.message : String(err)));
      console.error("    Your working tree may be left in a partially-restored state.");
      console.error("    Run `git checkout HEAD -- " + relative(repoRoot, dir) + "` to recover.");
      /* Re-throw so the script exits non-zero with a real failure signal
       * instead of falsely reporting "✔ up to date" after a broken restore. */
      throw err;
    }
  }
}

if (codegenError) {
  console.error("✖ Codegen tooling failed before drift could be checked. The committed");
  console.error("  generated files have been restored. Fix the codegen pipeline (see");
  console.error("  stderr above) and then re-run this check.");
  process.exit(2);
}

if (drifted.length > 0) {
  console.error("✖ OpenAPI codegen is out of sync. The following generated files differ from what orval would produce:");
  for (const f of drifted.sort()) console.error("   - " + f);
  console.error("");
  console.error("Run `pnpm --filter @workspace/api-spec run codegen` and commit the result.");
  process.exit(1);
}

console.log("✔ OpenAPI codegen is up to date.");
