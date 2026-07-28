#!/usr/bin/env node
/**
 * check-no-console.mjs — Build-time guard against raw console.* calls
 *
 * Why this exists:
 *   The api-server uses pino + pino-http with redaction serializers that
 *   strip Authorization headers, cookies, and other sensitive fields from
 *   request/response logs. Anything written via raw console.* bypasses that
 *   pipeline and lands on stdout unredacted — a real risk for PII / auth
 *   leakage into log aggregators.
 *
 *   This script scans src/ for any console.(log|error|warn|info|debug|trace)
 *   call and fails the build if it finds one outside the small allowlist
 *   below. New offenders MUST switch to `import { logger } from ".../logger"`.
 *
 * Allowlist:
 *   - **\/*.test.ts                 — local ad-hoc test scripts (dev only)
 *   - lib/logger.ts                 — the logger module itself may legitimately
 *                                     fall back to console if pino setup fails
 *
 * Edit the ALLOW list cautiously; every entry is a potential PII leak.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "..", "src");

if (!existsSync(SRC_DIR)) {
  console.error(`[check-no-console] src directory not found: ${SRC_DIR}`);
  process.exit(2);
}

const ALLOW = [
  /\.test\.ts$/,
  /[\\/]lib[\\/]logger\.ts$/,
  // This script itself is run via node, not bundled into the server.
  /[\\/]scripts[\\/]check-no-console\.mjs$/,
];

let output = "";
try {
  // -n   include line number
  // -t ts  only .ts files
  // ripgrep exits 1 when no matches — treat that as success.
  output = execSync(
    `rg -n -t ts 'console\\.(log|error|warn|info|debug|trace)\\(' ${JSON.stringify(SRC_DIR)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  if (err.status === 1) {
    // No matches at all — clean.
    process.exit(0);
  }
  console.error(`[check-no-console] ripgrep failed: ${err.message}`);
  process.exit(2);
}

const offenders = output
  .split("\n")
  .filter(Boolean)
  .filter((line) => {
    const file = line.split(":", 1)[0];
    return !ALLOW.some((re) => re.test(file));
  });

if (offenders.length === 0) {
  process.exit(0);
}

console.error(
  "[check-no-console] Found raw console.* calls in production code.\n" +
    "These bypass pino's redaction serializers and risk leaking PII or auth\n" +
    "headers into stdout. Replace with: import { logger } from \"…/logger\"\n" +
    "and use logger.error({ err, …context }, \"message\") instead.\n\n" +
    "Offenders:\n" +
    offenders.map((l) => "  " + l).join("\n") +
    "\n",
);
process.exit(1);
