import assert from "node:assert/strict";
import { startHarness, hold, pageOf, actor, tid } from "./mail-holds-browser/harness.mjs";

const scenarios = [
  [
    "exact review contract, explicit consent and success reset",
    async (f) => {
      await f.select();
      assert(await f.page.$eval(tid("button-record-review"), (e) => e.disabled));
      await f.page.click(tid("radio-closed-no-resend"));
      await f.page.type(tid("input-evidence-reference"), "https://invalid.example");
      await f.page.click(tid("checkbox-acknowledge"));
      assert(await f.page.$eval(tid("button-record-review"), (e) => e.disabled));
      await f.page.$eval(tid("input-evidence-reference"), (e) => {
        e.value = "";
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await f.page.click(tid("input-evidence-reference"), { clickCount: 3 });
      await f.page.keyboard.press("Backspace");
      await f.page.type(tid("input-evidence-reference"), "CASE-123");
      await f.page.click(tid("button-record-review"));
      await f.page.waitForSelector(tid("status-review-recorded"));
      assert.deepEqual(f.state.posts, [
        {
          operationId: hold().operationId,
          version: "a".repeat(64),
          disposition: "closed_no_resend",
          evidenceReference: "CASE-123",
          acknowledgeNoResend: true,
        },
      ]);
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      assert(f.state.reads.length >= 2);
    },
  ],
  [
    "stale409 and direct read403 clear cached selection before recovery",
    async (f) => {
      await f.select();
      await f.fill();
      f.state.reviewStatus = 409;
      await f.page.click(tid("button-record-review"));
      await f.page.waitForSelector(tid("alert-version-conflict"));
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      assert.equal(await f.page.$(tid("status-review-recorded")), null);
      await f.select();
      await f.fill();
      f.state.readStatus = 403;
      await f.refresh();
      await f.page.waitForFunction(() =>
        document.body.innerText.includes("restricted to platform administrators"),
      );
      assert.equal(await f.page.$(tid(`radio-hold-${hold().operationId}`)), null);
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      f.state.readStatus = 200;
      await f.page.click(tid("button-retry"));
      await f.page.waitForSelector(tid(`radio-hold-${hold().operationId}`));
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
    },
  ],
  [
    "mutation denial stays private through failed read and fresh recovery",
    async (f) => {
      await f.select();
      await f.fill();
      f.state.reviewStatus = 403;
      await f.page.click(tid("button-record-review"));
      await f.page.waitForSelector(tid("button-retry"));
      assert.equal(await f.page.$(tid(`radio-hold-${hold().operationId}`)), null);
      f.state.readStatus = 401;
      await f.page.click(tid("button-retry"));
      await f.page.waitForFunction(() => document.body.innerText.includes("session has ended"));
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      f.state.readStatus = 200;
      await f.page.click(tid("button-retry"));
      await f.page.waitForSelector(tid(`radio-hold-${hold().operationId}`));
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      assert.equal(await f.page.$(tid("status-review-recorded")), null);
    },
  ],
  [
    "cursor pages and version freshness",
    async (f) => {
      f.state.first = pageOf([hold()], "page-two");
      await f.refresh();
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-next-page"]').disabled,
      );
      await f.page.click(tid("button-next-page"));
      await f.page.waitForSelector(tid(`radio-hold-${hold("two").operationId}`));
      assert(f.state.reads.includes("page-two"));
      await f.page.click(tid("button-previous-page"));
      await f.page.waitForSelector(tid(`radio-hold-${hold().operationId}`));
      await f.select();
      await f.fill();
      f.state.first = pageOf([{ ...hold(), version: "b".repeat(64) }]);
      await f.refresh();
      await f.page.waitForFunction(() =>
        document.body.innerText.includes("changed or left this page"),
      );
      assert.equal(f.state.posts.length, 0);
    },
  ],
  [
    "account switch never exposes previous identity's cached holds",
    async (f) => {
      await f.select();
      await f.fill();
      let release;
      f.state.gate = new Promise((resolve) => {
        release = resolve;
      });
      f.state.first = pageOf([hold("new-owner")]);
      await f.page.evaluate((user) => window.fixture.switchActor(user), {
        ...actor,
        id: "other-admin",
      });
      await f.page.waitForFunction(
        () => !document.body.innerText.includes("private-candidate-one"),
      );
      assert.equal(await f.page.$(tid("input-evidence-reference")), null);
      release();
      await f.page.waitForSelector(tid(`radio-hold-${hold("new-owner").operationId}`));
      assert.equal(f.state.posts.length, 0);
    },
  ],
];
const harness = await startHarness();
let passed = 0;
try {
  for (const [name, run] of scenarios) {
    const f = await harness.open();
    try {
      await run(f);
      await f.check();
      passed++;
      console.log(`PASS ${name}`);
    } finally {
      await f.close();
    }
  }
} finally {
  await harness.close();
}
console.log(
  `Mail Holds browser regression: ${passed}/${scenarios.length} passed (synthetic interception only)`,
);
