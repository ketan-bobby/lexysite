import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOutlookPanelConsent, saveOutlookPanelConsent } from "./outlook-panel-consent";

const grantedAt = "2026-11-14T12:00:00.000Z";
test("sharing status requires a verified boolean and matching timestamp shape", () => {
  assert.deepEqual(parseOutlookPanelConsent({ enabled: true, grantedAt }), {
    enabled: true,
    grantedAt,
  });
  assert.deepEqual(parseOutlookPanelConsent({ enabled: false, grantedAt: null }), {
    enabled: false,
    grantedAt: null,
  });
  for (const invalid of [
    null,
    {},
    { enabled: "true", grantedAt },
    { enabled: true, grantedAt: null },
    { enabled: true, grantedAt: "invalid" },
    { enabled: false, grantedAt },
  ])
    assert.equal(parseOutlookPanelConsent(invalid), null);
});

test("sharing save waits for read cancellation before issuing its single write", async () => {
  const order: string[] = [];
  const result = await saveOutlookPanelConsent(true, {
    cancelPendingRead: async () => {
      await Promise.resolve();
      order.push("read-cancelled");
    },
    write: async (enabled) => {
      assert.deepEqual(order, ["read-cancelled"]);
      assert.equal(enabled, true);
      order.push("write");
      return { enabled, grantedAt };
    },
  });
  assert.deepEqual(order, ["read-cancelled", "write"]);
  assert.deepEqual(result, { enabled: true, grantedAt });
});

test("withdrawal confirms off without requiring a mailbox receipt", async () => {
  assert.deepEqual(
    await saveOutlookPanelConsent(false, {
      cancelPendingRead: async () => {},
      write: async () => ({ enabled: false, grantedAt: null }),
    }),
    { enabled: false, grantedAt: null },
  );
});

test("lost, malformed and contradictory write responses never confirm or retry", async () => {
  for (const response of [
    "lost",
    null,
    { enabled: false, grantedAt: null },
    { enabled: true, grantedAt: null },
  ]) {
    let writes = 0;
    await assert.rejects(
      saveOutlookPanelConsent(true, {
        cancelPendingRead: async () => {},
        write: async () => {
          writes++;
          if (response === "lost") throw new Error("simulated lost response");
          return response;
        },
      }),
    );
    assert.equal(writes, 1);
  }
});

test("failed cancellation cannot proceed with a write", async () => {
  let writes = 0;
  await assert.rejects(
    saveOutlookPanelConsent(true, {
      cancelPendingRead: async () => {
        throw new Error("cancel failed");
      },
      write: async () => {
        writes++;
        return { enabled: true, grantedAt };
      },
    }),
  );
  assert.equal(writes, 0);
});
