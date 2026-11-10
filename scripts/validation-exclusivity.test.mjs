import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validationBusyExitCode } from "./validation-exclusivity.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "lexy-validation-lock-test-"));
  const entry = path.join(root, "fixture.mjs");
  const release = path.join(root, "release");
  const journal = path.join(root, "journal");
  writeFileSync(
    entry,
    `
import { existsSync, appendFileSync } from "node:fs";
import { runValidationExclusively } from ${JSON.stringify(new URL("./validation-exclusivity.mjs", import.meta.url).href)};
runValidationExclusively({workspaceRoot:${JSON.stringify(root)}, entryPath:import.meta.filename, name:"fixture-regression"});
const [mode, label] = process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, label + "\\n");
console.log("READY");
if (mode === "hold") {
  const timer = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); }
  }, 20);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGKILL");
} else {
  process.exit(mode === "fail" ? 7 : 0);
}
`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, entry, release, journal };
}

function run(f, mode, label) {
  return spawnSync(process.execPath, [f.entry, mode, label], {
    encoding: "utf8",
    timeout: 5000,
  });
}

async function hold(t, f) {
  const child = spawn(process.execPath, [f.entry, "hold", "owner"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await done;
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Lock owner did not start")), 5000);
    child.stdout.on("data", (data) => {
      if (data.toString().includes("READY")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    done.then(() => {
      clearTimeout(deadline);
      reject(new Error("Lock owner exited before starting"));
    }, reject);
  });
  return { done };
}

test("a second process cannot touch shared fixtures; the owner completes normally", async (t) => {
  const f = fixture(t);
  const { done } = await hold(t, f);
  const duplicate = run(f, "pass", "duplicate");
  assert.equal(duplicate.status, validationBusyExitCode);
  assert.match(duplicate.stderr, /already running.*No duplicate checks were started/);
  assert.match(duplicate.stderr, /not a passing validation/);
  assert.equal(readFileSync(f.journal, "utf8"), "owner\n");
  writeFileSync(f.release, "");
  assert.equal((await done).code, 0);
  assert.equal(run(f, "pass", "next").status, 0);
  assert.equal(readFileSync(f.journal, "utf8"), "owner\nnext\n");
});

test("a failed child retains its exit code and releases the lock for a retry", (t) => {
  const f = fixture(t);
  assert.equal(run(f, "fail", "failed").status, 7);
  assert.equal(run(f, "pass", "retry").status, 0);
  assert.equal(readFileSync(f.journal, "utf8"), "failed\nretry\n");
});

test("kernel cleanup releases the lock after a child is killed", (t) => {
  const f = fixture(t);
  assert.notEqual(run(f, "signal", "killed").status, 0);
  assert.equal(run(f, "pass", "retry").status, 0);
});

test("an unrelated workspace can validate while another workspace holds its lock", async (t) => {
  const f = fixture(t);
  const other = fixture(t);
  const { done } = await hold(t, f);
  assert.equal(run(other, "pass", "independent").status, 0);
  writeFileSync(f.release, "");
  assert.equal((await done).code, 0);
});
