import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@workspace/db";
import * as schema from "../../../lib/db/src/schema/index";
import { googleStaffStore, clearedGoogleGrant } from "../src/lib/google-staff-store";

// Must match the existing development-handle identity query, not an assumed URL.
const identity = `SELECT md5(current_database() || '|' ||
 COALESCE(inet_server_addr()::text,'local') || '|' ||
 COALESCE(inet_server_port()::text,'0') || '|' ||
 EXTRACT(EPOCH FROM pg_postmaster_start_time())::text) AS development_fingerprint`;
const expected = process.argv[2],
  apply = process.argv[3] === "--apply";
assert.match(
  expected ?? "",
  /^[a-f0-9]{32}$/,
  "Pass the fingerprint obtained through the explicit development handle.",
);
assert.ok(process.argv.length === 3 || (apply && process.argv.length === 4));
const client = await pool.connect();
const namespace = `google_staff_fixture_${randomUUID().replaceAll("-", "")}`;
const migration = await readFile(
  new URL("../../../lib/db/drizzle/0087_staff_google_calendars.sql", import.meta.url),
  "utf8",
);
const invitationMigration = await readFile(
  new URL("../../../lib/db/drizzle/0088_google_interview_invitations.sql", import.meta.url),
  "utf8",
);
let committed = false;
try {
  const actual = (await client.query(identity)).rows[0]?.development_fingerprint;
  assert.equal(
    actual,
    expected,
    "Application pool does not match the verified development instance; no DDL performed.",
  );
  if (apply) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    await client.query(migration);
    await client.query(invitationMigration);
    const result = (
      await client.query(`SELECT relrowsecurity,relforcerowsecurity,
      has_table_privilege('lexy_app','public.staff_google_calendars','SELECT,INSERT,UPDATE,DELETE') AS application_access
      FROM pg_class WHERE oid='public.staff_google_calendars'::regclass`)
    ).rows[0];
    assert.equal(result?.relrowsecurity, true);
    assert.equal(result.relforcerowsecurity, true);
    assert.equal(result.application_access, false);
    await client.query("COMMIT");
    committed = true;
    console.log(
      "Verified-development migration applied: forced RLS; application-role access revoked.",
    );
  } else {
    const complete = new Error("rollback_fixture_complete");
    try {
      await drizzle(client, { schema }).transaction(async (tx) => {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
        await client.query(
          `CREATE SCHEMA "${namespace}"; SET LOCAL search_path="${namespace}",public`,
        );
        await client.query("CREATE TABLE users(id text PRIMARY KEY)");
        await client.query(migration);
        // Only the staff-table additive prefix is relevant to this private repository fixture.
        await client.query(
          invitationMigration.split("ALTER TABLE interview_calendar_invitation_attempts")[0],
        );
        await client.query(
          "CREATE TABLE calendar_working_hours(user_id text PRIMARY KEY,tenant_id text,revision text,time_zone text,windows jsonb,updated_at timestamptz)",
        );
        await client.query("INSERT INTO users VALUES ('fixture-self'),('fixture-other')");
        const store = googleStaffStore(tx),
          actor = { id: "fixture-self", tenantId: "employer-a" };
        const revision = randomUUID();
        const flow = {
          revision,
          clientFingerprint: "fixture",
          flowHash: "fixture-state",
          browserHash: "fixture-browser",
          verifierEnc: "synthetic-verifier-envelope",
          nonceHash: "fixture-nonce",
          flowExpiresAt: new Date(Date.now() + 60_000),
          flowInvitations: false,
        };
        await store.begin(actor, flow);
        assert.equal(await store.get({ ...actor, id: "fixture-other" }), undefined);
        assert.equal(await store.get({ ...actor, tenantId: "employer-b" }), undefined);
        assert.equal(
          await store.consume(
            { ...actor, tenantId: "employer-b" },
            flow.flowHash,
            flow.browserHash,
            new Date(),
          ),
          undefined,
        );
        assert.equal(
          await store.consume(actor, flow.flowHash, "wrong-browser", new Date()),
          undefined,
        );
        assert.ok(await store.consume(actor, flow.flowHash, flow.browserHash, new Date()));
        assert.equal(
          await store.consume(actor, flow.flowHash, flow.browserHash, new Date()),
          undefined,
        );
        assert.equal(
          await store.bind(actor, revision, {
            subject: "synthetic-sub",
            accountEmail: "fixture@example.test",
            refreshTokenEnc: "synthetic-encrypted-token",
            connectedAt: new Date(),
            invitationConsent: false,
          }),
          true,
        );
        const bound = (await store.get(actor))!;
        assert.notEqual(bound.revision, revision);
        assert.equal(
          await store.clear({ ...actor, tenantId: "employer-b" }, bound.revision),
          false,
        );
        assert.equal(await store.clear(actor, revision), false);
        assert.equal(await store.clear(actor, bound.revision), true);
        assert.equal(
          await store.rotate(actor, bound.revision, "synthetic-encrypted-token", "late-token"),
          false,
        );
        assert.equal(await store.bind(actor, bound.revision, { ...clearedGoogleGrant }), false);
        assert.equal((await store.get(actor))!.refreshTokenEnc, null);
        assert.equal(await store.allows(actor, Date.now(), Date.now() + 60_000), true);
        const privilege = (
          await client.query(
            "SELECT has_table_privilege('lexy_app',$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed",
            [`"${namespace}".staff_google_calendars`],
          )
        ).rows[0];
        assert.equal(privilege.allowed, false);
        await client.query(`GRANT USAGE ON SCHEMA "${namespace}" TO lexy_app`);
        await client.query("SAVEPOINT denied_role");
        await client.query("SET LOCAL ROLE lexy_app");
        try {
          await client.query(`SELECT * FROM "${namespace}".staff_google_calendars`);
          assert.fail("Application role unexpectedly read private credentials");
        } catch (error) {
          assert.equal((error as { code?: string }).code, "42501");
        }
        await client.query("ROLLBACK TO SAVEPOINT denied_role");
        throw complete;
      });
    } catch (error) {
      if (error !== complete) throw error;
    }
    console.log(
      "Verified-development rollback fixture passed: self/employer predicates, replay, CAS/revocation and private-role denial.",
    );
  }
} finally {
  if (!committed && apply) await client.query("ROLLBACK");
  const remaining = (await client.query("SELECT to_regnamespace($1) IS NULL AS clean", [namespace]))
    .rows[0]?.clean;
  assert.equal(remaining, true, "Fixture schema leaked.");
  client.release();
  await pool.end();
}
