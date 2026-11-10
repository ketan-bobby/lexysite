import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, schema } from "@workspace/db";
import { meteredFetch, persistUsageAttempt } from "./vendor-usage";
import { withUsageActivity } from "./vendor-usage-context";

after(() => pool.end());

test("upgrade from original ledger persists fake receipts, freezes dimensions, and denies app-role reads", async () => {
  const connection = await pool.connect();
  const namespace = `economics_${randomUUID().replaceAll("-", "")}`;
  try {
    await connection.query("BEGIN");
    await connection.query(`CREATE SCHEMA "${namespace}"`);
    await connection.query(`SET LOCAL search_path = "${namespace}", public`);
    await connection.query(`CREATE TABLE "${namespace}".tenants
      (id text PRIMARY KEY, parent_id text, country text, plan text)`);
    await connection.query(
      "INSERT INTO tenants VALUES ('root',NULL,'IN','enterprise'), ('child','root','IN','starter')",
    );
    for (const name of [
      "0072_vendor_usage_attempts.sql",
      "0074_workflow_vendor_usage_labels.sql",
      "0075_native_sourcing_usage_labels.sql",
      "0076_usage_economics_labels.sql",
    ]) {
      const migration = (
        await readFile(new URL(`../../../../lib/db/drizzle/${name}`, import.meta.url), "utf8")
      )
        .replace(/^BEGIN;\s*$/gm, "")
        .replace(/^COMMIT;\s*$/gm, "");
      await connection.query(migration);
    }
    const database = drizzle(connection, { schema });
    const fetcher = meteredFetch(
      "openai_direct",
      async () => {
        // A plan change during the call must not rewrite the original dimensions.
        await connection.query("UPDATE tenants SET country='US',plan='growth' WHERE id='root'");
        return new Response(
          JSON.stringify({
            model: "gpt-4o-2024-08-06",
            usage: {
              prompt_tokens: 60,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 8 },
            },
            choices: [{ message: { content: "private-synthetic-answer" } }],
          }),
          { headers: { "content-type": "application/json", "x-request-id": "synthetic-request" } },
        );
      },
      (attempt) => persistUsageAttempt(attempt, database),
      { accountRef: "synthetic-account" },
    );
    await withUsageActivity("child", "development_private", () =>
      fetcher("https://fixture.invalid/chat/completions", {
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ content: "private-synthetic-prompt" }],
        }),
      }),
    );
    const receipts = await connection.query("SELECT * FROM vendor_usage_attempts");
    assert.equal(receipts.rows.length, 1);
    const receipt = receipts.rows[0];
    assert.equal(receipt.area, "activity:development_private");
    assert.equal(receipt.tenant_id, "child");
    assert.equal(receipt.units.billing_root_id, "root");
    assert.equal(receipt.units.billing_country, "IN");
    assert.equal(receipt.units.billing_plan, "enterprise");
    assert.equal(receipt.units.input_tokens, 60);
    assert.equal(receipt.units.returned_model, "gpt-4o-2024-08-06");
    assert.equal(receipt.units.account_ref, "synthetic-account");
    assert.equal(receipt.cost_status, "unknown");
    assert.equal(JSON.stringify(receipt).includes("private-synthetic"), false);
    await connection.query("SAVEPOINT invalid_label");
    await assert.rejects(
      connection.query(
        "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status) VALUES ('bad','activity:raw-candidate-name','fixture','chat','started')",
      ),
      (error: any) => error.code === "23514",
    );
    await connection.query("ROLLBACK TO SAVEPOINT invalid_label");
    const security = await connection.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
      [`${namespace}.vendor_usage_attempts`],
    );
    assert.equal(security.rows[0].relrowsecurity, true);
    assert.equal(security.rows[0].relforcerowsecurity, true);
    const policies = await connection.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname=$1 AND tablename='vendor_usage_attempts'",
      [namespace],
    );
    assert.equal(policies.rows[0].n, 0);
    await connection.query("SAVEPOINT app_role");
    await connection.query(`SET LOCAL ROLE lexy_app`);
    try {
      const visible = await connection.query(`SELECT * FROM "${namespace}".vendor_usage_attempts`);
      assert.equal(visible.rows.length, 0);
    } catch (error: any) {
      assert.equal(error.code, "42501");
    }
    await connection.query("ROLLBACK TO SAVEPOINT app_role");
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});
