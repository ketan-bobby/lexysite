import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atsSchemaInspection, requiredSchemaCheckNames } from "./check-recent-db-schema.mjs";
import { developmentFingerprintSql } from "./recent-db-schema-sql-fixture.mjs";

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const identifier = (value) => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/);
  return `"${value}"`;
};
const stub = (fn) =>
  fn.language === "sql"
    ? "SELECT false"
    : `BEGIN ${fn.return_type === "trigger" ? "RETURN NEW;" : fn.return_type === "boolean" ? "RETURN false;" : "RETURN;"} END;`;

/** Generates SQL only. Empty private tables and harmless function stubs, never live ATS objects. */
export function buildAtsSchemaAuditFixture(developmentFingerprint) {
  assert.match(developmentFingerprint ?? "", /^[0-9a-f]{32}$/);
  const namespace = `lexy_ats_audit_${randomUUID().replaceAll("-", "")}`;
  const shadow = `${namespace}_shadow`;
  const q = (name, schema = namespace) => `${identifier(schema)}.${identifier(name)}`;
  const { contract, query } = atsSchemaInspection();
  // Exercise catalog semantics, not hiring/erasure code. Only the test-local
  // expected bodies change; operational contracts and migrations remain intact.
  contract.functions = contract.functions.map((fn) => ({ ...fn, body: stub(fn) }));
  contract.ats_functions = contract.ats_functions.map((fn) => ({ ...fn, body: stub(fn) }));
  contract.indexes = contract.indexes.map((index) => ({
    ...index,
    definition: index.definition.replace(" ON public.", ` ON ${namespace}.`),
  }));
  const ddl = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '60s';",
    "SET LOCAL lock_timeout = '2s';",
    `DO $target$ BEGIN
      IF (${developmentFingerprintSql}) IS DISTINCT FROM ${literal(developmentFingerprint)}
      THEN RAISE EXCEPTION 'Development target mismatch; no fixture objects were created'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname='lexy_app' AND NOT rolsuper AND NOT rolbypassrls)
      THEN RAISE EXCEPTION 'Fixture requires a privileged development owner and restricted request role';
      END IF;
    END $target$;`,
    `CREATE SCHEMA ${identifier(namespace)};`,
    `REVOKE ALL ON SCHEMA ${identifier(namespace)} FROM PUBLIC, lexy_app;`,
    `SET LOCAL search_path=pg_catalog,${identifier(namespace)};`,
    `CREATE TABLE ${q("candidates")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("users")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("jobs")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("interview_plans")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("recruiting_workflows")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("applications")} (id text, candidate_id text, job_id text);`,
    `CREATE TABLE ${q("sourced_candidates")} (id text, normalized_candidate_id text, raw_data jsonb);`,
  ];
  const types = new Map([
    ["text", "text"],
    ["int4", "integer"],
    ["timestamptz", "timestamptz"],
    ["jsonb", "jsonb"],
    ["_text", "text[]"],
  ]);
  for (const table of contract.tables) {
    const fields = contract.columns
      .filter((column) => column.table_name === table.name)
      .map((column) => {
        assert.ok(types.has(column.data_type));
        return `${identifier(column.column_name)} ${types.get(column.data_type)}${column.required ? " NOT NULL" : ""}${column.default_sql ? ` DEFAULT ${column.default_sql}` : ""}`;
      });
    ddl.push(
      `CREATE TABLE ${q(table.name)} (${fields.join(", ")});`,
      `ALTER TABLE ${q(table.name)} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE ${q(table.name)} FORCE ROW LEVEL SECURITY;`,
      `REVOKE ALL ON ${q(table.name)} FROM PUBLIC, lexy_app;`,
    );
  }
  for (const constraint of contract.constraints)
    ddl.push(
      `ALTER TABLE ${q(constraint.table_name)} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition};`,
    );
  ddl.push(...contract.indexes.map((index) => `${index.definition};`));
  for (const fn of contract.functions)
    ddl.push(`CREATE FUNCTION ${q(fn.name)}(${fn.args}) RETURNS ${fn.return_type}
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
      AS $stub$${fn.body}$stub$;`);
  const functionSql = (fn, schema = namespace) => {
    assert.ok(["plpgsql", "sql"].includes(fn.language));
    assert.ok(
      ["", "search_path=pg_catalog", "search_path=pg_catalog,public"].includes(fn.search_path),
    );
    return `CREATE OR REPLACE FUNCTION ${q(fn.name, schema)}(${fn.args}) RETURNS ${fn.return_type}
      LANGUAGE ${fn.language} SECURITY ${fn.definer ? "DEFINER" : "INVOKER"}
      ${fn.search_path ? `SET search_path=${fn.search_path.slice("search_path=".length)}` : ""}
      AS $stub$${fn.body}$stub$;`;
  };
  const grantsSql = (fn, schema = namespace) => [
    `REVOKE ALL ON FUNCTION ${q(fn.name, schema)}(${fn.args}) FROM PUBLIC, lexy_app;`,
    ...(fn.public_execute
      ? [`GRANT EXECUTE ON FUNCTION ${q(fn.name, schema)}(${fn.args}) TO PUBLIC;`]
      : []),
    ...(fn.request_execute
      ? [`GRANT EXECUTE ON FUNCTION ${q(fn.name, schema)}(${fn.args}) TO lexy_app;`]
      : []),
  ];
  for (const fn of contract.ats_functions) ddl.push(functionSql(fn), ...grantsSql(fn));
  const triggerSql = (trigger, options = {}) => {
    const events =
      trigger.type === 19
        ? "UPDATE"
        : trigger.type === 27
          ? "UPDATE OR DELETE"
          : `INSERT OR UPDATE${trigger.columns.length ? ` OF ${trigger.columns.map(identifier).join(",")}` : ""}`;
    return `CREATE OR REPLACE TRIGGER ${identifier(trigger.name)}
      ${options.timing ?? "BEFORE"} ${options.events ?? events} ON ${q(trigger.table_name)}
      FOR EACH ROW ${options.when ?? ""} EXECUTE FUNCTION
      ${q(options.fn ?? trigger.function_name, options.schema ?? namespace)}(${options.args ?? ""});`;
  };
  for (const trigger of contract.ats_triggers) ddl.push(triggerSql(trigger));
  for (const trigger of contract.triggers)
    ddl.push(`CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE
      ON ${q(trigger.table_name)} FOR EACH ROW EXECUTE FUNCTION
      ${q("lexy_erasure_write_barrier")}('candidate_id');`);
  ddl.push(
    `CREATE FUNCTION ${q("inspect_fixture")}(contract jsonb, target_schema text)
      RETURNS TABLE(check_name text, passed boolean) LANGUAGE sql STABLE
      AS $catalog$${query}$catalog$;`,
  );
  // Group repeated column metadata on transport, restore the ordinary audit
  // contract inside SQL. The operational contract/query are not weakened.
  const packedColumns = {};
  for (const column of contract.columns)
    (packedColumns[column.table_name] ??= []).push([
      column.column_name,
      column.data_type,
      column.required,
      column.default_sql,
    ]);
  const packedContract = { ...contract, columns: packedColumns };
  ddl.push(`CREATE FUNCTION ${q("fixture_contract")}() RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $contract$
      SELECT payload || jsonb_build_object('columns',(
        SELECT jsonb_agg(jsonb_build_object(
          'table_name',g.key,'column_name',c.value->>0,'data_type',c.value->>1,
          'required',c.value->2,'default_sql',c.value->3))
        FROM jsonb_each(payload->'columns') g
        CROSS JOIN LATERAL jsonb_array_elements(g.value) c
      )) FROM (SELECT ${literal(JSON.stringify(packedContract))}::jsonb AS payload) s
    $contract$;`);
  const inspect = `${q("inspect_fixture")}(${q("fixture_contract")}(),${literal(namespace)})`;
  const names = requiredSchemaCheckNames(contract).sort();
  const namesHash = createHash("sha256").update(names.join("\n")).digest("hex");
  ddl.push(`CREATE FUNCTION ${q("assert_intact")}() RETURNS void
    LANGUAGE plpgsql AS $positive$ DECLARE ok boolean; BEGIN
    SELECT count(*)=${names.length} AND count(DISTINCT check_name)=${names.length}
      AND bool_and(passed IS TRUE)
      AND encode(sha256(convert_to(string_agg(check_name,E'\\n' ORDER BY check_name),'UTF8')),'hex')=${literal(namesHash)}
    INTO ok FROM ${inspect};
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Intact ATS fixture did not pass: %',
      (SELECT array_agg(check_name) FROM ${inspect} WHERE passed IS DISTINCT FROM true); END IF;
  END $positive$;`);
  ddl.push(`CREATE FUNCTION ${q("assert_failure")}(label text, expected text[]) RETURNS void
    LANGUAGE plpgsql AS $negative$ DECLARE failures text[]; BEGIN
      SELECT array_agg(check_name ORDER BY check_name) FILTER (WHERE passed IS DISTINCT FROM true)
      INTO failures FROM ${inspect};
      IF failures IS DISTINCT FROM expected
      THEN RAISE EXCEPTION 'ATS case % returned unexpected failures: %',label,failures; END IF;
    END $negative$;`);
  const positive = `SELECT ${q("assert_intact")}();`;
  ddl.push(positive);
  // Schema USAGE is deliberately granted so denial proves table privacy, not
  // an unrelated schema permission failure. No rows or shared grants change.
  ddl.push(
    "SAVEPOINT request_role_probe;",
    `GRANT USAGE ON SCHEMA ${identifier(namespace)} TO lexy_app;`,
    "SET LOCAL ROLE lexy_app;",
    `DO $request$ BEGIN ${contract.tables
      .filter((t) => t.name.startsWith("zoho_"))
      .map(
        (t) => `
      BEGIN
        PERFORM 1 FROM ${q(t.name)} LIMIT 1;
        RAISE EXCEPTION 'Private Zoho table unexpectedly readable';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;`,
      )
      .join("\n")}
    END $request$;`,
    "RESET ROLE;",
    "ROLLBACK TO SAVEPOINT request_role_probe;",
    "RELEASE SAVEPOINT request_role_probe;",
    positive,
  );
  const cases = [];
  const add = (name, mutation, expected) => cases.push({ name, mutation, expected });
  for (const table of contract.tables) {
    for (const [label, action] of [
      ["disabled RLS", "DISABLE ROW LEVEL SECURITY"],
      ["unforced RLS", "NO FORCE ROW LEVEL SECURITY"],
    ])
      add(`${table.name}: ${label}`, `ALTER TABLE ${q(table.name)} ${action};`, [
        `table:${table.name}`,
      ]);
  }
  add("public table grant", `GRANT SELECT ON ${q("ats_candidate_profiles")} TO PUBLIC;`, [
    "table:ats_candidate_profiles",
  ]);
  add("request table grant", `GRANT INSERT ON ${q("ats_candidate_profiles")} TO lexy_app;`, [
    "table:ats_candidate_profiles",
  ]);
  add(
    "request column grant",
    `GRANT SELECT(external_candidate_id) ON ${q("ats_candidate_profiles")} TO lexy_app;`,
    ["table:ats_candidate_profiles"],
  );
  add(
    "unexpected policy",
    `CREATE POLICY unexpected ON ${q("ats_refresh_schedules")} USING (true);`,
    ["table:ats_refresh_schedules"],
  );
  for (const table of contract.tables.filter((t) => t.name.startsWith("zoho_"))) {
    for (const [label, mutation] of [
      ["public grant", `GRANT SELECT ON ${q(table.name)} TO PUBLIC;`],
      ["request grant", `GRANT INSERT ON ${q(table.name)} TO lexy_app;`],
      ["column grant", `GRANT SELECT(tenant_id) ON ${q(table.name)} TO lexy_app;`],
      ["unexpected policy", `CREATE POLICY unexpected ON ${q(table.name)} USING (true);`],
    ])
      add(`${table.name}: ${label}`, mutation, [`table:${table.name}`]);
  }
  for (const fn of contract.ats_functions) {
    const signature = `${q(fn.name)}(${fn.args})`;
    const expected = [`function:${fn.name}`];
    add(
      `${fn.name}: security mode`,
      `ALTER FUNCTION ${signature} SECURITY ${fn.definer ? "INVOKER" : "DEFINER"};`,
      expected,
    );
    add(
      `${fn.name}: unsafe path`,
      `ALTER FUNCTION ${signature} SET search_path=${fn.search_path === "search_path=pg_catalog,public" ? "public,pg_catalog" : "pg_catalog,public"};`,
      expected,
    );
    add(
      `${fn.name}: changed body`,
      functionSql({
        ...fn,
        body: fn.language === "sql" ? "SELECT true" : "BEGIN PERFORM 1; RETURN NEW; END;",
      }),
      expected,
    );
    if (fn.owner_bypass)
      add(
        `${fn.name}: restricted owner`,
        `GRANT USAGE,CREATE ON SCHEMA ${identifier(namespace)} TO lexy_app;
        ALTER FUNCTION ${signature} OWNER TO lexy_app;`,
        expected,
      );
    if (!fn.public_execute)
      add(
        `${fn.name}: public execution`,
        `GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC;`,
        expected,
      );
    add(
      `${fn.name}: request execution`,
      `${fn.request_execute ? "REVOKE" : "GRANT"} EXECUTE ON FUNCTION ${signature}
      ${fn.request_execute ? "FROM" : "TO"} lexy_app;${fn.public_execute ? ` REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;` : ""}`,
      expected,
    );
  }
  const stageFn = contract.ats_functions.find((fn) => fn.name === "ats_stage_is_external");
  add("function path reset", `ALTER FUNCTION ${q(stageFn.name)}(${stageFn.args}) RESET ALL;`, [
    `function:${stageFn.name}`,
  ]);
  add(
    "unexpected function configuration",
    `ALTER FUNCTION ${q(stageFn.name)}(${stageFn.args}) SET work_mem='4MB';`,
    [`function:${stageFn.name}`],
  );
  const overload = { ...stageFn, args: "other text" };
  add(
    "safe overload cannot mask weakened correct signature",
    [
      functionSql(overload),
      ...grantsSql(overload),
      `ALTER FUNCTION ${q(stageFn.name)}(${stageFn.args}) SECURITY INVOKER;`,
    ].join("\n"),
    [`function:${stageFn.name}`],
  );
  add(
    "same-name function in another schema",
    [
      `CREATE SCHEMA ${identifier(shadow)};`,
      `DROP FUNCTION ${q(stageFn.name)}(${stageFn.args});`,
      functionSql(stageFn, shadow),
      ...grantsSql(stageFn, shadow),
    ].join("\n"),
    [`function:${stageFn.name}`],
  );
  for (const trigger of contract.ats_triggers) {
    const expected = [`trigger:${trigger.table_name}.${trigger.name}`];
    add(
      `${trigger.name}: disabled`,
      `ALTER TABLE ${q(trigger.table_name)} DISABLE TRIGGER ${identifier(trigger.name)};`,
      expected,
    );
    add(
      `${trigger.name}: replica only`,
      `ALTER TABLE ${q(trigger.table_name)} ENABLE REPLICA TRIGGER ${identifier(trigger.name)};`,
      expected,
    );
    add(`${trigger.name}: wrong timing`, triggerSql(trigger, { timing: "AFTER" }), expected);
    add(
      `${trigger.name}: conditional guard`,
      triggerSql(trigger, {
        when: `WHEN (${trigger.type === 27 ? "OLD" : "NEW"}.id IS NOT NULL)`,
      }).replace(
        "NEW.id",
        trigger.table_name === "employer_ats_bindings" ? "NEW.tenant_id" : "NEW.id",
      ),
      expected,
    );
    add(
      `${trigger.name}: unexpected arguments`,
      triggerSql(trigger, { args: "'unexpected'" }),
      expected,
    );
  }
  const applicationGuard = contract.ats_triggers.find(
    (trigger) => trigger.table_name === "applications",
  );
  const applicationCheck = [`trigger:${applicationGuard.table_name}.${applicationGuard.name}`];
  add(
    "missing insert guard",
    triggerSql(applicationGuard, { events: "UPDATE OF candidate_id,job_id" }),
    applicationCheck,
  );
  add(
    "wrong update columns",
    triggerSql(applicationGuard, { events: "INSERT OR UPDATE OF candidate_id,id" }),
    applicationCheck,
  );
  add(
    "guard from wrong schema",
    [
      `CREATE SCHEMA ${identifier(shadow)};`,
      functionSql(
        contract.ats_functions.find((fn) => fn.name === applicationGuard.function_name),
        shadow,
      ),
      triggerSql(applicationGuard, { schema: shadow }),
    ].join("\n"),
    applicationCheck,
  );
  add(
    "guard from wrong function",
    `CREATE FUNCTION ${q("wrong_guard")}() RETURNS trigger LANGUAGE plpgsql AS $stub$BEGIN RETURN NEW; END;$stub$;
    ${triggerSql(applicationGuard, { fn: "wrong_guard" })}`,
    applicationCheck,
  );
  add(
    "missing profile erasure barrier",
    `DROP TRIGGER lexy_erasure_write_barrier ON ${q("ats_candidate_profiles")};`,
    ["trigger:ats_candidate_profiles"],
  );
  add(
    "wrong erasure subject column",
    `CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
    BEFORE INSERT OR UPDATE ON ${q("ats_candidate_profiles")} FOR EACH ROW EXECUTE FUNCTION
    ${q("lexy_erasure_write_barrier")}('external_candidate_id');`,
    ["trigger:ats_candidate_profiles"],
  );
  for (const table of ["zoho_campaign_recipients", "zoho_campaign_reviews"]) {
    add(
      `${table}: missing erasure barrier`,
      `DROP TRIGGER lexy_erasure_write_barrier ON ${q(table)};`,
      [`trigger:${table}`],
    );
    add(
      `${table}: disabled erasure barrier`,
      `ALTER TABLE ${q(table)} DISABLE TRIGGER lexy_erasure_write_barrier;`,
      [`trigger:${table}`],
    );
    add(
      `${table}: wrong erasure subject`,
      `CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier
      BEFORE INSERT OR UPDATE ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION
      ${q("lexy_erasure_write_barrier")}('session_id');`,
      [`trigger:${table}`],
    );
  }
  const frozen = contract.ats_triggers.find((t) => t.name === "zoho_campaign_frozen_plan_barrier");
  add("frozen plan delete protection removed", triggerSql(frozen, { events: "UPDATE" }), [
    `trigger:${frozen.table_name}.${frozen.name}`,
  ]);
  for (const constraint of contract.constraints.filter(
    (c) => c.table_name.startsWith("zoho_") && !c.name.endsWith("_pkey"),
  ))
    add(
      `missing constraint ${constraint.name}`,
      `ALTER TABLE ${q(constraint.table_name)} DROP CONSTRAINT ${identifier(constraint.name)};`,
      [`constraint:${constraint.table_name}.${constraint.name}`],
    );
  for (const [label, action] of [
    ["default", "SET DEFAULT 'isolated_test'"],
    ["nullability", "DROP NOT NULL"],
  ])
    add(
      `dispatch isolation ${label}`,
      `ALTER TABLE ${q("zoho_interview_campaigns")} ALTER COLUMN dispatch_lane ${action};`,
      ["column:zoho_interview_campaigns.dispatch_lane"],
    );
  for (const index of contract.indexes)
    add(`missing index ${index.name}`, `DROP INDEX ${q(index.name)};`, [`index:${index.name}`]);
  const running = contract.indexes.find((index) => index.name === "ats_refresh_one_running");
  const invitation = contract.indexes.find(
    (index) => index.name === "zoho_campaign_invitation_identity",
  );
  add(
    "uncertain invitation removed from dedup predicate",
    `DROP INDEX ${q(invitation.name)};
    ${invitation.definition.replace(", 'review_required'::text", "")};`,
    [`index:${invitation.name}`],
  );
  const chain = contract.indexes.find((index) => index.name === "zoho_campaign_reviews_chain");
  add(
    "multiple initial reviews allowed",
    `DROP INDEX ${q(chain.name)}; ${chain.definition.replace(" NULLS NOT DISTINCT", "")};`,
    [`index:${chain.name}`],
  );
  add(
    "wrong active-run partial predicate",
    `DROP INDEX ${q(running.name)};
    ${running.definition.replace("'running'", "'completed'")};`,
    [`index:${running.name}`],
  );
  const unique = contract.indexes[0];
  add(
    "uniqueness removed",
    `DROP INDEX ${q(unique.name)};
    ${unique.definition.replace("CREATE UNIQUE INDEX", "CREATE INDEX")};`,
    [`index:${unique.name}`],
  );
  // Serialize mutations once, with one namespace token. Each PL/pgSQL exception
  // block is a subtransaction: the sentinel rolls back only that negative case.
  // Assertion/SQL errors have other SQLSTATEs and must escape, never become passes.
  const compactCases = cases.map(({ mutation, expected }, index) => [
    index + 1,
    mutation.replaceAll(namespace, "__ATS_FIXTURE__"),
    [...expected].sort(),
  ]);
  ddl.push(`DO $negative$
    DECLARE item jsonb; expected text[];
    BEGIN
      FOR item IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(compactCases))}::jsonb)
      LOOP
        SELECT array_agg(value ORDER BY value) INTO expected
          FROM jsonb_array_elements_text(item->2);
        BEGIN
          EXECUTE replace(item->>1,'__ATS_FIXTURE__',${literal(namespace)});
          PERFORM ${q("assert_failure")}(item->>0,expected);
          RAISE EXCEPTION USING ERRCODE='ZT001', MESSAGE='rollback verified negative case';
        EXCEPTION WHEN SQLSTATE 'ZT001' THEN NULL;
        END;
        PERFORM ${q("assert_intact")}();
      END LOOP;
    END $negative$;`);
  ddl.push(
    `SELECT ${cases.length} AS negative_cases_passed, ${cases.length + 2} AS intact_fixture_checks_passed;`,
    "ROLLBACK;",
    `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname IN (${literal(namespace)},${literal(shadow)})) AS fixture_cleanup_passed;`,
  );
  return {
    sql: ddl.join("\n"),
    namespace,
    shadow,
    caseCount: cases.length,
    cases: cases.map(({ name, expected }) => ({ name, expected })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !/^[0-9a-f]{32}$/.test(process.argv[2] ?? "")) {
    console.error("Usage: node scripts/ats-db-schema-sql-fixture.mjs DEVELOPMENT_FINGERPRINT");
    process.exitCode = 2;
  } else console.log(buildAtsSchemaAuditFixture(process.argv[2]).sql);
}
