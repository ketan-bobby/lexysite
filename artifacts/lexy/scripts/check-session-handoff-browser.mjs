import assert from "node:assert/strict";
import { startHarness, tid } from "./mail-holds-browser/harness.mjs";
const harness = await startHarness({
  fixtureModule: "security-handoff-browser",
  readyTestId: "logout-ui",
});
try {
  const f = await harness.open();
  try {
    f.state.logoutStatus = 503;
    await f.page.evaluate(() => localStorage.setItem("token", "synthetic-iframe-token"));
    await f.page.click(tid("logout-ui"));
    await f.page.waitForFunction(() => document.body.innerText.includes("Sign-out not confirmed"));
    assert(f.page.url().endsWith("/platform/mail-holds"));
    assert.equal(
      await f.page.evaluate(() => localStorage.getItem("token")),
      "synthetic-iframe-token",
    );
    assert.equal(f.state.logoutHeaders[0], "Bearer synthetic-iframe-token");
    f.state.logoutStatus = 200;
    await f.page.click(tid("logout-ui"));
    await f.page.waitForFunction(() => document.body.innerText.includes("Signed out fixture"));
    assert.equal(f.state.logoutHeaders[1], "Bearer synthetic-iframe-token");
    assert.equal(await f.page.evaluate(() => localStorage.getItem("token")), null);
    await f.check();
    console.log(
      "PASS real AuthProvider logout: storage failure is visible/retryable, DEV bearer retained until confirmed and then cleared",
    );
  } finally {
    await f.close();
  }
  const g = await harness.open();
  try {
    const button = tid("ats-handoff-record-receipt-fixture");
    await g.page.type(tid("ats-handoff-receipt-reference-fixture"), "HR-CASE-123");
    assert(await g.page.$eval(button, (e) => e.disabled));
    await g.page.click(tid("ats-handoff-receipt-ack-fixture"));
    assert.equal(await g.page.$eval(button, (e) => e.disabled), false);
    await g.page.evaluate(() => window.fixture.setAuthority(false));
    await g.page.waitForFunction(
      () =>
        document.querySelector('[data-testid="ats-handoff-receipt-reference-fixture"]').value ===
        "",
    );
    assert(await g.page.$eval(button, (e) => e.disabled));
    await g.page.evaluate(() => window.fixture.setAuthority(true));
    await g.page.type(tid("ats-handoff-receipt-reference-fixture"), "https://not-a-case.invalid");
    await g.page.click(tid("ats-handoff-receipt-ack-fixture"));
    assert(await g.page.$eval(button, (e) => e.disabled));
    await g.page.click(tid("ats-handoff-receipt-reference-fixture"), { clickCount: 3 });
    await g.page.keyboard.press("Backspace");
    await g.page.type(tid("ats-handoff-receipt-reference-fixture"), "HR-CASE-123");
    await g.page.click(button);
    await g.page.waitForSelector(tid("ats-handoff-receipt-fixture"));
    assert.deepEqual(await g.page.evaluate(() => window.fixture.records), ["HR-CASE-123"]);
    assert(
      (await g.page.$eval(tid("ats-handoff-receipt-fixture"), (e) => e.textContent)).includes(
        "Not verified ATS receipt",
      ),
    );
    await g.check();
    console.log(
      "PASS manual handoff UI: explicit acknowledgement, reference validation, authority-loss reset and honest recorded status",
    );
  } finally {
    await g.close();
  }
  const hr = await harness.open();
  try {
    const mapping = {
      system: "Greenhouse",
      accountRef: "synthetic-account",
      externalJobId: "101",
      externalCandidateId: "202",
      externalApplicationId: "303",
      mappedBy: "owner",
      mappedAt: "2026-01-01T00:00:00Z",
    };
    const state = {
      connectionState: "not_connected",
      workflowRevision: 1,
      canManage: true,
      ready: true,
      stale: false,
      mapping,
      packet: {
        id: "fixture-packet",
        snapshotHash: "a".repeat(64),
        approvedBy: "approver",
        approvedAt: "2026-01-01T00:00:00Z",
        exportedBy: "owner",
        exportedAt: "2026-01-02T00:00:00Z",
        content: {
          offerOwner: "external_employer",
          mapping,
          decision: { outcome: "hire", testOnly: true, reason: "private reasoning" },
        },
      },
    };
    const reference = tid("greenhouse-hr-reference");
    await hr.page.evaluate((s) => window.fixture.setGreenhouse(s), state);
    await hr.page.waitForSelector(reference);
    const text = await hr.page.$eval(reference, (e) => e.value);
    assert.match(text, /application ID: 303/);
    assert.doesNotMatch(text, /private reasoning|synthetic-account/);
    await hr.page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("fixture clipboard denied");
          },
        },
      }),
    );
    await hr.page.click(tid("greenhouse-hr-copy"));
    await hr.page.waitForFunction(() =>
      document.body.innerText.includes("Select and copy the reference text above"),
    );
    await hr.page.evaluate(() => window.fixture.setAuthority(false));
    await hr.page.waitForFunction(
      () => !document.querySelector('[data-testid="greenhouse-hr-reference"]'),
    );
    assert(!(await hr.page.content()).includes("Clipboard unavailable"));
    await hr.page.evaluate(() => window.fixture.setAuthority(true));
    await hr.page.waitForSelector(reference);
    await hr.page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.copiedHrReference = value;
          },
        },
      }),
    );
    await hr.page.click(tid("greenhouse-hr-copy"));
    await hr.page.waitForFunction(() =>
      document.body.innerText.includes("Copied locally. Nothing was sent to Greenhouse."),
    );
    assert.equal(await hr.page.evaluate(() => window.copiedHrReference), text);
    await hr.page.evaluate((s) => window.fixture.setGreenhouse({ ...s, stale: true }), state);
    await hr.page.waitForFunction(
      () => !document.querySelector('[data-testid="greenhouse-hr-reference"]'),
    );
    assert(!(await hr.page.content()).includes("Copied locally"));
    await hr.check();
    console.log(
      "PASS Greenhouse HR guide: approved/exported snapshot only, minimal disclosure, clipboard fallback and authority/staleness removal; no provider write",
    );
  } finally {
    await hr.close();
  }
} finally {
  await harness.close();
}
