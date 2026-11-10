-- Catalog-only counterpart to ATS and Zoho security migrations through 0103.
-- Bound schema/contract; never read account credentials or applicant rows.
WITH
expected_functions AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'ats_functions')
  AS e(name text, args text, return_type text, language text, definer boolean,
       search_path text, owner_bypass boolean, public_execute boolean,
       request_execute boolean, body text)
),
expected_triggers AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb->'ats_triggers')
  AS e(table_name text, name text, function_name text, type integer, columns text[])
)
SELECT 'function:'||e.name AS check_name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=p.proowner
    WHERE n.nspname=$2 AND p.proname=e.name AND p.prokind='f'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid)=e.args
      AND pg_catalog.format_type(p.prorettype,NULL)=e.return_type
      AND l.lanname=e.language AND p.prosecdef=e.definer
      AND COALESCE(regexp_replace(array_to_string(p.proconfig,','),'\s','','g'),'')=e.search_path
      AND (NOT e.owner_bypass OR owner_role.rolsuper OR owner_role.rolbypassrls)
      AND btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n')=e.body
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='lexy_app'
          AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')=e.request_execute
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
        ) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
      )=e.public_execute
  ) AS passed
FROM expected_functions e
UNION ALL
SELECT 'trigger:'||e.table_name||'.'||e.name,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE cn.nspname=$2 AND pn.nspname=$2 AND c.relname=e.table_name
      AND t.tgname=e.name AND p.proname=e.function_name
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=e.type
      AND t.tgqual IS NULL AND t.tgargs=decode('','hex')
      AND ARRAY(
        SELECT a.attname::text FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum=ANY(t.tgattr::smallint[])
        ORDER BY a.attname
      )=e.columns
  )
FROM expected_triggers e
ORDER BY check_name;
