import { startHarness } from "./offer-browser/harness.mjs";
import { initialFor, scenarios } from "./offer-browser/scenarios.mjs";
import { reconciliationScenarios } from "./offer-browser/reconciliation-scenarios.mjs";
import { eligibilityScenarios } from "./offer-browser/eligibility-scenarios.mjs";
import { decisionScenarios } from "./offer-browser/decision-scenarios.mjs";

// Standalone local browser runner, not a live pilot: no credentials, database,
// provider requests or outbound delivery. The real editor/API client is rendered.
console.log("Starting isolated Vite and Chromium offer-regression harness...");
const harness = await startHarness();
const filter = process.argv[2];
const allScenarios = [
  ...scenarios,
  ...reconciliationScenarios,
  ...eligibilityScenarios,
  ...decisionScenarios,
];
const selected = filter
  ? allScenarios.filter((scenario) => scenario.name.includes(filter))
  : allScenarios;
if (selected.length === 0) {
  await harness.close();
  throw new Error(`No offer-browser scenarios match ${JSON.stringify(filter)}`);
}
let failed = 0;
let passed = 0;
try {
  for (const scenario of selected) {
    let fixture;
    try {
      console.log(`RUN ${scenario.name}`);
      fixture = await harness.open(
        initialFor(scenario),
        scenario.actions,
        scenario.width,
        scenario.mode,
      );
      await scenario.run(fixture);
      await fixture.check(scenario.expectedViolations);
      passed++;
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${scenario.name}\n${error.stack}`);
      if (!fixture) break; // Do not repeat a shared browser/bootstrap failure.
    } finally {
      if (fixture) await fixture.close();
    }
  }
} finally {
  await harness.close();
}
console.log(
  `Controlled-offer browser checks: ${passed}/${selected.length} passed; ${failed} failed; ${selected.length - passed - failed} not run`,
);
process.exitCode = failed ? 1 : 0;
