/** Rollback-only development SQL regression. Never inserts a real staff grant. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type dbAdmin } from "@workspace/db";
import { googleMeetRecordingStore } from "../src/lib/google-meet-recording-store";

assert.notEqual(process.env.NODE_ENV, "production");
assert.ok(process.env.MEET_RECORDING_TEST_DB_CONFIRM, "Development target confirmation required.");
const client = await pool.connect();
let checks = 0;
try {
  const target = await client.query(
    "SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text,'local')) AS hash",
  );
  assert.equal(target.rows[0].hash, process.env.MEET_RECORDING_TEST_DB_CONFIRM);
  await drizzle(client)
    .transaction(async (tx) => {
      const security = await client.query(`SELECT relrowsecurity, relforcerowsecurity,
    NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid) AS no_policies,
    NOT has_table_privilege('lexy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS no_app_access,
    NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) WHERE grantee = 0) AS no_public_access
    FROM pg_class c WHERE oid = 'public.staff_google_meet_recordings'::regclass`);
      assert.deepEqual(security.rows, [
        {
          relrowsecurity: true,
          relforcerowsecurity: true,
          no_policies: true,
          no_app_access: true,
          no_public_access: true,
        },
      ]);
      checks++;
      await client.query(
        "CREATE TEMP TABLE staff_google_meet_recordings (LIKE public.staff_google_meet_recordings INCLUDING ALL) ON COMMIT DROP",
      );
      const store = googleMeetRecordingStore(tx as unknown as typeof dbAdmin);
      const actor = { id: "fixture-meet-staff", tenantId: "fixture-meet-employer" };
      const foreign = { ...actor, tenantId: "foreign-employer" };
      const revision = randomUUID();
      const flow = {
        revision,
        clientFingerprint: "fixture-fingerprint",
        flowHash: "fixture-state",
        browserHash: "fixture-browser",
        verifierEnc: "fixture-ciphertext",
        nonceHash: "fixture-nonce",
        flowExpiresAt: new Date(Date.now() + 600_000),
      };
      await store.begin(actor, flow);
      assert.equal(await store.get(foreign), undefined);
      checks++;
      assert.equal(
        await store.consume(foreign, flow.flowHash, flow.browserHash, new Date()),
        undefined,
      );
      checks++;
      assert.equal(
        await store.consume(actor, flow.flowHash, "wrong-browser", new Date()),
        undefined,
      );
      checks++;
      assert.equal(
        (await store.consume(actor, flow.flowHash, flow.browserHash, new Date()))?.revision,
        revision,
      );
      checks++;
      assert.equal(
        await store.consume(actor, flow.flowHash, flow.browserHash, new Date()),
        undefined,
      );
      checks++;
      const grant = {
        subject: "fixture-subject",
        accountEmail: "fixture@example.invalid",
        refreshTokenEnc: "fixture-enc-refresh",
        connectedAt: new Date(),
      };
      assert.equal(await store.bind(foreign, revision, grant), false);
      checks++;
      assert.equal(await store.bind(actor, randomUUID(), grant), false);
      checks++;
      assert.equal(await store.bind(actor, revision, grant), true);
      checks++;
      const connected = (await store.get(actor))!;
      assert.notEqual(connected.revision, revision);
      checks++;
      assert.equal(
        await store.rotate(foreign, connected.revision, grant.refreshTokenEnc, "next-fixture"),
        false,
      );
      checks++;
      assert.equal(
        await store.rotate(actor, connected.revision, "wrong-previous", "next-fixture"),
        false,
      );
      checks++;
      assert.equal(
        await store.rotate(actor, connected.revision, grant.refreshTokenEnc, "next-fixture"),
        true,
      );
      checks++;
      assert.equal(await store.clear(actor, revision), false);
      checks++;
      assert.equal(await store.clear(foreign, connected.revision), false);
      checks++;
      assert.equal(await store.clear(actor, connected.revision), true);
      checks++;
      assert.equal(
        await store.rotate(actor, connected.revision, "next-fixture", "resurrect-fixture"),
        false,
      );
      checks++;
      assert.equal((await store.get(actor))!.refreshTokenEnc, null);
      checks++;
      for (const sql of [
        "UPDATE pg_temp.staff_google_meet_recordings SET refresh_token_enc = 'incomplete'",
        "UPDATE pg_temp.staff_google_meet_recordings SET flow_hash = 'incomplete'",
      ]) {
        await client.query("SAVEPOINT negative_fixture");
        await assert.rejects(
          client.query(sql),
          (error: unknown) => (error as { code?: string }).code === "23514",
        );
        await client.query("ROLLBACK TO SAVEPOINT negative_fixture");
        checks++;
      }
      await client.query("SAVEPOINT role_fixture");
      await client.query("SET LOCAL ROLE lexy_app");
      await assert.rejects(
        client.query("SELECT * FROM public.staff_google_meet_recordings LIMIT 0"),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );
      await client.query("ROLLBACK TO SAVEPOINT role_fixture");
      checks++;
      const onlyTemp = await client.query(
        "SELECT bool_and(tableoid = 'pg_temp.staff_google_meet_recordings'::regclass) AS isolated FROM pg_temp.staff_google_meet_recordings",
      );
      assert.equal(onlyTemp.rows[0].isolated, true);
      checks++;
      process.stdout.write(`PASS ${checks} rollback-only Meet recording storage/security checks\n`);
      // Force rollback of the entire fixture, including the temporary table.
      throw new Error("fixture-rollback");
    })
    .catch((error: Error) => {
      if (error.message !== "fixture-rollback") throw error;
    });
} finally {
  client.release();
  await pool.end();
}
