import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import {
  assertDevelopmentTarget,
  newOfferSessionFixture,
  prepareOfferSessionFixture,
  verifyOfferSessionFixture,
  cleanupOfferSessionFixture,
} from "./offer-session-fixture";
import { offerSessionOwnership, OfferSessionJournalStore } from "./offer-session-journal";
import { recoverOfferSessionJournal } from "./offer-session-recovery";
import { offerSessionOptions } from "./offer-session-options";

const controller = new AbortController();
const stop = () => {
  process.exitCode = 143;
  controller.abort(new Error("Isolated fixture run interrupted."));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const {
    fingerprint,
    cleanup,
    prepareOnly,
    scenario: requested,
  } = offerSessionOptions(process.argv.slice(2));
  await assertDevelopmentTarget(fingerprint);
  assert.ok(!(cleanup && (prepareOnly || requested)), "Cleanup cannot also start a fixture.");
  if (cleanup) {
    await recoverOfferSessionJournal(cleanup, fingerprint);
    console.log("PASS: exact journal fixture is absent; recovery is repeatable.");
  } else {
    assert.ok(!requested || ["suspension", "role-change"].includes(requested), "Unknown scenario.");
    const scenarios = prepareOnly
      ? ["suspension" as const]
      : requested
        ? [requested as "suspension" | "role-change"]
        : (["suspension", "role-change"] as const);
    const driver = prepareOnly
      ? null
      : await import(
          new URL("../../lexy/scripts/check-offer-session-access.mjs", import.meta.url).href
        );
    driver?.offerSessionBrowserExecutable();
    for (const scenario of scenarios) {
      controller.signal.throwIfAborted();
      const fixture = newOfferSessionFixture();
      const store = new OfferSessionJournalStore();
      const { name, journal } = await store.create(fixture, fingerprint!);
      fixture.ownershipProof = offerSessionOwnership(journal);
      console.log(`RECOVERY_JOURNAL ${name}`); // Non-secret basename only, never credentials.
      try {
        controller.signal.throwIfAborted();
        await prepareOfferSessionFixture(fixture);
        controller.signal.throwIfAborted();
        if (prepareOnly) {
          console.log(`FIXTURE_READY ${name}`);
          await new Promise<void>((_, reject) => {
            const keepAlive = setInterval(() => undefined, 60_000);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearInterval(keepAlive);
                reject(controller.signal.reason);
              },
              { once: true },
            );
          });
        } else {
          await driver!.checkOfferSessionAccess(fixture, { scenario, signal: controller.signal });
          await verifyOfferSessionFixture(fixture, scenario);
          console.log(
            `PASS: ${scenario}; native denial, cached privacy, authorized peer and no offers/outcomes/fees.`,
          );
        }
      } finally {
        await assertDevelopmentTarget(fingerprint);
        await cleanupOfferSessionFixture({ ...journal, ownershipProof: fixture.ownershipProof });
        await store.markCleaned(name, journal);
        console.log(
          "PASS: exact isolated business records and both accounts removed; journal marked cleaned.",
        );
      }
    }
  }
} catch (error) {
  if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
  console.log("Interrupted fixture run stopped; normal cleanup completed.");
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  await pool.end();
}
