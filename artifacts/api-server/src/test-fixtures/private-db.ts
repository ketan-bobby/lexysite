/**
 * Real PostgreSQL constraints, isolated from every normal app connection.
 * Call before importing modules that capture @workspace/db exports.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { getTableName, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db";

export async function createPrivateDb(tables: Table[]) {
  const client = await schema.pool.connect();
  const query = client.query.bind(client);
  let isolated = false;
  let tail: Promise<unknown> = Promise.resolve();
  client.query = ((...args: unknown[]) => {
    const text =
      typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
    assert.ok(
      !isolated || !/(?:"public"|\bpublic)\s*\./i.test(text),
      "Fixture query attempted to escape into public tables",
    );
    const result = tail.then(() => (query as any)(...args));
    tail = result.catch(() => undefined);
    return result;
  }) as typeof client.query;
  try {
    for (const table of new Set(tables)) {
      const name = getTableName(table);
      assert.match(name, /^[a-z_]+$/);
      await client.query(`CREATE TEMP TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`);
    }
    await client.query("SET search_path = pg_temp");
    isolated = true;
    const db = drizzle(client);
    mock.module("@workspace/db", {
      namedExports: { ...schema, db, dbAdmin: db, controlDb: db, forRegion: () => db },
    });
    return {
      db,
      async close() {
        client.release(true);
        await schema.pool.end();
      },
    };
  } catch (error) {
    client.release(true);
    await schema.pool.end();
    throw error;
  }
}
