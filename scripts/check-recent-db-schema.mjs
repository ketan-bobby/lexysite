import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recentSchemaContract } from "./recent-db-schema-contract.mjs";
import { atsSchemaContract } from "./ats-db-schema-contract.mjs";

const sql = readFileSync(new URL("./sql/check-recent-db-schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./sql/2026-10-11-candidate-erasure-write-barrier.sql", import.meta.url),
  "utf8",
);

export function requiredSchemaCheckNames(contract) {
  return [
    ...contract.tables.map((item) => `table:${item.name}`),
    ...contract.columns.map((item) => `column:${item.table_name}.${item.column_name}`),
    ...contract.constraints.map((item) => `constraint:${item.table_name}.${item.name}`),
    ...contract.indexes.map((item) => `index:${item.name}`),
    ...contract.functions.map((item) => `function:${item.name}`),
    ...contract.triggers.map((item) => `trigger:${item.table_name}`),
    ...(contract.ats_functions ?? []).map((item) => `function:${item.name}`),
    ...(contract.ats_triggers ?? []).map((item) => `trigger:${item.table_name}.${item.name}`),
  ];
}

export async function checkRecentSchema(client) {
  const contract = recentSchemaContract(migration);
  return inspectSchema(client, contract, sql, "recent-schema-metadata-only");
}

export async function checkAtsSchema(client) {
  const { contract, query } = atsSchemaInspection();
  return inspectSchema(client, contract, query, "ats-schema-metadata-only");
}

export function atsSchemaInspection() {
  const contract = atsSchemaContract(recentSchemaContract(migration).functions);
  const securitySql = readFileSync(
    new URL("./sql/check-ats-security.sql", import.meta.url),
    "utf8",
  );
  const query = `SELECT * FROM (${sql.trim().replace(/;$/, "")}) AS base_checks
    UNION ALL SELECT * FROM (${securitySql.trim().replace(/;$/, "")}) AS ats_checks
    ORDER BY check_name`;
  return { contract, query };
}

async function inspectSchema(client, contract, query, scope) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, public");
    const mode = await client.query("SHOW transaction_read_only");
    if (mode.rows[0]?.transaction_read_only !== "on") {
      throw new Error("Read-only transaction was not established");
    }
    // The operational checker always inspects public; there is no CLI override.
    const { rows } = await client.query(query, [JSON.stringify(contract), "public"]);
    const names = new Set(rows.map((row) => row.check_name));
    if (
      names.size !== rows.length ||
      requiredSchemaCheckNames(contract).some((name) => !names.has(name)) ||
      rows.some((row) => typeof row.passed !== "boolean")
    ) {
      throw new Error("Schema check returned incomplete or invalid evidence");
    }
    const checks = rows.map((row) => ({ name: row.check_name, passed: row.passed === true }));
    return {
      scope,
      targetEnvironment: "not-independently-attested",
      readOnly: true,
      checkedAt: new Date().toISOString(),
      passed: checks.every((row) => row.passed),
      checks,
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main() {
  const ats = process.argv.length === 3 && process.argv[2] === "--ats";
  if (process.argv.length > 2 && !ats) {
    console.error(
      "Usage: node scripts/check-recent-db-schema.mjs [--ats] (uses existing DATABASE_URL)",
    );
    process.exitCode = 2;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not configured. No database was changed.");
    process.exitCode = 2;
    return;
  }
  const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
  let client;
  try {
    const { Client } = require("pg");
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "lexy-recent-schema-readonly",
    });
    await client.connect();
    const report = await (ats ? checkAtsSchema(client) : checkRecentSchema(client));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    // Driver errors can contain connection details. Do not print them or the URL.
    console.error("Database metadata verification failed. No migrations or data writes were run.");
    process.exitCode = 2;
  } finally {
    try {
      await client?.end();
    } catch {
      console.error("Database verification connection cleanup failed.");
      process.exitCode = 2;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
