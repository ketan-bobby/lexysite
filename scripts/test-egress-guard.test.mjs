import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLocalHttpTarget } from "./test-egress-guard.mjs";

const preload = fileURLToPath(new URL("./test-egress-guard.mjs", import.meta.url));

test("only exact loopback HTTP hosts are permitted", () => {
  for (const target of [
    "http://127.0.0.1:3210/api",
    "http://localhost:3210/api",
    "http://[::1]:3210/api",
    { hostname: "127.0.0.1", port: 3210 },
  ]) {
    assert.equal(isLocalHttpTarget(target), true);
  }
  for (const target of [
    "https://example.invalid",
    "https://localhost.example.invalid",
    "https://127.0.0.1.example.invalid",
    "https://localhost@example.invalid",
    "file:///tmp/fixture",
    { hostname: "example.invalid" },
  ]) {
    assert.equal(isLocalHttpTarget(target), false);
  }
});

test("live fetch fails the process even when application code catches it", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", preload, "--eval", "fetch('https://example.invalid').catch(() => {});"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /live integration attempt\(s\) blocked/);
  assert.doesNotMatch(child.stderr, /example\.invalid/);
});

test("live Node HTTP and HTTPS calls are blocked before a socket opens", () => {
  for (const protocol of ["http", "https"]) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "--eval",
        `import('${protocol}').then(m => { try { m.get('${protocol}://example.invalid'); } catch {} });`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /live integration attempt\(s\) blocked/);
  }
});

test("shared loopback integrations are blocked unless this process owns the server", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", preload, "--eval", "fetch('http://127.0.0.1:1106/proxy').catch(() => {});"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /live integration attempt\(s\) blocked/);
});

test("a real local test server remains accessible", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      "--eval",
      `
        const { createServer } = await import('node:http');
        const server = createServer((_req, res) => res.end('fixture'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch('http://127.0.0.1:' + server.address().port);
        if (await response.text() !== 'fixture') process.exitCode = 1;
        server.closeAllConnections();
        server.close();
      `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 0, child.stderr);
});
