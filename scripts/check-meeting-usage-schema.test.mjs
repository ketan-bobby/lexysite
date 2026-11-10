import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectedUsageArea,
  meetingUsageSchemaReport,
  checkMeetingUsageSchema,
} from "./check-meeting-usage-schema.mjs";

const current = {
  byteSizeCheck: "CHECK (((byte_size > 0) AND (byte_size <= 104857600)))",
  byteSizeValidated: true,
  speakerType: "jsonb",
  speakerNullable: "YES",
  area: expectedUsageArea,
  cost: "CHECK ((cost_status = 'unknown'::text))",
  rls: true,
  forceRls: true,
  nativeType: "jsonb",
  nativeNullable: "YES",
  sourceKeyType: "text",
  sourceKeyNullable: "YES",
  sourceKeyUnique: true,
};
test("current meeting evidence and observation schema is ready without changing unknown cost", () => {
  assert.equal(meetingUsageSchemaReport(current).passed, true);
});
test("missing speaker migration, stale usage labels and weakened row security fail readiness", () => {
  for (const patch of [
    { byteSizeCheck: undefined },
    { byteSizeCheck: "CHECK (((byte_size > 0) AND (byte_size <= 52428800)))" },
    { byteSizeCheck: "CHECK (true)" },
    { byteSizeValidated: false },
    { speakerType: undefined },
    { speakerType: "text" },
    { speakerNullable: "NO" },
    { area: expectedUsageArea.replace("'activity:recruiter'", "'activity:missing'") },
    { area: `${expectedUsageArea} OR true` },
    { cost: "CHECK (true)" },
    { rls: false },
    { forceRls: false },
    { nativeType: undefined },
    { nativeNullable: "NO" },
    { sourceKeyType: "jsonb" },
    { sourceKeyUnique: false },
  ])
    assert.equal(meetingUsageSchemaReport({ ...current, ...patch }).passed, false);
});
test("metadata checker issues only bounded catalog reads and does not select source material", async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes("meeting_notes_byte_size_check"))
        return { rows: [{ definition: current.byteSizeCheck, convalidated: true }] };
      if (sql.includes("source_key_unique"))
        return {
          rows: [
            {
              native_type: "jsonb",
              native_nullable: "YES",
              source_key_type: "text",
              source_key_nullable: "YES",
              source_key_unique: true,
            },
          ],
        };
      if (sql.includes("information_schema.columns"))
        return { rows: [{ data_type: "jsonb", is_nullable: "YES" }] };
      if (sql.includes("pg_constraint"))
        return {
          rows: [
            { conname: "vendor_usage_attempts_area_check", definition: expectedUsageArea },
            { conname: "vendor_usage_attempts_cost_status_check", definition: current.cost },
          ],
        };
      return { rows: [{ relrowsecurity: true, relforcerowsecurity: true }] };
    },
  };
  assert.equal((await checkMeetingUsageSchema(client)).passed, true);
  assert.equal(queries.length, 5);
  for (const sql of queries) {
    assert.match(sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(
      sql,
      /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|transcript|speaker_evidence\s+FROM|units\s+FROM)\b/i,
    );
  }
});
