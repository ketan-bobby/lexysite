import { writeFileSync, renameSync } from "node:fs";

/**
 * Persist completed checks while the gate is running. This is an evidence
 * journal, not a cache: every invocation still executes every configured check.
 * A killed or timed-out run must never look like a completed green gate.
 */
export function writeAssistedBaselineProgress(
  file,
  results,
  { complete = false, activeStep = null, startedAt = null } = {},
) {
  const passed = results.filter((result) => result.passed === true).length;
  const report = {
    complete,
    status: complete
      ? results.length > 0 && passed === results.length
        ? "passed"
        : "failed"
      : "incomplete",
    activeStep: complete ? null : activeStep,
    startedAt,
    updatedAt: new Date().toISOString(),
    completedChecks: results.length,
    passedChecks: passed,
    failedChecks: results.length - passed,
    results,
  };
  // Same-directory rename prevents readers from observing a truncated report.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
  renameSync(temporary, file);
  return report;
}
