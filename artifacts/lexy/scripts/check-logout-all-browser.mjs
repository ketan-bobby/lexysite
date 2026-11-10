import assert from "node:assert/strict";
import { startHarness } from "./mail-holds-browser/harness.mjs";

const form = 'form[aria-label="Sign out all devices"]';
const password = "#logout-all-password",
  ack = `${form} input[type=checkbox]`,
  button = `${form} button[type=submit]`;
const harness = await startHarness({
  fixtureModule: "security-handoff-browser",
  readyTestId: "logout-all-password",
});
async function fill(f) {
  await f.page.type(password, "Synthetic1!confirmation");
  await f.page.click(ack);
}
try {
  const f = await harness.open();
  try {
    await f.page.evaluate(() => localStorage.setItem("token", "synthetic-iframe-token"));
    assert(await f.page.$eval(button, (e) => e.disabled));
    await f.page.type(password, "Synthetic1!confirmation");
    assert(await f.page.$eval(button, (e) => e.disabled));
    await f.page.click(ack);
    for (const status of [403, 503, 409]) {
      f.state.logoutAllStatus = status;
      await f.page.click(button);
      await f.page.waitForSelector(`${form} [role=alert]`);
      await f.page.waitForFunction((p) => document.querySelector(p).value === "", {}, password);
      assert.equal(await f.page.$eval(ack, (e) => e.checked), false);
      assert.equal(
        await f.page.evaluate(() => localStorage.getItem("token")),
        "synthetic-iframe-token",
      );
      assert.equal(f.state.logoutHeaders.length, 0);
      if (status !== 409) await fill(f);
    }
    f.state.logoutAllStatus = 200;
    await fill(f);
    await f.page.click(button);
    await f.page.waitForFunction(() => location.pathname === "/login");
    assert.equal(await f.page.evaluate(() => localStorage.getItem("token")), null);
    assert.equal(f.state.logoutAllRequests.length, 4);
    for (const request of f.state.logoutAllRequests) {
      assert.deepEqual(request.keys, ["acknowledge", "password"]);
      assert.equal(request.acknowledge, true);
      assert.equal(request.passwordWasExpected, true);
      assert.equal(request.authorization, "Bearer synthetic-iframe-token");
    }
    assert.equal(f.state.logoutHeaders.length, 1);
    assert.equal(f.state.violations.length, 0);
    console.log(
      "PASS all-device UI: deliberate acknowledgement, typed password, retained session on 403/503/409, cleared confirmation, successful teardown",
    );
  } finally {
    await f.close();
  }
  const g = await harness.open();
  try {
    g.state.logoutAllDelayMs = 350;
    await g.page.evaluate(() => localStorage.setItem("token", "synthetic-iframe-token"));
    await fill(g);
    await g.page.click(button);
    await g.page.waitForFunction((p) => document.querySelector(p).disabled, {}, button);
    await g.page.evaluate(() => window.fixture.switchIdentity());
    await g.page.waitForFunction((p) => document.querySelector(p).value === "", {}, password);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.notEqual(new URL(g.page.url()).pathname, "/login");
    assert.equal(g.state.logoutHeaders.length, 0);
    assert.equal(await g.page.$eval(ack, (e) => e.checked), false);
    assert.equal(g.state.violations.length, 0);
    console.log(
      "PASS identity switch clears confirmation and prevents a stale response signing out the new identity",
    );
  } finally {
    await g.close();
  }
} finally {
  await harness.close();
}
