# Zoho campaign release handoff

## Release decision

This checklist covers employer-authorized, read-only Zoho intake, approved
interview campaigns, local human results review and simulation-only stage
handoff. **It does not authorize live Zoho stage updates, offers or employment
decisions.** A successful development check does not establish production
readiness or live provider acceptance.

Production API hosting and its database are external. Nothing in this checklist
assumes publishing the workspace migrates or configures either one.

## Invitation delivery review

Campaign recipient rows show saved invitation evidence: provider reference,
acceptance classification, last recipient-state update and the linked session.
Sending and review-required recipients are highlighted with their evidence open.
The view is read-only; it cannot resend, clear a claim or change a hiring decision.

A saved send claim, session or provider reference alone does not prove acceptance.
Only the persisted sent state with its provider reference is labelled recorded
acceptance, and even that is not proof of inbox delivery. Missing evidence remains
unknown. The state-update timestamp is not represented as an attempt or send time.
No live provider lookup or delivery-event correlation is performed by this view.
Staff must reconcile uncertain outcomes with their provider logs before considering
further contact. Suspended staff and mismatched-account recipient rows are excluded.

## 1. Development verification

Run only against verified local development, never an unconfirmed production
connection. The combined suite creates and removes isolated synthetic fixtures.

```sh
pnpm test:assisted-baseline
```

Retain the runner's final JSON report and per-step logs. Require a completed,
passing report, not just an intermediate sequence of passing lines. Existing
lint/format allowances are reported separately; this is not a claim that every
file in the repository is free of pre-existing issues.

The build's authorization guards also retain existing baseline allowlists,
including known Class-B read gaps outside this Zoho change. A passing guard means
no unaccounted regression against those rules, not that every allowlisted
surface has been newly proven safe. Keep those findings in the broader release
risk review. This checklist is not a fresh full-project security audit.

The joined campaign-service scenario uses the same persisted recipient and
dispatcher-created interview session through:

- Imported-job provenance, applicant snapshot, deduplication and staff approval.
- An injected single-attempt invitation sender, never actual delivery.
- Synthetic completed interview evidence, including a real zero score.
- Advance → Hold → Do not advance human corrections, preserving history.
- Local mapping and deduplicated simulation receipts for each correction.
- Changed interview evidence invalidating the current decision and handoff.
- Existing cancelled, uncertain-delivery, disabled-authority and identity-conflict
  paths, with no blind resend.

Remote reads/sends are injected. Imported-job provenance and completed interview
evidence are seeded; this does **not** prove live import, audio capture, grading,
provider delivery, or real ATS transition permission. The separate adapter,
reviewed-import and browser tests cover their own boundaries in the combined
suite. A latest human correction must take precedence over every older decision.

## 2. External database rollout

The deployment owner must first positively identify the intended database and
take an appropriate backup. Apply the reviewed migrations through the team's
existing migration process, in dependency order. Do not run `drizzle push`, do
not blindly replay already-applied SQL, and do not run the development fixture
suite against production.

Zoho-specific migrations, after their existing project prerequisites:

| Migration | Purpose |
| --- | --- |
| `0099_zoho_recruit_accounts.sql` | Employer grants and encrypted token custody |
| `0100_zoho_imported_jobs.sql` | Reviewed imported-job provenance |
| `0101_zoho_interview_campaigns.sql` | Snapshot, queue, invitation claim and frozen plan |
| `0102_zoho_campaign_reviews.sql` | Append-only human review history |
| `0103_zoho_campaign_dispatch_isolation.sql` | Separate live and synthetic dispatch lanes |
| `0104_zoho_stage_handoff_preparation.sql` | Proposed mappings and simulation-only receipts |

Files are in `lib/db/drizzle/`. Consult [storage readiness](zoho-storage-readiness.md)
and the full migration chain, not just this feature-specific list.

After confirming the target, run the existing read-only metadata audits:

```sh
node scripts/check-recent-db-schema.mjs
node scripts/check-recent-db-schema.mjs --ats
node scripts/check-zoho-handoff-schema.mjs
```

The last command checks 0104 handoff storage and is now a required step in
`pnpm test:assisted-baseline`. It requires exactly **12 typed checks**, rejects
incomplete or unexpected results, and exits nonzero for any failed check or
verification error. Transactions are read-only, time-bounded and rolled back;
connection cleanup is required. It audits `public` only, with no schema override.
`scripts/sql/check-zoho-handoff-storage.sql` remains the equivalent standalone SQL
for an authorized operator.

The ATS audit covers Zoho through 0103; the new required handoff audit covers
0104 separately. Record the target independently: automated reports deliberately
label their connection `not-independently-attested`. Being a required gate step
does not migrate anything or independently prove the host/database is production.

## 3. External API configuration

Configure through the external host's secure environment management, without
copying values into documents, logs, source or chat:

- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`: the employer-authorized Zoho app.
- `ZOHO_DATA_CENTER=us` for the existing `recruit.zoho.com` account.
- `ZOHO_REDIRECT_URI`: the exact externally hosted HTTPS API callback ending in
  `/api/zoho-recruit/callback`, also registered in the Zoho API Console.
- `ZOHO_SETTINGS_URL`: the external frontend's HTTPS `/settings/ats` URL.
- `SESSION_SECRET`: the configured server-side custody encryption secret.
  Coordinate any rotation; do not casually replace it during rollout.
- Verify existing authenticated-session/cookie, frontend-to-API and email
  delivery configuration for the external deployment. Development settings do
  not configure the external host.

Use Lexy's direct **Connect Zoho Recruit** flow, not the separate project
connector. The current grant requests organization metadata, candidate/job/
application reads and search. Stage catalogue reads are an additional, explicit
read-only opt-in. No write scope is requested by this feature. Employer company
review/confirmation remains required; connecting alone is not approval to
import, send a campaign or update a stage.

Deploy compatible frontend/backend code after storage and configuration are
ready. Keep the normal scheduler running for approved campaigns; do not run a
second ad-hoc dispatcher to accelerate invitations.

## 4. Remaining controlled live acceptance

Requires an authorized employer account with a dummy job/application. Dummy
records were subsequently created and imported in development; that does not
prove the remaining human approval, invitation delivery and interview review
steps. Recheck current state before repeating an import or send. Keep real
candidates out of this pilot and separately approve any invitation email.

1. Verify account identity and actual job/application/candidate read fields.
2. Explicitly import the dummy job, approve the local work order, and choose its
   interview plan.
3. Review the applicant snapshot and approve only the intended test recipient.
4. Verify one invitation acceptance receipt and inbox delivery separately.
   A `sent` state proves provider acceptance, not inbox delivery.
5. Complete the actual interview, then review saved evidence and make/correct a
   human decision. Confirm the local review and simulation do not send email,
   move the provider application, or create an offer.
6. Confirm candidates only see offered scheduling slots, never staff calendars.
   External calendar/meeting acceptance remains a separate provider check.

Do not repeat a possibly accepted invitation to repair a missing receipt.
`review_required`/uncertain attempts need reconciliation, not generic resend.

## 5. Explicitly unfinished: live stage write-back

The provider-supported application-specific allowed-transition contract and
dummy-record acceptance remain unverified. Default catalogue matches, pipeline
history, generic record updates and job-pipeline reassignment are not substitutes.

After that contract is established, a live executor still needs explicit employer
write consent, version-bound human approval, durable attempt claims, read-back
verification and uncertain-outcome reconciliation. There is no live writer to
activate in this release. See [stage handoff](zoho-stage-handoff.md).

## Verification record

The development result and outstanding external checks are recorded separately.
Do not mark an external row passed based on a local fixture.

| Check | Status |
| --- | --- |
| Previous combined assisted release suite | Passed on 2026-11-02 before adding the handoff gate: 47/47 checks, including 94 API files in 27 bounded batches and 12 Zoho browser scenarios |
| Required 0104 development metadata audit | Passed: 12/12, verified local development, read-only |
| Handoff gate regression evidence | Seven script tests; 23 real SQL negative fixtures, pristine positive checks and actual request-role denial; temporary schemas rolled back |
| Expanded combined suite | Completed on 2026-11-02: 47/48 checks passed; panel-invitation browser failed during initial navigation with a 10-second timeout. Original report remains failed, not rewritten as green |
| Panel-invitation isolated follow-up | Passed on 2026-11-02: 14/14 scenarios without overlapping compilation. The earlier navigation timeout did not reproduce; no application change or timeout increase was needed |
| Invitation evidence review | Four targeted backend tests and 16 campaign browser scenarios passed, including unknown acceptance, missing evidence and read-only review. Synthetic results do not prove live delivery |
| External production migrations/configuration | Not verified here |
| Live Zoho dummy job/application acceptance | Pending employer test records |
| Actual invitation delivery and real interview completion | Not exercised by the synthetic run |
| Application-specific transition contract and live writer | Pending; not enabled |
