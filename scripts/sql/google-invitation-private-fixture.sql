-- Substitute only a verified DEVELOPMENT fingerprint and a fresh, validated
-- google_invitation_fixture_<32 lowercase hex> namespace. Never commit this fixture.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $$
BEGIN
  IF md5(current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|'
    || COALESCE(inet_server_port()::text,'0') || '|'
    || EXTRACT(EPOCH FROM pg_postmaster_start_time())::text) <> 'DEVELOPMENT_FINGERPRINT' THEN
    RAISE EXCEPTION 'Development identity mismatch; no fixture DDL performed';
  END IF;
END $$;
CREATE SCHEMA GOOGLE_INVITATION_FIXTURE_NAMESPACE;
CREATE TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts
  (LIKE public.interview_calendar_invitation_attempts INCLUDING ALL);
CREATE TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff
  (LIKE public.staff_google_calendars INCLUDING ALL);
ALTER TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff FORCE ROW LEVEL SECURITY;
REVOKE ALL ON GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts,
  GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff FROM PUBLIC,lexy_app;
INSERT INTO GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff
  (user_id,tenant_id,revision,client_fingerprint)
  VALUES ('fixture-self','fixture-employer','synthetic-revision','synthetic-client');
INSERT INTO GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts
  (schedule_id,candidate_id,application_id,organizer_id,recipient_hash,schedule_version,
    transaction_id,status,attempted_at,provider,google_snapshot)
  VALUES ('fixture-schedule','fixture-candidate','fixture-app','fixture-self','synthetic-hash','synthetic-version',
    'synthetic-attempt','attempted',now(),'google',
    '{"connectionRevision":"synthetic-revision","subjectHash":"synthetic-subject","snapshotHash":"synthetic-snapshot","meetUrl":null,"conferenceStatus":"pending"}');
DO $$
BEGIN
  BEGIN
    INSERT INTO GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts
      (schedule_id,candidate_id,application_id,organizer_id,recipient_hash,schedule_version,transaction_id,status,attempted_at)
      VALUES ('fixture-schedule','fixture-candidate','fixture-app','fixture-self','synthetic-hash','synthetic-version','another-attempt','attempted',now());
    RAISE EXCEPTION 'Duplicate cross-provider claim unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff SET invitation_consent=true;
    RAISE EXCEPTION 'Write permission without a credential unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff SET flow_invitations=true;
    RAISE EXCEPTION 'Write consent without a pending flow unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts SET provider='outlook';
    RAISE EXCEPTION 'Provider and receipt mismatch unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT provider FROM GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts) <> 'google'
    OR (SELECT invitation_consent OR flow_invitations FROM GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff) THEN
    RAISE EXCEPTION 'Original claim or least-privilege defaults changed';
  END IF;
END $$;
GRANT USAGE ON SCHEMA GOOGLE_INVITATION_FIXTURE_NAMESPACE TO lexy_app;
SET LOCAL ROLE lexy_app;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM GOOGLE_INVITATION_FIXTURE_NAMESPACE.attempts;
    RAISE EXCEPTION 'Request role unexpectedly read private invitation receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM GOOGLE_INVITATION_FIXTURE_NAMESPACE.staff;
    RAISE EXCEPTION 'Request role unexpectedly read private credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT 'google_invitation_private_fixture_passed' AS evidence;
ROLLBACK;
