/** Real native HTTP/browser integration. No auth/inbox response interception. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const origin = "http://localhost";
const tid = (name) => `[data-testid="${name}"]`;
export function offerSessionBrowserExecutable() {
  const bundled = puppeteer.executablePath();
  if (existsSync(bundled)) return bundled;
  const system = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  assert.ok(existsSync(system), "Chromium is required before preparing any database fixture.");
  return system;
}
async function api(page, path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        credentials: "include",
        ...(body
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      const data = await response.json();
      // Never return or persist login tokens/passwords in test diagnostics.
      if (path === "/api/auth/login") return { status: response.status, id: data.user?.id };
      return { status: response.status, data };
    },
    { path, method, body },
  );
}

export async function checkOfferSessionAccess(f, { scenario = "suspension", signal } = {}) {
  assert.ok(["suspension", "role-change"].includes(scenario));
  signal?.throwIfAborted();
  const change = scenario === "suspension" ? { status: "suspended" } : { role: "interviewer" };
  const evidence = new URL(
    `../../../generated-artifacts/offer-session-access/${f.prefix}/`,
    import.meta.url,
  );
  await mkdir(evidence, { recursive: true });
  const screenshot = (page, name) =>
    page.screenshot({
      path: fileURLToPath(new URL(`${name}.jpg`, evidence)),
      type: "jpeg",
      quality: 70,
    });
  const browser = await puppeteer.launch({
    executablePath: offerSessionBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const abort = () => {
    void browser.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const contexts = [];
  const blocked = [];
  const exceptions = [];
  try {
    signal?.throwIfAborted();
    async function staff(actor) {
      const context = await browser.createBrowserContext();
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.setViewport({ width: 1440, height: 1000 });
      page.on("pageerror", () => exceptions.push("Unexpected application exception"));
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) {
          request.abort();
          return;
        }
        const method = request.method();
        const allowedLogin = method === "POST" && url.pathname === "/api/auth/login";
        const allowedChange =
          method === "PATCH" &&
          actor.id === f.actors.retained.id &&
          url.pathname === `/api/users/${f.actors.revoked.id}` &&
          request.postData() === JSON.stringify(change);
        if (
          url.pathname.startsWith("/api/") &&
          !["GET", "HEAD", "OPTIONS"].includes(method) &&
          !allowedLogin &&
          !allowedChange
        ) {
          blocked.push(`${method} ${url.pathname}`);
          request.abort();
          return;
        }
        request.continue();
      });
      await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
      const login = await api(page, "/api/auth/login", "POST", {
        email: actor.email,
        password: actor.password,
      });
      assert.equal(login.status, 200, "Real fixture login failed");
      assert.equal(login.id, actor.id, "Native API is not reading the verified fixture");
      const me = await api(page, "/api/auth/me");
      assert.equal(me.status, 200);
      assert.equal(me.data.id, actor.id);
      await page.goto(`${origin}/offer-inbox`, { waitUntil: "domcontentloaded" });
      await page.locator("::-p-text(All loaded)").click();
      await page.waitForSelector(tid(`offer-inbox-row-${f.workflowIds[0]}`));
      return page;
    }
    const revoked = await staff(f.actors.revoked);
    const retained = await staff(f.actors.retained);
    const list = await api(revoked, "/api/offer-inbox?limit=25");
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 25);
    assert.ok(list.data.nextCursor);
    const cursorPath = `/api/offer-inbox?limit=25&cursor=${encodeURIComponent(list.data.nextCursor)}`;
    const later = await api(revoked, cursorPath);
    assert.equal(later.status, 200);
    assert.equal(later.data.items.length, 1);
    const selected = f.workflowIds[25];
    await revoked.locator(tid("offer-inbox-load-more")).click();
    await revoked.waitForSelector(tid(`offer-inbox-row-${selected}`));
    await revoked.locator(tid(`offer-inbox-row-${selected}`)).click();
    await revoked.waitForSelector(tid("offer-inbox-detail"));
    await retained.locator(tid("offer-inbox-load-more")).click();
    await retained.waitForSelector(tid(`offer-inbox-row-${selected}`));
    await retained.locator(tid(`offer-inbox-row-${selected}`)).click();
    await retained.waitForSelector(tid("offer-inbox-detail"));
    await screenshot(revoked, "before-revocation");
    const detailPath = `/api/offer-inbox/${selected}`;
    assert.equal((await api(revoked, detailPath)).status, 200);
    assert.equal((await api(retained, detailPath)).status, 200);
    assert.equal((await api(retained, cursorPath)).status, 200);
    const changed = await api(retained, `/api/users/${f.actors.revoked.id}`, "PATCH", change);
    assert.equal(changed.status, 200, "Native staff-management change failed");
    assert.equal(changed.data.status, scenario === "suspension" ? "suspended" : "active");
    if (scenario === "role-change") {
      assert.equal(changed.data.role, "interviewer");
      const me = await api(revoked, "/api/auth/me");
      assert.equal(me.status, 200, "Role-change case must remain authenticated.");
      assert.equal(me.data.id, f.actors.revoked.id);
      assert.equal(me.data.role, "interviewer");
    }
    for (const path of ["/api/offer-inbox?limit=25", cursorPath, detailPath]) {
      const denied = await api(revoked, path);
      assert.ok(
        (scenario === "role-change" ? [403] : [401, 403]).includes(denied.status),
        "Revoked native session retained access",
      );
      assert.equal(denied.data.items, undefined);
      assert.equal(denied.data.entry, undefined);
      assert.ok(!JSON.stringify(denied.data).includes("SessionPrivate"));
      const permitted = await api(retained, path);
      assert.equal(permitted.status, 200, "Other assigned staff lost access");
    }
    // Real 15s inbox/detail polling must clear the already-rendered private data.
    await revoked.waitForFunction(
      () => {
        const privateRows = document.querySelector('[data-testid^="offer-inbox-row-"]');
        const detail = document.querySelector('[data-testid="offer-inbox-detail"]');
        const loading = document.querySelector('[data-testid="offer-inbox-detail-loading"]');
        return (
          !privateRows && !detail && !loading && !document.body.innerText.includes("SessionPrivate")
        );
      },
      { timeout: 45_000 },
    );
    await screenshot(revoked, "revoked-session-hidden");
    if (scenario === "role-change") {
      const me = await api(revoked, "/api/auth/me");
      assert.equal(me.status, 200, "Hiding offers must not require suspending the active account.");
      assert.equal(me.data.role, "interviewer");
    }
    await retained.locator(tid("offer-inbox-refresh")).click();
    await retained.waitForSelector(tid(`offer-inbox-row-${f.workflowIds[0]}`));
    await retained.waitForSelector(tid("offer-inbox-detail"));
    await retained.locator(tid("offer-inbox-load-more")).click();
    await retained.waitForSelector(tid(`offer-inbox-row-${selected}`));
    assert.equal((await api(retained, "/api/auth/me")).data.id, f.actors.retained.id);
    await screenshot(retained, "authorized-session-retained");
    assert.ok(!new URL(retained.url()).pathname.startsWith("/login"));
    assert.equal(blocked.length, 0, "An unexpected business write was attempted");
    assert.deepEqual(exceptions, [], "Native UI raised an application exception");
    console.log(
      `PASS: two independent real password/cookie sessions; 26 loaded fixture rows; ${scenario} and subsequent UI polling enforced.`,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled(contexts.map((context) => context.close()));
    await browser.close();
  }
}
