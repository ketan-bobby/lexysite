import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const runnerUrl = new URL("./assisted-baseline-runner.mjs", import.meta.url).href;
const guard = fileURLToPath(new URL("./test-egress-guard.mjs", import.meta.url));
const pass = (name) => ({ name, script: "console.log('check passed')" });
const fail = (name, code) => ({
  name,
  // Even success-looking stdout must not override the actual command status.
  script: `console.log('ℹ tests 1\\nℹ pass 1\\nℹ fail 0'); console.error('injected audit failure'); process.exit(${code})`,
});

function fixture(t) {
  const logs = mkdtempSync(path.join(tmpdir(), "lexy-gate-failure-test-"));
  t.after(() => rmSync(logs, { recursive: true, force: true }));
  return {
    logs,
    report: () => JSON.parse(readFileSync(path.join(logs, "summary.json"), "utf8")),
    checkpoints: () => JSON.parse(readFileSync(path.join(logs, "checkpoints.json"), "utf8")),
    run(steps, options = {}) {
      // The miniature CLI uses the production command runner, not a mock of
      // spawnSync or a hand-built results array. Only its commands are synthetic.
      const script = `
        import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
        import path from 'node:path';
        import {createAssistedBaselineRunner} from ${JSON.stringify(runnerUrl)};
        const root=${JSON.stringify(root)};
        const logs=${JSON.stringify(logs)};
        const options=${JSON.stringify(options)};
        const runner=createAssistedBaselineRunner({
          root,logs,commandTimeoutMs:options.commandTimeoutMs??240000
        });
        const checkpoints=[];
        function checkpoint(){
          checkpoints.push(JSON.parse(readFileSync(runner.reportFile,'utf8')));
          writeFileSync(path.join(logs,'checkpoints.json'),JSON.stringify(checkpoints));
        }
        checkpoint();
        for(const step of ${JSON.stringify(steps)}){
          runner.required(step.name,step.missing
            ?path.join(logs,'nonexistent-executable'):process.execPath,
            step.missing?[]:['--import',${JSON.stringify(guard)},'-e',step.script]);
          checkpoint();
        }
        if(options.interrupt){
          runner.run('pending-check',process.execPath,['-e','process.exit(0)']);
          process.kill(process.pid,'SIGTERM');
        }else{
          if(options.breakFinalReport)mkdirSync(runner.reportFile+'.tmp');
          process.exitCode=runner.finish();
        }
      `;
      return spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      });
    },
  };
}

test("the real release gate uses the tested runner and retains all three mandatory audit commands", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\/assisted-baseline-runner\.mjs"/);
  assert.match(source, /createAssistedBaselineRunner\(\{\s*root,\s*logs\s*\}\)/);
  assert.match(source, /process\.exitCode\s*=\s*finish\(\)/);
  assert.doesNotMatch(source, /spawnSync|results\.every/);
  assert.match(source, /"scripts\/assisted-baseline-runner\.test\.mjs"/);
  assert.match(source, /required\("recent-database-schema",\s*process\.execPath,/);
  assert.match(source, /required\("ats-database-schema",\s*process\.execPath,/);
  assert.match(source, /required\("zoho-handoff-database-schema",\s*process\.execPath,/);
});

test("all successful commands produce a completed green report and zero CLI exit", (t) => {
  const f = fixture(t);
  const result = f.run([
    pass("recent-database-schema"),
    pass("ats-database-schema"),
    pass("zoho-handoff-database-schema"),
    pass("later-check"),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = f.report();
  assert.equal(report.complete, true);
  assert.equal(report.status, "passed");
  assert.equal(report.completedChecks, 4);
  assert.equal(report.failedChecks, 0);
  assert.equal(report.activeStep, null);
  assert.ok(f.checkpoints().every((checkpoint) => checkpoint.status === "incomplete"));
});

for (const [audit, code] of [
  ["recent-database-schema", 7],
  ["ats-database-schema", 9],
  ["zoho-handoff-database-schema", 11],
]) {
  test(`${audit} failure survives later passes in the report, logs and CLI exit`, (t) => {
    const f = fixture(t);
    const steps = [
      "recent-database-schema",
      "ats-database-schema",
      "zoho-handoff-database-schema",
      "later-check",
    ].map((name) => (name === audit ? fail(name, code) : pass(name)));
    const result = f.run(steps);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(`FAIL ${audit}`));
    assert.match(result.stdout, /PASS later-check/);
    assert.match(result.stderr, /injected audit failure/);
    assert.match(readFileSync(path.join(f.logs, `${audit}.log`), "utf8"), /injected audit failure/);
    const report = f.report();
    assert.equal(report.complete, true);
    assert.equal(report.status, "failed");
    assert.equal(report.failedChecks, 1);
    assert.equal(report.passedChecks, 3);
    assert.deepEqual(
      report.results.map((row) => row.name),
      steps.map((step) => step.name),
    );
    const failed = report.results.find((row) => row.name === audit);
    assert.equal(failed.passed, false);
    assert.equal(failed.exitCode, code);
    assert.equal(failed.signal, null);
    assert.equal(failed.errorCode, null);
    assert.ok(failed.durationMs >= 0);
    const afterFailure = f.checkpoints().slice(steps.findIndex((step) => step.name === audit) + 1);
    assert.ok(afterFailure.every((checkpoint) => checkpoint.failedChecks === 1));
    assert.ok(afterFailure.every((checkpoint) => checkpoint.status === "incomplete"));
  });
}

test("two failed audits remain separately visible after a subsequent successful command", (t) => {
  const f = fixture(t);
  const result = f.run([
    fail("recent-database-schema", 7),
    fail("ats-database-schema", 9),
    pass("later-check"),
  ]);
  assert.equal(result.status, 1);
  assert.equal(f.report().failedChecks, 2);
  assert.deepEqual(
    f.report().results.map((row) => row.exitCode),
    [7, 9, 0],
  );
});

test("a missing audit executable fails closed and retains its spawn error", (t) => {
  const f = fixture(t);
  const result = f.run([{ name: "ats-database-schema", missing: true }, pass("later-check")]);
  assert.equal(result.status, 1);
  assert.equal(f.report().status, "failed");
  const failed = f.report().results[0];
  assert.equal(failed.exitCode, null);
  assert.equal(failed.errorCode, "ENOENT");
  assert.match(failed.detail, /ENOENT/);
  assert.equal(f.report().results[1].passed, true);
});

test("an audit killed by a signal cannot be mistaken for a successful null-status command", (t) => {
  const f = fixture(t);
  const result = f.run([
    { name: "ats-database-schema", script: "process.kill(process.pid,'SIGTERM')" },
    pass("later-check"),
  ]);
  assert.equal(result.status, 1);
  assert.equal(f.report().status, "failed");
  assert.equal(f.report().results[0].exitCode, null);
  assert.equal(f.report().results[0].signal, "SIGTERM");
  assert.equal(f.report().results[1].passed, true);
});

test("a timed-out command is recorded as failed with diagnostic metadata", (t) => {
  const f = fixture(t);
  const result = f.run(
    [
      {
        name: "ats-database-schema",
        script: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)",
      },
    ],
    { commandTimeoutMs: 150 },
  );
  assert.equal(result.status, 1);
  assert.equal(f.report().status, "failed");
  assert.equal(f.report().results[0].exitCode, null);
  assert.equal(f.report().results[0].errorCode, "ETIMEDOUT");
  assert.equal(f.report().results[0].signal, "SIGTERM");
});

test("an interrupted new run replaces a stale green report with incomplete evidence", (t) => {
  const f = fixture(t);
  assert.equal(f.run([pass("previous-check")]).status, 0);
  assert.equal(f.report().status, "passed");
  const result = f.run([pass("recent-database-schema")], { interrupt: true });
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, null);
  assert.equal(f.report().complete, false);
  assert.equal(f.report().status, "incomplete");
  assert.equal(f.report().activeStep, "pending-check");
  assert.deepEqual(
    f.report().results.map((row) => row.name),
    ["recent-database-schema"],
  );
  assert.equal(f.checkpoints()[0].completedChecks, 0);
  assert.equal(f.checkpoints()[0].status, "incomplete");
});

test("a final report-write failure cannot leave completed green evidence", (t) => {
  const f = fixture(t);
  const result = f.run([pass("ats-database-schema")], { breakFinalReport: true });
  assert.equal(result.status, 1);
  assert.equal(f.report().complete, false);
  assert.equal(f.report().status, "incomplete");
});

test("an empty completed run fails both the saved report and process exit", (t) => {
  const f = fixture(t);
  assert.equal(f.run([]).status, 1);
  assert.equal(f.report().complete, true);
  assert.equal(f.report().status, "failed");
  assert.equal(f.report().completedChecks, 0);
});
