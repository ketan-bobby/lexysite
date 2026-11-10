import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const handoffCheckNames = Object.freeze([
  "tables_present",
  "forced_rls",
  "request_table_privileges_denied",
  "request_column_privileges_denied",
  "no_public_acl",
  "no_request_policies",
  "receipt_erasure_guard",
  "immutable_receipts",
  "simulation_only_state",
  "request_id_unique",
  "approval_evidence_unique",
  "recipient_cascade",
]);

/** Same SQL as the operator's audit; parameters only support private SQL fixtures. */
export function handoffSchemaInspection() {
  const source = readFileSync(
    new URL("./sql/check-zoho-handoff-storage.sql", import.meta.url),
    "utf8",
  );
  const match = source.match(/^--[^\n]*\nBEGIN READ ONLY;\n([\s\S]+)\nROLLBACK;\s*$/);
  if (!match) throw new Error("Unrecognized handoff audit transaction");
  return match[1].replaceAll("n.nspname='public'", "n.nspname=$1");
}

export async function checkZohoHandoffSchema(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const mode = await client.query("SHOW transaction_read_only");
    if (mode.rows[0]?.transaction_read_only !== "on")
      throw new Error("Read-only transaction was not established");
    // Operational scope is fixed. The CLI cannot substitute a schema or query.
    const { rows } = await client.query(handoffSchemaInspection(), ["public"]);
    const names = new Set(rows.map((row) => row.name));
    if (
      rows.length !== handoffCheckNames.length ||
      names.size !== rows.length ||
      handoffCheckNames.some((name) => !names.has(name)) ||
      rows.some((row) => typeof row.passed !== "boolean")
    )
      throw new Error("Incomplete or invalid handoff metadata evidence");
    return {
      scope: "zoho-handoff-schema-metadata-only",
      targetEnvironment: "not-independently-attested",
      readOnly: true,
      checkedAt: new Date().toISOString(),
      passed: rows.every((row) => row.passed),
      checks: rows.map(({ name, passed }) => ({ name, passed })),
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function runZohoHandoffAudit({
  args = process.argv.slice(2),
  env = process.env,
  createClient = () => {
    const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
    const { Client } = require("pg");
    return new Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "lexy-zoho-handoff-readonly",
    });
  },
  output = (message) => console.log(message),
  error = (message) => console.error(message),
} = {}) {
  if (args.length) {
    error("Usage: node scripts/check-zoho-handoff-schema.mjs (uses existing DATABASE_URL)");
    return 2;
  }
  if (!env.DATABASE_URL) {
    error("DATABASE_URL is not configured. No database was changed.");
    return 2;
  }
  let client;
  let code = 2;
  try {
    client = createClient();
    await client.connect();
    const report = await checkZohoHandoffSchema(client);
    output(JSON.stringify(report, null, 2));
    code = report.passed ? 0 : 1;
  } catch {
    // Never print driver messages, connection details or raw result rows.
    error("Zoho handoff metadata verification failed. No migrations or data writes were run.");
  } finally {
    try {
      await client?.end();
    } catch {
      error("Database verification connection cleanup failed.");
      code = 2;
    }
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runZohoHandoffAudit();
