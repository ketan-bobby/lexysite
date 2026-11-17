import assert from "node:assert/strict";
import { test } from "node:test";
import { escalateStripeDormancy, sentinelEmailDecision } from "./stripe-sentinel-escalation";

// All delivery is an in-memory spy; never import app/bootstrap or the email provider.
const admins = [
  { id: "test-admin", email: "sentinel@controlled-fixture.org" },
  { id: "other-admin", email: "staff@another-fixture.org" },
  { id: "reserved", email: "admin@example.com" },
  { id: "missing", email: null },
];
function fixture(environment: string | undefined, testRecipients: readonly string[] = []) {
  const notifications: string[] = [],
    emails: string[] = [],
    skipped: string[] = [];
  return {
    notifications,
    emails,
    skipped,
    run: () =>
      escalateStripeDormancy({
        admins,
        environment,
        testRecipients,
        notify: async (a) => {
          notifications.push(a.id);
        },
        send: async (email) => {
          emails.push(email);
        },
        suppressed: (a, reason) => {
          skipped.push(`${a.id}:${reason}`);
        },
      }),
  };
}
for (const environment of ["development", "test", undefined, "", "staging", "Production"]) {
  test(`sentinel keeps internal warnings but suppresses external email in ${String(environment)}`, async () => {
    const f = fixture(environment);
    const result = await f.run();
    assert.deepEqual(
      f.notifications,
      admins.map((a) => a.id),
    );
    assert.deepEqual(f.emails, []);
    assert.deepEqual(result, { admins: 4, emailAttempts: 0 });
    assert(f.skipped.includes("test-admin:environment"));
    assert(f.skipped.includes("reserved:non_public"));
  });
}
test("production keeps existing public-recipient delivery and internal warnings", async () => {
  const f = fixture("production");
  assert.deepEqual(await f.run(), { admins: 4, emailAttempts: 2 });
  assert.deepEqual(
    f.emails,
    admins.slice(0, 2).map((a) => a.email),
  );
  assert.deepEqual(
    f.notifications,
    admins.map((a) => a.id),
  );
});
test("explicit harness authorization permits only the exact scoped test recipient", async () => {
  const f = fixture("test", [" SENTINEL@CONTROLLED-FIXTURE.ORG "]);
  await f.run();
  assert.deepEqual(f.emails, ["sentinel@controlled-fixture.org"]);
  assert.deepEqual(
    f.notifications,
    admins.map((a) => a.id),
  );
  assert(f.skipped.includes("other-admin:environment"));
});
test("allowlist wildcards and reserved/invalid addresses never authorize test delivery", () => {
  assert.equal(
    sentinelEmailDecision("development", "staff@another-fixture.org", ["*"]),
    "environment",
  );
  for (const email of ["admin@example.com", "a@localhost", "a@fixture.invalid", "bad"]) {
    assert.equal(sentinelEmailDecision("production", email, [email]), "non_public");
    assert.equal(sentinelEmailDecision("test", email, [email]), "non_public");
  }
});
test("notification/delivery failures remain best effort without enabling extra recipients", async () => {
  const sent: string[] = [],
    notified: string[] = [];
  const result = await escalateStripeDormancy({
    admins,
    environment: "production",
    notify: async (a) => {
      notified.push(a.id);
      if (a.id === "test-admin") throw new Error("fixture");
    },
    send: async (email) => {
      sent.push(email);
      throw new Error("fixture delivery failure");
    },
    suppressed: () => {},
  });
  assert.equal(result.emailAttempts, 2, "attempt count is not a claim of successful delivery");
  assert.equal(sent.length, 2);
  assert.deepEqual(
    notified,
    admins.map((a) => a.id),
  );
});
test("repeated development restarts never make the external send callback eligible", async () => {
  const f = fixture("development");
  await f.run();
  await f.run();
  assert.equal(f.notifications.length, admins.length * 2);
  assert.equal(f.emails.length, 0);
});
