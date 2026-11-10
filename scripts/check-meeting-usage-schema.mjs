import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expectedUsageArea } from "./usage-schema-contract.mjs";

export { expectedUsageArea };
const normalize = (value) => String(value ?? "").replace(/\s+/g, "");

export function meetingUsageSchemaReport(metadata) {
  const checks = [
    {
      name: "full-length-recording-byte-bound",
      passed:
        metadata.byteSizeValidated === true &&
        normalize(metadata.byteSizeCheck) ===
          normalize("CHECK (((byte_size > 0) AND (byte_size <= 104857600)))"),
    },
    {
      name: "meeting-speaker-evidence-column",
      passed: metadata.speakerType === "jsonb" && metadata.speakerNullable === "YES",
    },
    {
      name: "native-recording-provenance-and-deduplication",
      passed:
        metadata.nativeType === "jsonb" &&
        metadata.nativeNullable === "YES" &&
        metadata.sourceKeyType === "text" &&
        metadata.sourceKeyNullable === "YES" &&
        metadata.sourceKeyUnique === true,
    },
    {
      name: "usage-activity-labels",
      passed: normalize(metadata.area) === normalize(expectedUsageArea),
    },
    {
      name: "usage-unknown-cost-preserved",
      passed: normalize(metadata.cost) === normalize("CHECK ((cost_status = 'unknown'::text))"),
    },
    {
      name: "usage-row-security-preserved",
      passed: metadata.rls === true && metadata.forceRls === true,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

export async function checkMeetingUsageSchema(client) {
  const bounds = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint WHERE conrelid=to_regclass('public.meeting_notes') AND contype='c' AND conname='meeting_notes_byte_size_check'",
  );
  const columns = await client.query(
    "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_notes' AND column_name='speaker_evidence'",
  );
  const constraints = await client.query(
    "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('public.vendor_usage_attempts') AND conname IN ('vendor_usage_attempts_area_check','vendor_usage_attempts_cost_status_check')",
  );
  const security = await client.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass('public.vendor_usage_attempts')",
  );
  const native = await client.query(`
    SELECT
      (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_notes' AND column_name='native_source') AS native_type,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_notes' AND column_name='native_source') AS native_nullable,
      (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_notes' AND column_name='source_key') AS source_key_type,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='meeting_notes' AND column_name='source_key') AS source_key_nullable,
      EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
        WHERE i.indrelid=to_regclass('public.meeting_notes') AND i.indisunique AND i.indisvalid
          AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname='source_key') AS source_key_unique
  `);
  return meetingUsageSchemaReport({
    byteSizeCheck: bounds.rows[0]?.definition,
    byteSizeValidated: bounds.rows[0]?.convalidated,
    speakerType: columns.rows[0]?.data_type,
    speakerNullable: columns.rows[0]?.is_nullable,
    area: constraints.rows.find((row) => row.conname === "vendor_usage_attempts_area_check")
      ?.definition,
    cost: constraints.rows.find((row) => row.conname === "vendor_usage_attempts_cost_status_check")
      ?.definition,
    rls: security.rows[0]?.relrowsecurity,
    forceRls: security.rows[0]?.relforcerowsecurity,
    nativeType: native.rows[0]?.native_type,
    nativeNullable: native.rows[0]?.native_nullable,
    sourceKeyType: native.rows[0]?.source_key_type,
    sourceKeyNullable: native.rows[0]?.source_key_nullable,
    sourceKeyUnique: native.rows[0]?.source_key_unique,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
  const { Client } = require("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    if (!process.env.DATABASE_URL) throw new Error("Database configuration required");
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const report = await checkMeetingUsageSchema(client);
    await client.query("COMMIT");
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Read-only meeting/usage metadata check failed; no database changes were made.");
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
