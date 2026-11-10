import { startHarness } from "./panel-invitation-browser/harness.mjs";
import { scenarios } from "./panel-invitation-browser/scenarios.mjs";
import { googleStaffScenarios } from "./panel-invitation-browser/google-staff-scenarios.mjs";
import { googleInviteScenarios } from "./panel-invitation-browser/google-invite-scenarios.mjs";
import { googleOperationScenarios } from "./panel-invitation-browser/google-operation-scenarios.mjs";
import { googleScenarios } from "./panel-invitation-browser/google-scenarios.mjs";

// Real component/auth provider/API client, synthetic intercepted responses only.
// Never use this runner as proof of server authorization or Microsoft delivery.
const googleStaff = process.argv.includes("--google-staff");
const googleOperation = process.argv.includes("--google-operation");
const googleInvite = process.argv.includes("--google-invite");
const googleOnly = process.argv.includes("--google");
const label = googleOperation
  ? "Google invitation operation"
  : googleInvite
    ? "Google interview invitation"
    : googleStaff
      ? "Google staff calendar"
      : googleOnly
        ? "Google calendar pilot"
        : "Panel invitation";
const filter = process.argv
  .slice(2)
  .filter(
    (arg) =>
      arg !== "--" &&
      arg !== "--google" &&
      arg !== "--google-staff" &&
      arg !== "--google-invite" &&
      arg !== "--google-operation",
  )[0];
const suite = googleOperation
  ? googleOperationScenarios
  : googleInvite
    ? googleInviteScenarios
    : googleStaff
      ? googleStaffScenarios
      : googleOnly
        ? googleScenarios
        : scenarios;
const selected = filter ? suite.filter((s) => s.name.includes(filter)) : suite;
if (!selected.length) throw new Error("No panel invitation scenarios match the requested filter");
console.log(`Starting isolated ${label.toLowerCase()} regression harness...`);
const harness = await startHarness({ googleOnly, googleStaff, googleInvite, googleOperation });
let passed = 0,
  failed = 0;
try {
  for (const scenario of selected) {
    let fixture;
    try {
      console.log(`RUN ${scenario.name}`);
      fixture = await harness.open(scenario.options);
      let timer;
      try {
        await Promise.race([
          scenario.run(fixture),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Scenario exceeded its 30-second budget")),
              30_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await fixture.check(scenario.expectedViolations);
      passed++;
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${scenario.name}\n${error.stack}`);
      if (fixture) console.error(JSON.stringify(await fixture.diagnostics(), null, 2));
      if (!fixture) break;
    } finally {
      if (fixture) await fixture.close();
    }
  }
} finally {
  await harness.close();
}
console.log(`${label} browser checks: ${passed}/${selected.length} passed; ${failed} failed`);
process.exitCode = failed || passed !== selected.length ? 1 : 0;
