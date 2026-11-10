/**
 * Opt-in live acceptance: at most ONE configured OpenAI-compatible chat POST
 * inside the native screening call. No email, sourcing, speech or retries.
 * All other HTTP is limited to harness servers owned by this process.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { isMainThread } from "node:worker_threads";

if (isMainThread && !process.argv.includes("--live-screening-acceptance"))
  throw new Error("Live acceptance needs the explicit opt-in argument");
const allowance = new AsyncLocalStorage();
const ports = new Set();
const origins = new Set(["https://api.openai.com"]);
if (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL)
  origins.add(new URL(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL).origin);
let requests = 0;
let denied = 0;
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () => ports.add(this.address().port));
  this.once("close", () => ports.delete(this.__ownedPort));
  this.once("listening", () => {
    this.__ownedPort = this.address().port;
  });
  return listen.apply(this, args);
};
function permitted(input, method = "GET") {
  const url = new URL(input instanceof Request ? input.url : input);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ports.has(Number(url.port)))
    return true;
  if (
    allowance.getStore() &&
    requests === 0 &&
    method === "POST" &&
    origins.has(url.origin) &&
    url.pathname.endsWith("/chat/completions")
  ) {
    requests += 1;
    return true;
  }
  denied += 1;
  throw new Error("Unapproved live acceptance HTTP request blocked");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  permitted(input, options?.method ?? (input instanceof Request ? input.method : "GET"));
  return originalFetch(input, options);
};
for (const client of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = client[method];
    client[method] = function (input, ...args) {
      const url =
        input instanceof URL || typeof input === "string"
          ? input
          : `${input.protocol ?? (client === https ? "https:" : "http:")}//${input.hostname ?? input.host}:${input.port ?? (client === https ? 443 : 80)}${input.path ?? "/"}`;
      permitted(url, input.method ?? args[0]?.method ?? "GET");
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();
export const withOneLiveScreeningRequest = (fn) => allowance.run(true, fn);
export const liveScreeningRequestCount = () => requests;
process.on("exit", () => {
  if (isMainThread)
    process.stdout.write(`LIVE_SCREENING_EGRESS ${JSON.stringify({ requests, denied })}\n`);
  if (denied) process.exitCode = 1;
});
