/** Explicitly acknowledged DEVELOPMENT metadata fixtures; never part of ordinary unit tests. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAdmin } from "@workspace/db";
import { sql } from "drizzle-orm";
import { storage } from "./calendar-panel-access";

const expected = process.argv[2];
if (!expected || !/^[a-f0-9]{32}$/.test(expected) || process.env.REPLIT_DEPLOYMENT === "1")
  throw new Error(
    "Supply the fingerprint confirmed through the explicit development database handle.",
  );
const identity = await dbAdmin.execute(sql`
  SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text,'local') ||
    ':' || coalesce(inet_server_port()::text,'local')) AS fingerprint
`);
assert.equal(
  identity.rows[0]?.fingerprint,
  expected,
  "Unconfirmed development target; refusing fixtures.",
);
const schema = `gp_fixture_${randomUUID().replaceAll("-", "")}`;
const table = sql.identifier(`${schema}`);
const qualified = sql`${table}.${sql.identifier("sharing")}`;
const rollback = new Error("rollback-fixture");
let checks = 0;
try {
  await dbAdmin.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA ${table}`);
    await tx.execute(sql`CREATE TABLE ${qualified} (user_id text)`);
    await tx.execute(sql`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`);
    await tx.execute(sql`REVOKE ALL ON TABLE ${qualified} FROM PUBLIC, lexy_app`);
    await storage(tx, `${schema}.sharing`);
    checks++;
    await assert.rejects(storage(tx, `${schema}.missing`));
    checks++;
    await tx.execute(sql`GRANT SELECT(user_id) ON TABLE ${qualified} TO PUBLIC`);
    await assert.rejects(storage(tx, `${schema}.sharing`));
    checks++;
    await tx.execute(sql`REVOKE SELECT(user_id) ON TABLE ${qualified} FROM PUBLIC`);
    await tx.execute(sql`CREATE POLICY exposed ON ${qualified} FOR SELECT USING (true)`);
    await assert.rejects(storage(tx, `${schema}.sharing`));
    checks++;
    await tx.execute(sql`DROP POLICY exposed ON ${qualified}`);
    await tx.execute(sql`ALTER TABLE ${qualified} NO FORCE ROW LEVEL SECURITY`);
    await assert.rejects(storage(tx, `${schema}.sharing`));
    checks++;
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
}
const cleanup = await dbAdmin.execute(
  sql`SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=${schema}`,
);
assert.equal(cleanup.rows[0]?.count, 0, "Fixture namespace escaped rollback.");
await dbAdmin.transaction(async (tx) => {
  await storage(tx, "google_panel_consents");
  await storage(tx, "staff_google_calendars");
});
process.stdout.write(
  `Google panel SQL: ${checks} metadata checks passed; fixture rolled back; public receipt tables remain private.\n`,
);
process.exit(0);
