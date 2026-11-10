-- Read-only metadata checks. Run on the intended release database after 0104.
BEGIN READ ONLY;
WITH private_tables AS (
  SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('zoho_stage_mappings','zoho_stage_handoff_events')
), checks AS (
  SELECT 'tables_present' AS name, count(*)=2 AS passed FROM private_tables
  UNION ALL SELECT 'forced_rls',count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM private_tables
  UNION ALL SELECT 'request_table_privileges_denied',count(*)=2 AND bool_and(
    NOT has_table_privilege('lexy_app',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) FROM private_tables
  UNION ALL SELECT 'request_column_privileges_denied',count(*)=2 AND bool_and(
    NOT has_any_column_privilege('lexy_app',oid,'SELECT,INSERT,UPDATE,REFERENCES')
  ) FROM private_tables
  UNION ALL SELECT 'no_public_acl',NOT EXISTS(
    SELECT 1 FROM private_tables t JOIN pg_class c ON c.oid=t.oid
    CROSS JOIN LATERAL aclexplode(c.relacl) acl WHERE acl.grantee=0
  )
  UNION ALL SELECT 'no_request_policies',NOT EXISTS(
    SELECT 1 FROM pg_policy p JOIN private_tables t ON t.oid=p.polrelid
  )
  UNION ALL SELECT 'receipt_erasure_guard',EXISTS(
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND c.relname='zoho_stage_handoff_events'
    AND t.tgname='lexy_erasure_write_barrier' AND p.proname='lexy_erasure_write_barrier' AND p.pronamespace=n.oid
    AND t.tgenabled='O' AND t.tgtype=23 AND encode(t.tgargs,'hex')='63616e6469646174655f696400'
  )
  UNION ALL SELECT 'immutable_receipts',EXISTS(
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname='public' AND c.relname='zoho_stage_handoff_events'
    AND t.tgname='zoho_stage_handoff_immutable' AND p.proname='zoho_campaign_review_immutable' AND p.pronamespace=n.oid
    AND t.tgenabled='O' AND t.tgtype=19
  )
  UNION ALL SELECT 'simulation_only_state',EXISTS(
    SELECT 1 FROM pg_constraint k JOIN private_tables t ON t.oid=k.conrelid
    WHERE t.relname='zoho_stage_handoff_events' AND k.conname='zoho_stage_handoff_events_state_check'
    AND k.convalidated AND pg_get_constraintdef(k.oid)='CHECK ((state = ''simulated''::text))'
  )
  UNION ALL SELECT 'request_id_unique',EXISTS(
    SELECT 1 FROM pg_constraint k JOIN private_tables t ON t.oid=k.conrelid
    WHERE t.relname='zoho_stage_handoff_events' AND k.contype='u'
    AND k.convalidated AND pg_get_constraintdef(k.oid)='UNIQUE (tenant_id, request_id)'
  )
  UNION ALL SELECT 'approval_evidence_unique',EXISTS(
    SELECT 1 FROM pg_constraint k JOIN private_tables t ON t.oid=k.conrelid
    WHERE t.relname='zoho_stage_handoff_events' AND k.contype='u'
    AND k.convalidated AND pg_get_constraintdef(k.oid)='UNIQUE (tenant_id, recipient_id, review_revision, mapping_revision)'
  )
  UNION ALL SELECT 'recipient_cascade',EXISTS(
    SELECT 1 FROM pg_constraint k JOIN private_tables t ON t.oid=k.conrelid
    WHERE t.relname='zoho_stage_handoff_events' AND k.contype='f'
    AND k.convalidated AND pg_get_constraintdef(k.oid)='FOREIGN KEY (recipient_id) REFERENCES zoho_campaign_recipients(id) ON DELETE CASCADE'
  )
)
SELECT name,COALESCE(passed,false) AS passed FROM checks ORDER BY name;
ROLLBACK;
