import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { writeAssistedBaselineProgress } from "./assisted-baseline-progress.mjs";

/**
 * Shared command/report lifecycle for the real gate and isolated subprocess
 * regressions. Importing this module never starts validation or connects to DBs.
 */
export function createAssistedBaselineRunner({
  root,
  logs,
  startedAt = new Date().toISOString(),
  commandTimeoutMs = 240_000,
}) {
  const results = [];
  const reportFile = path.join(logs, "summary.json");
  writeAssistedBaselineProgress(reportFile, results, { startedAt });
  process.stdout.write(`Progress report: ${reportFile}\n`);

  function run(name, executable, args, cwd = root) {
    const started = performance.now();
    writeAssistedBaselineProgress(reportFile, results, { startedAt, activeStep: name });
    process.stdout.write(`RUN ${name}\n`);
    const result = spawnSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout: commandTimeoutMs,
      maxBuffer: 24 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(path.join(logs, `${name}.log`), output);
    return { result, output, durationMs: Math.round(performance.now() - started) };
  }

  function record(name, passed, detail = "", metadata = {}) {
    results.push({ name, passed, detail, ...metadata });
    writeAssistedBaselineProgress(reportFile, results, { startedAt });
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
  }

  function required(name, executable, args, cwd) {
    const { result, output, durationMs } = run(name, executable, args, cwd);
    const summary = output
      .split("\n")
      .filter((line) => /^(#|ℹ) (tests|pass|fail|skipped) /.test(line))
      .join("; ");
    const passed = result.status === 0 && !result.error && !result.signal;
    record(
      name,
      passed,
      `${result.error?.message ?? summary}; ${(durationMs / 1000).toFixed(1)}s`,
      {
        durationMs,
        signal: result.signal,
        exitCode: result.status,
        errorCode: result.error?.code ?? null,
      },
    );
    if (!passed) process.stderr.write(output.slice(-8000));
    return passed;
  }

  function finish() {
    const report = writeAssistedBaselineProgress(reportFile, results, {
      startedAt,
      complete: true,
    });
    // Use the same strict, nonempty success definition as the saved report.
    return report.status === "passed" ? 0 : 1;
  }

  return { results, reportFile, run, record, required, finish };
}
