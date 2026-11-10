import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { planAssistedTestBatches } from "./assisted-test-batches.mjs";
import { shardAssistedTestBatch } from "./assisted-test-shards.mjs";
import { createAssistedBaselineRunner } from "./assisted-baseline-runner.mjs";
import { runValidationExclusively } from "./validation-exclusivity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
runValidationExclusively({
  workspaceRoot: root,
  entryPath: fileURLToPath(import.meta.url),
  name: "assisted-baseline",
});
const guard = path.join(root, "scripts/test-egress-guard.mjs");
// Reuse the installed workspace test loader; the frontend does not own tsx.
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));
const tsxLoader = apiRequire.resolve("tsx");
const logs = mkdtempSync(path.join(tmpdir(), "lexy-assisted-baseline-"));
const baseline = JSON.parse(
  readFileSync(path.join(root, "scripts/assisted-quality-baseline.json"), "utf8"),
);
const { results, run, record, required, finish } = createAssistedBaselineRunner({ root, logs });

const apiTests = [
  "src/lib/weekly-digest-recap.test.ts",
  "src/lib/mail-hold-review.test.ts",
  "src/routes/mail-holds.test.ts",
  "src/lib/cadenced-communication.test.ts",
  "src/lib/scheduler-mail-handover.test.ts",
  "src/lib/recorded-communication.test.ts",
  "src/lib/recorded-communication-wiring.test.ts",
  "src/lib/self-report-reengagement.test.ts",
  "src/lib/outreach-mail-attempt.test.ts",
  "src/lib/meeting-notes-core.test.ts",
  "src/lib/meeting-notes-long-recording.test.ts",
  "src/lib/meeting-notes-transcription.test.ts",
  "src/lib/meeting-upload.test.ts",
  "src/lib/object-file-upload.test.ts",
  "src/lib/object-file-upload-sdk.test.ts",
  "scripts/meeting-notes-read-benchmark.test.ts",
  "src/lib/meeting-speakers.test.ts",
  "src/lib/zoom-recordings-provider.test.ts",
  "src/lib/google-meet-recordings-provider.test.ts",
  "src/lib/google-meet-recording-oauth.test.ts",
  "src/lib/google-meet-recording-account.test.ts",
  "src/routes/google-meet-recording-account.test.ts",
  "src/lib/native-recording-review.test.ts",
  "src/lib/native-meet-recording-core.test.ts",
  "src/lib/native-meet-recording-context.test.ts",
  "scripts/offer-session-journal.test.ts",
  "scripts/smoke-target-guard.test.mjs",
  "src/routes/job-create-development-privacy.test.ts",
  "src/lib/role-alert-safety.test.ts",
  "src/routes/compliance-analytics-authorization.test.ts",
  "src/routes/candidate-connection-engine-auth.test.ts",
  "src/routes/candidate-development-firewall.test.ts",
  "src/routes/candidate-database-privacy-seal.test.ts",
  "src/lib/google-calendar-read.test.ts",
  "src/lib/google-calendar-gateway.test.ts",
  "src/lib/recall-readiness.test.ts",
  "src/lib/meeting-attendance-core.test.ts",
  "src/lib/recall-attendance-provider.test.ts",
  "src/routes/meeting-attendance.test.ts",
  "src/routes/meeting-assistant-readiness.test.ts",
  "src/routes/google-calendar-pilot.test.ts",
  "src/lib/google-staff-service.test.ts",
  "src/lib/google-staff-provider.test.ts",
  "src/routes/google-staff-calendar.test.ts",
  "src/lib/google-interview-event.test.ts",
  "src/lib/google-interview-event-changes.test.ts",
  "src/lib/google-invitation-operation.test.ts",
  "src/lib/candidate-google-meet.test.ts",
  "src/routes/candidate-google-meet.test.ts",
  "src/lib/google-panel-times.test.ts",
  "src/lib/google-panel-freebusy.test.ts",
  "src/routes/google-panel-calendar.test.ts",
  "src/routes/google-invitation-operations.test.ts",
  "src/lib/google-interview-invitation.test.ts",
  "src/lib/google-staff-write-consent.test.ts",
  "src/routes/google-interview-invitations.test.ts",
  "src/lib/ats-connectors/zoho-recruit.test.ts",
  "src/lib/ats-connectors/zoho-application-identity.test.ts",
  "src/lib/ats-connectors/zoho-oauth.test.ts",
  "src/lib/ats-connectors/zoho-access-check.test.ts",
  "src/lib/ats-connectors/zoho-reviewed-import.test.ts",
  "src/lib/ats-connectors/zoho-interview-campaigns.test.ts",
  "src/lib/ats-connectors/zoho-campaign-delivery-evidence.test.ts",
  "src/lib/ats-connectors/zoho-campaign-reviews.test.ts",
  "src/lib/ats-connectors/zoho-review-export.test.ts",
  "src/lib/ats-connectors/zoho-interview-notes.test.ts",
  "src/lib/ats-connectors/zoho-interview-note-provider.test.ts",
  "src/lib/ats-connectors/zoho-interview-note-http.test.ts",
  "src/lib/ats-connectors/zoho-stage-handoff.test.ts",
  "src/lib/ats-connectors/zoho-stage-validation.test.ts",
  "src/lib/ats-connectors/zoho-stage-write.test.ts",
  "src/lib/ats-connectors/zoho-stage-requests.test.ts",
  "src/lib/ats-connectors/zoho-stage-request-store.test.ts",
  "src/lib/ats-connectors/zoho-stage-authority.test.ts",
  "src/lib/interview-plan-questions.test.ts",
  "src/lib/graph-auth.test.ts",
  "src/lib/outlook-calendar-transport.test.ts",
  "src/lib/outlook-calendar-core.test.ts",
  "src/lib/outlook-calendar-operation.test.ts",
  "src/routes/outlook-calendar-revision.test.ts",
  "src/routes/candidate-schedule-confirmation.test.ts",
  "src/lib/coordinator-schedule-input.test.ts",
  "src/routes/coordinator-schedule-access.test.ts",
  "src/lib/graph-consent-state.test.ts",
  "src/routes/outreach-outcome-access.test.ts",
  "src/routes/career-campaign-access.test.ts",
  "src/routes/agent-job-access.test.ts",
  "src/routes/candidate-erasure.test.ts",
  "src/lib/erasure-cleanup.test.ts",
  "src/lib/candidate-erasure-barrier.test.ts",
  "src/lib/candidate-account-erasure.test.ts",
  "src/routes/candidate-data-export.test.ts",
  "src/lib/auth-token.test.ts",
  "src/middlewares/sessionRevocation.test.ts",
  "src/lib/credential-session-version.test.ts",
  "src/lib/logout-all-sessions.test.ts",
  "src/lib/ats-handoff-receipt.test.ts",
  "src/lib/auth-cookie-flags.test.ts",
  "src/middlewares/validate.test.ts",
  "src/middlewares/request-parameter-contract.test.ts",
  "src/test-utils/json-response.test.ts",
  "src/routes/nullable-field-contracts.test.ts",
  "src/lib/object-prefix-deletion.test.ts",
  "src/scripts/live-pilot-response-contracts.test.ts",
  "src/routes/candidate-nl-search-request.test.ts",
  "src/routes/ai-documents-request-contract.test.ts",
  "src/routes/hm-share-privacy-seal.test.ts",
  "src/lib/startup-recovery.test.ts",
  "src/lib/agent-runs/recovery.test.ts",
  "src/middlewares/csrf-origin-guard.test.ts",
  "src/routes/jobs-assisted-baseline.test.ts",
  "src/routes/jobs-recruiting-configuration.test.ts",
  "src/routes/recruiting-workflows.test.ts",
  "src/routes/recruiting-workflow-journey.integration.test.ts",
  "src/routes/sourcing-controls.test.ts",
  "src/lib/sourcing-cost-analysis.test.ts",
  "src/lib/vendor-usage.test.ts",
  "src/lib/vendor-usage-coverage.test.ts",
  "src/lib/workflow-shadow.test.ts",
  "src/lib/workflow-runtime-evidence.test.ts",
  "src/lib/pilot-preparation-policy.test.ts",
  "src/routes/synthetic-fixture-reporting.integration.test.ts",
  "src/routes/internal-search-firewall-seal.test.ts",
  "src/lib/agent-runs/run-real.test.ts",
  "src/lib/agent-runs/run-real-no-fabrication.test.ts",
  "src/lib/agents/orchestrator-sourcing-cache.test.ts",
  "src/lib/change-candidate-stage.test.ts",
  "src/lib/sourced-stage.test.ts",
  "src/lib/ownership.test.ts",
  "src/lib/intelligence-override-history.test.ts",
  "src/routes/recruiter-ownership-sweep.test.ts",
  "src/lib/fairness-firewall.test.ts",
  "src/routes/cross-tenant-pipeline-intel-seal.test.ts",
  "src/routes/interview-runtime-consent-gate.test.ts",
  "src/routes/interview-transcribe-consent-gate.test.ts",
  "src/routes/interview-generate-link-idempotency.test.ts",
  "src/lib/interview-link-url.test.ts",
  "src/lib/pilot-codes.test.ts",
  "src/lib/notification-address.test.ts",
  "src/routes/interview-score-firewall-seal.test.ts",
  "src/routes/storage-recording-part-scoping.test.ts",
  "src/routes/recruiter-avatar-claim-seal.test.ts",
  "src/lib/ai-queue/interview-handoff.integration.test.ts",
  "src/lib/ai-queue/interview-followups.test.ts",
  "src/lib/interview-summary-result.test.ts",
  "src/lib/interview-turn-policy.test.ts",
  "src/lib/agent-runs/recorder.test.ts",
];
const webTests = [
  "src/components/scheduling/google-meet-recording-state.test.ts",
  "src/lib/meeting-live-capture.test.ts",
  "src/components/scheduling/outlook-panel-invitation-state.test.ts",
  "src/components/scheduling/google-calendar-pilot-state.test.ts",
  "src/lib/offer-draft-availability.test.ts",
  "src/lib/offer-action-availability.test.ts",
  "src/lib/public-offer-availability.test.ts",
  "src/lib/offer-inbox-action.test.ts",
  "src/lib/offer-inbox-pages.test.ts",
  "src/lib/workflow-decision-cache.test.ts",
  "src/lib/offer-terms-validation.test.ts",
  "src/lib/offer-draft-sync.test.ts",
  "src/lib/candidate-data-download.test.ts",
  "src/lib/recording-download.test.ts",
  "src/lib/zoho-review-download.test.ts",
  "src/lib/calendar-slots.test.ts",
  "src/lib/calendar-schedule-action.test.ts",
  "src/lib/candidate-time-confirmation.test.ts",
  "src/lib/schedule-save.test.ts",
  "src/lib/schedule-edit.test.ts",
  "src/lib/native-schedule-status.test.ts",
  "src/lib/interview-time-display.test.ts",
  "src/lib/schedule-applications.test.ts",
  "src/lib/schedule-reschedule.test.ts",
  "src/lib/intelligence-action-result.test.ts",
  "src/lib/sourcing-monthly-packages.test.ts",
  "src/lib/sourcing-account-rates.test.ts",
  "src/lib/work-order-approval.test.ts",
  "src/lib/score-band.test.ts",
  "src/lib/ats-refresh-batch.test.ts",
  "src/lib/ats-stage-display.test.ts",
  "src/components/jobs/WorkflowAtsStage.test.ts",
  "src/lib/score-band-guard.test.ts",
  "src/lib/score-display.test.ts",
  "src/lib/trust-gate.test.ts",
  "src/lib/optional-screen-share.test.ts",
  "src/lib/interview-session-load.test.ts",
  "src/lib/interview-verification-flow.test.ts",
];

required("baseline-batch-planner", process.execPath, [
  "--import",
  guard,
  "--test",
  "scripts/assisted-test-batches.test.mjs",
  "scripts/assisted-test-shards.test.mjs",
  "scripts/assisted-baseline-progress.test.mjs",
  "scripts/assisted-baseline-runner.test.mjs",
  "scripts/validation-exclusivity.test.mjs",
  "scripts/check-recent-db-schema.test.mjs",
  "scripts/check-ats-db-schema.test.mjs",
  "scripts/check-meeting-usage-schema.test.mjs",
  "scripts/check-zoho-handoff-schema.test.mjs",
  "scripts/zoho-handoff-schema-sql-fixture.test.mjs",
  "scripts/recent-db-schema-sql-fixture.test.mjs",
  "scripts/ats-db-schema-sql-fixture.test.mjs",
]);
required("test-egress-guard", process.execPath, ["--test", "scripts/test-egress-guard.test.mjs"]);
required("recent-database-schema", process.execPath, [
  "--import",
  guard,
  "scripts/check-recent-db-schema.mjs",
]);
required("ats-database-schema", process.execPath, [
  "--import",
  guard,
  "scripts/check-recent-db-schema.mjs",
  "--ats",
]);
required("zoho-handoff-database-schema", process.execPath, [
  "--import",
  guard,
  "scripts/check-zoho-handoff-schema.mjs",
]);
required("meeting-usage-database-schema", process.execPath, [
  "--import",
  guard,
  "scripts/check-meeting-usage-schema.mjs",
]);
// Bound the growing journey by disjoint top-level test names. Run sequentially
// with separate disposable fixtures; keep all tests and the existing timeout.
const apiBatches = planAssistedTestBatches(
  apiTests,
  [
    {
      name: "workflow-journey",
      file: "src/routes/recruiting-workflow-journey.integration.test.ts",
    },
  ],
  { maxFilesPerBatch: 4 },
).flatMap((batch) =>
  batch.name === "workflow-journey"
    ? shardAssistedTestBatch(
        batch,
        readFileSync(path.join(root, "artifacts/api-server", batch.files[0]), "utf8"),
      )
    : [batch],
);
let allApiPassed = true;
for (const batch of apiBatches) {
  const passed = required(
    `assisted-api-${batch.name}`,
    process.execPath,
    [
      "--import",
      guard,
      "--import",
      tsxLoader,
      "--test",
      "--experimental-test-module-mocks",
      "--test-concurrency=1",
      "--test-force-exit",
      ...(batch.testNamePattern ? [`--test-name-pattern=${batch.testNamePattern}`] : []),
      ...batch.files,
    ],
    path.join(root, "artifacts/api-server"),
  );
  Object.assign(results.at(-1), {
    files: batch.files,
    ...(batch.testNames ? { testNames: batch.testNames } : {}),
  });
  allApiPassed = passed && allApiPassed;
}
record(
  "assisted-api",
  allApiPassed,
  `${apiTests.length} files across ${apiBatches.length} bounded batches`,
);
required(
  "assisted-web-logic",
  process.execPath,
  ["--import", guard, "--import", tsxLoader, "--test", "--test-concurrency=1", ...webTests],
  path.join(root, "artifacts/lexy"),
);
required("frontend-typecheck", "pnpm", ["--filter", "@workspace/lexy", "run", "typecheck"]);
required("meeting-notes-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "exec",
  "node",
  "scripts/check-meeting-notes-browser.mjs",
]);
required("controlled-offer-browser", "pnpm", ["run", "test:offer-browser"]);
required("session-handoff-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:session-handoff-browser",
]);
required("logout-all-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:logout-all-browser",
]);
required("mail-holds-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:mail-holds-browser",
]);
required("zoho-campaign-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:zoho-campaign-browser",
]);
required("panel-invitation-browser", "pnpm", ["run", "test:panel-invitation-browser"]);
required("google-calendar-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:google-calendar-browser",
]);
required("google-invitation-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:google-invitation-browser",
]);
required("google-operation-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:google-operation-browser",
]);
required("candidate-google-meet-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:candidate-google-meet-browser",
]);
required("google-panel-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:google-panel-browser",
]);
required("google-staff-calendar-browser", "pnpm", [
  "--filter",
  "@workspace/lexy",
  "run",
  "test:google-staff-calendar-browser",
]);
required("api-typecheck", "pnpm", [
  "--filter",
  "@workspace/api-server",
  "exec",
  "tsc",
  "--noEmit",
  "--pretty",
  "false",
]);
required("api-build-and-guards", "pnpm", ["--filter", "@workspace/api-server", "run", "build"]);

const lintPath = path.join(logs, "lint.json");
const lint = run("lint", "pnpm", [
  "exec",
  "eslint",
  ".",
  "--format",
  "json",
  "--output-file",
  lintPath,
]);
try {
  const rows = JSON.parse(readFileSync(lintPath, "utf8"));
  const counts = new Map();
  for (const row of rows) {
    for (const message of row.messages.filter((item) => item.severity === 2)) {
      const key = JSON.stringify([
        path.relative(root, row.filePath),
        message.ruleId,
        message.message,
      ]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const allowance of baseline.lintErrors) {
    const key = JSON.stringify([allowance.file, allowance.ruleId, allowance.message]);
    counts.set(key, Math.max(0, (counts.get(key) ?? 0) - allowance.count));
  }
  const newErrors = [...counts.entries()].filter(([, count]) => count > 0);
  const total = rows.reduce((sum, row) => sum + row.errorCount, 0);
  record(
    "lint-no-new-errors",
    [0, 1].includes(lint.result.status) && newErrors.length === 0,
    `${total} existing/total error(s); ${newErrors.length} new error fingerprint(s)`,
  );
  for (const [key, count] of newErrors) process.stderr.write(`${count} × ${key}\n`);
} catch {
  record("lint-no-new-errors", false, "ESLint did not produce a valid report");
}

const format = run("format", "pnpm", ["exec", "prettier", "--list-different", "."]);
const unformatted = format.output
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const newFormatFiles = unformatted.filter((file) => !baseline.formatFiles.includes(file));
record(
  "format-no-new-files",
  [0, 1].includes(format.result.status) && newFormatFiles.length === 0,
  `${unformatted.length} existing/total file(s); ${newFormatFiles.length} new`,
);
for (const file of newFormatFiles) process.stderr.write(`${file}\n`);

process.exitCode = finish();
process.stdout.write(`Full logs: ${logs}\n`);
process.stdout.write(
  "This focused gate includes strict API and frontend typechecks; it is not proof of every UI journey or live provider acceptance.\n",
);
