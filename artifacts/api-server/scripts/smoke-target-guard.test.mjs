import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { smokeTarget } from "./smoke-target-guard.mjs";

const approved = {
  NODE_ENV: "test",
  SMOKE_ALLOW_MUTATIONS: "true",
  SMOKE_BASE_URL: "http://127.0.0.1:24602",
  SMOKE_CONFIRMED_ORIGIN: "http://127.0.0.1:24602",
};

test("explicit local origin and consent are accepted", () => {
  assert.equal(smokeTarget(approved), approved.SMOKE_BASE_URL);
});

test("missing, false and ambiguous mutation consent are refused", () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    assert.throws(() => smokeTarget({ ...approved, SMOKE_ALLOW_MUTATIONS: value }));
  }
});

test("production runtime is refused even with local consent", () => {
  assert.throws(() => smokeTarget({ ...approved, NODE_ENV: "production" }));
});

test("no implicit host or default port is chosen", () => {
  for (const value of [undefined, "", "not a url"]) {
    assert.throws(() => smokeTarget({ ...approved, SMOKE_BASE_URL: value }));
  }
});

test("external hosts and loopback lookalikes are refused", () => {
  for (const host of ["example.invalid", "localhost.example.invalid", "127.0.0.2"]) {
    const origin = `https://${host}`;
    assert.throws(() =>
      smokeTarget({
        ...approved,
        SMOKE_BASE_URL: origin,
        SMOKE_CONFIRMED_ORIGIN: origin,
      }),
    );
  }
});

test("credentials, paths, queries, fragments and non-HTTP schemes are refused", () => {
  for (const value of [
    "http://user:private@localhost",
    "http://localhost/api",
    "http://localhost/?token=private",
    "http://localhost/#private",
    "ftp://localhost",
  ]) {
    assert.throws(() => smokeTarget({ ...approved, SMOKE_BASE_URL: value }));
  }
});

test("confirmation must match the exact normalized origin and port", () => {
  for (const value of [undefined, "", "http://127.0.0.1", "http://127.0.0.1:24603"]) {
    assert.throws(() => smokeTarget({ ...approved, SMOKE_CONFIRMED_ORIGIN: value }));
  }
});

test("IPv6 and default-port normalization are supported", () => {
  assert.equal(
    smokeTarget({
      ...approved,
      SMOKE_BASE_URL: "http://[::1]:80/",
      SMOKE_CONFIRMED_ORIGIN: "http://[::1]",
    }),
    "http://[::1]",
  );
});

test("refusal messages never echo the supplied URL", () => {
  assert.throws(
    () =>
      smokeTarget({
        ...approved,
        SMOKE_BASE_URL: "http://user:private-value@localhost",
      }),
    (error) => !error.message.includes("private-value"),
  );
});

test("the actual legacy entrypoint refuses before sending a request", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(
      process.execPath,
      [new URL("./smoke-critical-journeys.mjs", import.meta.url).pathname],
      {
        // Deliberately do not inherit workspace secrets or mutation approval.
        env: {
          NODE_ENV: "test",
          SMOKE_BASE_URL: base,
          SMOKE_CONFIRMED_ORIGIN: base,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /smoke preflight/);
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
