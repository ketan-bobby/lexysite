/**
 * A private schema shared by independent test transactions. Unlike TEMP tables,
 * it permits genuine multi-connection row-lock/capacity races. No public
 * fallback is allowed. All fixture connections and the owned schema are removed.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock } from "node:test";
import { getTableName, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db";

export async function createTransactionalDb(
  tables: Table[],
  options: { requestContext?: boolean } = {},
) {
  const name = `fixture_pilot_${crypto.randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^fixture_pilot_[a-f0-9]{32}$/);
  const maintenance = await schema.pool.connect();
  let created = false;
  try {
    await maintenance.query(`CREATE SCHEMA "${name}"`);
    created = true;
    // Preserve enum assignment semantics without adding public to search_path.
    // A domain is an alias of the existing enum, not a different enum type.
    await maintenance.query(`CREATE DOMAIN "${name}".tenant_plan AS public.tenant_plan`);
    // Reporting predicates read these server-owned identity audits. Clone the
    // dependency too rather than permitting any fallback into public data.
    const dependencies = tables.includes(schema.candidatesTable)
      ? [schema.recruitingWorkflowsTable, schema.recruitingWorkflowEventsTable]
      : [];
    for (const table of new Set([...tables, ...dependencies])) {
      const tableName = getTableName(table);
      assert.match(tableName, /^[a-z_]+$/);
      await maintenance.query(
        `CREATE TABLE "${name}"."${tableName}" (LIKE public."${tableName}" INCLUDING ALL)`,
      );
    }
    const connect = async () => {
      const client = await schema.pool.connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      try {
        await query(`SET search_path = "${name}", pg_catalog`);
      } catch (error) {
        release(true);
        throw error;
      }
      client.query = ((...args: unknown[]) => {
        const text =
          typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        assert.ok(
          !/(?:"public"|\bpublic)\s*\./i.test(text),
          "Transactional fixture attempted to escape into public data",
        );
        return (query as any)(...args);
      }) as typeof client.query;
      // Never return a modified search_path session to a reusable connection.
      client.release = () => release(true);
      return client;
    };
    const isolatedPool = new Proxy(schema.pool, {
      get(target, property) {
        if (property === "connect") return connect;
        if (property === "query")
          return async (...args: unknown[]) => {
            const client = await connect();
            try {
              return await (client.query as any)(...args);
            } finally {
              client.release();
            }
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = drizzle(isolatedPool);
    mock.module("@workspace/db", {
      namedExports: {
        ...schema,
        pool: isolatedPool,
        db: options.requestContext ? schema.db : db,
        dbAdmin: db,
        controlDb: db,
        forRegion: () => db,
      },
    });
    return {
      db,
      pool: isolatedPool,
      schemaName: name,
      async close() {
        try {
          await maintenance.query(`DROP SCHEMA "${name}" CASCADE`);
        } finally {
          maintenance.release(true);
          await schema.pool.end();
        }
      },
    };
  } catch (error) {
    try {
      if (created) await maintenance.query(`DROP SCHEMA "${name}" CASCADE`);
    } finally {
      maintenance.release(true);
      await schema.pool.end();
    }
    throw error;
  }
}
