-- Metadata only. The caller must open a READ ONLY transaction.
-- $1 is the reviewed contract JSON, not executable SQL.
-- $2 is a bound schema name. The operational checker fixes it to public.
WITH
expected_tables AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'tables')
  AS e(name text, rls boolean, forced boolean, no_policies boolean,
       no_public_grants boolean, no_request_grants boolean)
),
expected_columns AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'columns')
  AS e(table_name text, column_name text, data_type text, required boolean, default_sql text)
),
expected_constraints AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'constraints')
  AS e(table_name text, name text, definition text)
),
expected_indexes AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'indexes')
  AS e(name text, definition text)
),
expected_functions AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'functions')
  AS e(name text, args text, return_type text, body text)
),
special_triggers AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'triggers')
  AS e(table_name text, args_hex text)
),
public_tables AS (
  SELECT c.* FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$2 AND c.relkind IN ('r','p')
),
expected_triggers AS (
  SELECT * FROM special_triggers
  UNION ALL
  SELECT c.relname::text, '63616e6469646174655f696400'::text
  FROM public_tables c
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  WHERE a.attname='candidate_id' AND NOT a.attisdropped
    AND COALESCE(($1::jsonb->>'scan_candidate_children')::boolean,true)
    AND c.relname NOT IN ('deletion_requests','decision_events','fee_line_items')
    AND c.relname NOT IN (SELECT table_name FROM special_triggers)
)
SELECT 'table:'||e.name AS check_name,
  EXISTS (
    SELECT 1 FROM public_tables c WHERE c.relname=e.name
      AND (e.rls IS NULL OR c.relrowsecurity=e.rls)
      AND (e.forced IS NULL OR c.relforcerowsecurity=e.forced)
      AND (NOT COALESCE(e.no_policies,false) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
      ))
      AND (NOT COALESCE(e.no_public_grants,false) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))
        ) a WHERE a.grantee=0
      ))
      -- Effective privileges include PUBLIC and inherited-role grants. Check
      -- column ACLs too: absence of a table-level grant does not prove privacy.
      AND (NOT COALESCE(e.no_request_grants,false) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='lexy_app'
          AND NOT pg_catalog.has_table_privilege(
            r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
          AND NOT pg_catalog.has_any_column_privilege(
            r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'
          )
      ))
  ) AS passed
FROM expected_tables e
UNION ALL
SELECT 'column:'||e.table_name||'.'||e.column_name,
  EXISTS (
    SELECT 1 FROM public_tables c
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.relname=e.table_name AND a.attname=e.column_name
      AND a.attnum>0 AND NOT a.attisdropped AND typ.typname=e.data_type
      AND a.attnotnull=e.required
      AND (e.default_sql IS NULL OR pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.default_sql)
  )
FROM expected_columns e
UNION ALL
SELECT 'constraint:'||e.table_name||'.'||e.name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint k
    JOIN public_tables c ON c.oid=k.conrelid
    WHERE c.relname=e.table_name AND k.conname=e.name AND k.convalidated
      AND pg_catalog.pg_get_constraintdef(k.oid)=e.definition
  )
FROM expected_constraints e
UNION ALL
SELECT 'index:'||e.name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$2 AND c.relname=e.name AND i.indisvalid AND i.indisready
      AND pg_catalog.pg_get_indexdef(i.indexrelid)=e.definition
  )
FROM expected_indexes e
UNION ALL
SELECT 'function:'||e.name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$2 AND p.proname=e.name AND p.prokind='f'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid)=e.args
      AND pg_catalog.format_type(p.prorettype,NULL)=e.return_type
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND p.prosecdef
      AND regexp_replace(array_to_string(p.proconfig,','),'\s','','g')
          ='search_path=pg_catalog,public'
      AND btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n')=e.body
  )
FROM expected_functions e
UNION ALL
SELECT 'trigger:'||e.table_name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN public_tables c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE c.relname=e.table_name AND t.tgname='lexy_erasure_write_barrier'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=23
      AND t.tgqual IS NULL AND t.tgargs=decode(e.args_hex,'hex')
      AND n.nspname=$2 AND p.proname='lexy_erasure_write_barrier'
  )
FROM expected_triggers e
ORDER BY check_name;
