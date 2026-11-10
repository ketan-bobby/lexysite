/**
 * Test-only preload: allow this process's HTTP harnesses, deny live integrations.
 * PostgreSQL uses its existing pg/TCP connection and is not intercepted.
 * A caught integration error still fails the child process at exit.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const harnessPorts = new Set();
// Explicit opt-in for IPC-ready child app fixtures. Never approve arbitrary
// localhost services (which may be billable provider proxies).
export function registerChildHarnessPort(child, port) {
  if (
    !child?.connected ||
    !Number.isInteger(child.pid) ||
    child.pid <= 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("A live owned IPC child and valid harness port are required");
  }
  harnessPorts.add(port);
  child.once("exit", () => harnessPorts.delete(port));
}
let blockedAttempts = 0;

function targetUrl(input, protocol) {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  const url = new URL(
    `${input?.protocol ?? protocol}//${input?.hostname ?? input?.host ?? "localhost"}`,
  );
  if (input?.port) url.port = String(input.port);
  return url;
}

export function isLocalHttpTarget(input, protocol = "http:") {
  try {
    const url = targetUrl(input, protocol);
    return ["http:", "https:"].includes(url.protocol) && localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function isHarnessRequest(input, protocol = "http:") {
  if (!isLocalHttpTarget(input, protocol)) return false;
  const url = targetUrl(input, protocol);
  return harnessPorts.has(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
}

// Loopback alone is insufficient: shared localhost AI proxies may bill requests.
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function guardedListen(...args) {
  let port;
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") {
      port = address.port;
      harnessPorts.add(port);
    }
  });
  this.once("close", () => harnessPorts.delete(port));
  return originalListen.apply(this, args);
};

function denyLiveIntegration() {
  blockedAttempts += 1;
  // Do not include URLs, headers, request bodies or credentials in the error.
  const error = new Error("Regression test attempted an unapproved HTTP integration");
  error.code = "TEST_LIVE_INTEGRATION_BLOCKED";
  return error;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, ...args) {
  const target = input instanceof Request ? input.url : input;
  if (!isHarnessRequest(target)) return Promise.reject(denyLiveIntegration());
  return originalFetch.call(this, input, ...args);
};

for (const [client, protocol] of [
  [http, "http:"],
  [https, "https:"],
]) {
  for (const method of ["request", "get"]) {
    const original = client[method];
    client[method] = function guardedRequest(input, ...args) {
      if (!isHarnessRequest(input, protocol)) throw denyLiveIntegration();
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();

process.on("exit", () => {
  if (blockedAttempts > 0) {
    process.stderr.write(
      `[test-egress-guard] ${blockedAttempts} live integration attempt(s) blocked\n`,
    );
    process.exitCode = 1;
  }
});
