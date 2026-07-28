/**
 * linx-requests-rls.test.ts — LIVE proof of the dual-tenant isolation seal on
 * linx_requests (migration 0050). Not a unit test with fakes: it connects to
 * the real dev database, switches to the `lexy_app` role, sets the tenant GUC
 * exactly as withTenantContext does, and asserts the policy:
 *
 *   (a) originating tenant sees ONLY its own rows
 *   (b) the LINX tenant sees ONLY rows targeting it
 *   (c) any third tenant sees NOTHING and cannot insert cross-tenant rows
 *
 * Everything runs inside one transaction that is ALWAYS rolled back — no
 * residue. Skips (loudly) if DATABASE_URL is unset or the table/role is
 * missing (i.e. migration 0050 not applied yet).
 *
 * NOTE: dev strips RLS on most tables, but 0050 was applied with its policy
 * intact — this test is the "tested, not assumed" guarantee. API routes must
 * STILL carry an explicit dual-tenant predicate (dev/prod belt-and-braces).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const url = process.env.DATABASE_URL;

describe("linx_requests dual-tenant RLS isolation (live DB)", { skip: !url ? "DATABASE_URL not set" : false }, () => {
  let client: pg.Client;
  let ready = false;

  before(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    const chk = await client.query(
      `SELECT EXISTS(SELECT 1 FROM pg_class WHERE relname='linx_requests') AS t,
              EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lexy_app') AS r,
              EXISTS(SELECT 1 FROM pg_policies WHERE tablename='linx_requests') AS p`,
    );
    ready = chk.rows[0].t && chk.rows[0].r && chk.rows[0].p;
    if (!ready) return;
    await client.query("BEGIN");
    await client.query("SET LOCAL app.allowed_tenant_ids = ''");
    await client.query(
      `INSERT INTO linx_requests (id, tenant_id, job_id, requested_by_user_id, contact_name, contact_email, linx_tenant_id)
       VALUES ('rls-t-r1','rls-client-A','rls-job-1','u1','Pat','pat@a.test','rls-linx-T'),
              ('rls-t-r2','rls-client-B','rls-job-2','u2','Sam','sam@b.test','rls-linx-T')`,
    );
    await client.query("SET LOCAL ROLE lexy_app");
  });

  after(async () => {
    try { await client?.query("ROLLBACK"); } catch { /* already closed */ }
    await client?.end();
  });

  const as = async (tenants: string) => {
    await client.query(`SET LOCAL app.allowed_tenant_ids = '${tenants}'`);
  };

  test("migration 0050 applied (table + role + policy present)", () => {
    assert.ok(ready, "linx_requests table, lexy_app role, or RLS policy missing — apply lib/db/drizzle/0050_linx_requests.sql");
  });

  test("originating tenant sees only its own rows", async t => {
    if (!ready) return t.skip();
    await as("rls-client-A");
    const r = await client.query("SELECT id FROM linx_requests WHERE id LIKE 'rls-t-%' ORDER BY id");
    assert.deepEqual(r.rows.map(x => x.id), ["rls-t-r1"]);
  });

  test("LINX tenant sees all rows targeting it", async t => {
    if (!ready) return t.skip();
    await as("rls-linx-T");
    const r = await client.query("SELECT id FROM linx_requests WHERE id LIKE 'rls-t-%' ORDER BY id");
    assert.deepEqual(r.rows.map(x => x.id), ["rls-t-r1", "rls-t-r2"]);
  });

  test("unrelated third tenant sees nothing", async t => {
    if (!ready) return t.skip();
    await as("rls-client-C");
    const r = await client.query("SELECT id FROM linx_requests WHERE id LIKE 'rls-t-%'");
    assert.equal(r.rows.length, 0);
  });

  test("third tenant cannot insert a row pointing at other tenants", async t => {
    if (!ready) return t.skip();
    await as("rls-client-C");
    await client.query("SAVEPOINT sp");
    await assert.rejects(
      client.query(
        `INSERT INTO linx_requests (id, tenant_id, job_id, requested_by_user_id, contact_name, contact_email, linx_tenant_id)
         VALUES ('rls-t-r3','rls-client-A','rls-job-3','u3','Eve','eve@c.test','rls-linx-T')`,
      ),
      /row-level security/,
    );
    await client.query("ROLLBACK TO sp");
  });

  test("LINX-scoped session cannot mint requests 'from' client tenants", async t => {
    if (!ready) return t.skip();
    await as("rls-linx-T");
    await client.query("SAVEPOINT sp_ins");
    await assert.rejects(
      client.query(
        `INSERT INTO linx_requests (id, tenant_id, job_id, requested_by_user_id, contact_name, contact_email, linx_tenant_id)
         VALUES ('rls-t-r5','rls-client-A','rls-job-5','u5','Lin','lin@l.test','rls-linx-T')`,
      ),
      /row-level security/,
    );
    await client.query("ROLLBACK TO sp_ins");
  });

  test("LINX tenant CAN progress workflow status (accept)", async t => {
    if (!ready) return t.skip();
    await as("rls-linx-T");
    const r = await client.query(
      `UPDATE linx_requests SET status='accepted', responded_at=now() WHERE id='rls-t-r1' RETURNING status`,
    );
    assert.equal(r.rows[0]?.status, "accepted");
  });

  test("ownership columns are frozen after insert (trigger)", async t => {
    if (!ready) return t.skip();
    await as("rls-linx-T");
    await client.query("SAVEPOINT sp_own");
    await assert.rejects(
      client.query(`UPDATE linx_requests SET linx_tenant_id='rls-linx-EVIL' WHERE id='rls-t-r1'`),
      /ownership columns are immutable/,
    );
    await client.query("ROLLBACK TO sp_own");
    await as("rls-client-A");
    await client.query("SAVEPOINT sp_own2");
    await assert.rejects(
      client.query(`UPDATE linx_requests SET tenant_id='rls-client-B' WHERE id='rls-t-r1'`),
      /ownership columns are immutable|row-level security/,
    );
    await client.query("ROLLBACK TO sp_own2");
  });

  test("only the originating tenant can delete (withdraw) its request", async t => {
    if (!ready) return t.skip();
    await as("rls-linx-T");
    const denied = await client.query(`DELETE FROM linx_requests WHERE id='rls-t-r2'`);
    assert.equal(denied.rowCount, 0, "LINX must not be able to delete client requests");
    await as("rls-client-B");
    const ok = await client.query(`DELETE FROM linx_requests WHERE id='rls-t-r2'`);
    assert.equal(ok.rowCount, 1);
  });

  test("status CHECK constraint rejects unknown workflow states", async t => {
    if (!ready) return t.skip();
    await as("rls-client-A");
    await client.query("SAVEPOINT sp2");
    await assert.rejects(
      client.query(
        `INSERT INTO linx_requests (id, tenant_id, job_id, requested_by_user_id, contact_name, contact_email, linx_tenant_id, status)
         VALUES ('rls-t-r4','rls-client-A','rls-job-4','u4','Pat','pat@a.test','rls-linx-T','paid')`,
      ),
      /linx_requests_status_check/,
    );
    await client.query("ROLLBACK TO sp2");
  });
});
