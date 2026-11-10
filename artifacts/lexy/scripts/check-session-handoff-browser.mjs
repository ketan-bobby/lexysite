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
} finally {
  await harness.close();
}
