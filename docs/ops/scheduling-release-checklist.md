# Scheduling release and live acceptance checklist

This checklist separates local automated evidence from target-database rollout
and real Microsoft Outlook acceptance. A local pass does not prove that the
published app is migrated, that Microsoft delivered an invitation or that guests
accepted it. Do not mark an unchecked item complete from a mocked result.

## 1. Local release checks

- [x] Repository `format` workflow passes without added ignore rules.
- [x] Repository `assisted-baseline` workflow finishes with every required
      check passing. An incomplete progress report is not a pass.
- [x] Review the report's per-step results, including candidate confirmation,
      frontend logic, API build/security guards, typechecks and the controlled
      offer browser check. Lint warnings and explicitly reviewed historical
      allowances are not proof that all unrelated technical debt is resolved.
- [x] Record the report path and timestamp in
      [local scheduling evidence](../qa/scheduling-local-readiness-2026-10-22.md).

The release gate is a focused regression suite, not full product acceptance.
Do not change LLMs, prompts, provider routing, subscription entitlements or
human approval boundaries to make it pass.

Historical local gate evidence was recorded on 2026-10-24: all 30 then-required
checks passed. On 2026-10-28 a separate whole-gate run passed all 42 then-required
groups; see the [current ATS release checkpoint](../engineering/ats-connector-foundation.md#release-handoff-checkpoint).
All target-rollout and live-acceptance items below remain unchecked.

The gate subsequently gained a required `panel-invitation-browser` step and the
four pure panel-state tests. The exact new browser command passed 14/14 scenarios
and the pure tests passed 4/4 independently; see the QA record for scope.
Run the complete expanded gate for the actual release, rather than treating the
earlier 30-check report as a complete 31-check report.

The current gate additionally requires the broader and ATS read-only installed-
schema audits, before API fixture journeys. Its configured total is now 44 groups.
Both new guarded commands and all 43 gate-plumbing/checker tests passed
independently. This is not a claim of a freshly completed 44-group run; keep the
expanded-gate release item below open until that complete run is recorded.

- [x] New isolated browser command passes all 14 panel-invitation scenarios.
- [x] Panel-state tests are included in the frontend release manifest.
- [ ] Complete expanded gate is run for the actual release.

The subsequent Google read-only pilot adds another required browser step and
focused backend/frontend tests. Its independent checks passed; the expanded
whole-gate run remains a release requirement. See
[Google pilot evidence](../qa/google-calendar-readonly-pilot-2026-10-24.md).
The admin pilot does not establish staff Google authorization or permit any
Google invitation/meeting creation.

Staff-owned Google authorization now has separate implementation evidence:
[staff Google checks](../qa/google-staff-calendar-2026-10-24.md).
Before its production use:
- [ ] Confirm/apply private-table migration `0087` on the approved production target.
- [ ] Configure the dedicated Lexy Google OAuth application and environment-specific URLs.
- [ ] Complete the two-owner live acceptance in the [setup guide](../engineering/google-staff-calendar-setup.md).
- [ ] Do not interpret this read-only connection as panel sharing or meeting/invitation authorization.

Google candidate-only invitations now have a separate opt-in, reviewed write
path: [implementation](../engineering/google-interview-invitations.md) and
[checks](../qa/google-interview-invitations-2026-10-24.md).
- [ ] Apply/verify migration `0088` on the approved production target.
- [ ] Obtain fresh optional write consent per organizer; do not upgrade readonly grants.
- [ ] Complete isolated live acceptance before claiming Google sends or Meet work in production.
- [ ] Keep subsequent Google event edits/cancellations human-approved through
  the separate operation controls; native edits alone do not synchronize them.
- [ ] Complete the [Google operations live acceptance](../engineering/google-interview-operations.md)
  on consenting isolated accounts; automatic retry/replacement must remain disabled.

## 2. Target database before updated API rollout

- [ ] An authorized operator identifies the actual API deployment and database.
      Do not infer the target from a local `DATABASE_URL`, a preview hostname,
      or development migration success. Keep credentials out of evidence.
- [ ] Review migration history through the project's approved process. Check
      applicable prerequisites and additive scheduling migrations:

      | Migration | Purpose |
      | --- | --- |
      | `0078_interview_booking_links.sql` | Private booking links and invalidation |
      | `0079_interview_calendar_invitation_attempts.sql` | Durable invitation intents |
      | `0080_interview_time_change_requests.sql` | Candidate change requests |
      | `0081_interview_time_change_withdrawal.sql` | Request withdrawal |
      | `0082_interview_calendar_invitation_changes.sql` | Controlled invitation changes |
      | `0083_calendar_panel_consents.sql` | Mailbox-bound panel-sharing grants |
      | `0084_interview_schedule_panels.sql` | Retained interview panels |
      | `0085_calendar_working_hours.sql` | Staff working-hour preferences |
      | `0086_panel_invitation_snapshot.sql` | Approved panel invitation snapshots |

      This is an inventory, not a command to blindly rerun migrations. Confirm
      the actual target and existing objects before any approved DDL.
- [ ] Apply necessary approved migrations **before deploying the updated API**.
      In particular, existing invitation reads select the `panel_snapshot`
      column added by `0086`, even for candidate-only attempts.
- [ ] Run `node scripts/check-recent-db-schema.mjs` in an approved environment
      connected to that verified API database. Review its exit status and
      complete boolean evidence; it runs read-only and does not migrate.
- [ ] Retain the target attestation and metadata report separately. The report
      deliberately says `not-independently-attested`; a workstation run alone
      must not be relabelled production verification.
- [ ] Follow the publishing process and confirm API and frontend compatibility
      on the same release/environment. Do not assume publishing migrates an
      external database.

See [database readiness](recent-database-readiness.md) for the metadata check's
scope and limitations. Do not use an ORM schema push as a replacement for the
reviewed security migrations.

## 3. Real Outlook acceptance — team participation required

Use only an isolated synthetic requisition/candidate, employer-authorized test
staff mailboxes and an explicitly approved recipient inbox. Do not reuse older
Linx work orders or contact real candidates as a test.

- [ ] Confirm the organizer's calendar connection and separate calendar consent.
      Existing Outlook email access is not evidence of calendar permission.
- [ ] Each panelist deliberately grants sharing for their connected mailbox;
      verify staff scope and working hours. Do not grant sharing on their behalf.
- [ ] Save a reviewed panel with a suitable future time and then confirm the
      native proposal through the candidate path. Native confirmation must not
      itself send an invitation or claim an external reservation.
- [ ] Verify the candidate can see only staff-published offered times, not raw
      free/busy data, calendars, panel email addresses or private feedback.
- [ ] For a confirmed schedule with no existing invitation/event, open
      **Interview Coordinator → Invite panel**. Verify the organizer, candidate,
      panel recipients, time zone, start time and duration before final approval.
- [ ] With explicit permission to send one real test invitation, confirm once.
      Verify one organizer-owned Microsoft event and the exact reviewed guests;
      the organizer must not also be duplicated as an attendee.
- [ ] Check the candidate's actual invitation in the recipient inbox and confirm
      other guests' addresses are hidden. Check the organizer and each panelist
      view as well: Microsoft's real behavior, not a mock, is the acceptance
      evidence for `hideAttendees`.
- [ ] Record Microsoft acceptance, inbox delivery and each guest's RSVP as
      separate facts. A sent request does not guarantee guest acceptance or a
      reservation of every guest's calendar.
- [ ] Reload/reopen the status and verify the same receipt without another
      provider write. Never deliberately induce a timeout by repeatedly sending
      real requests; use intercepted fixtures for ambiguous-response tests.
- [ ] Confirm existing personal holds or guest meetings are not silently
      converted, replaced or updated by the panel-send action.

## 4. Stop and recovery rules

- A stale version, changed roster, revoked sharing, changed mailbox, new busy
  period or unavailable provider invalidates approval. Reload and review; do
  not bypass the check.
- If Microsoft may have accepted a request but the receipt was lost, preserve
  the durable attempt and use read-only status reconciliation. If it remains
  uncertain, have the authorized organizer inspect Outlook. Do not delete or
  reset the attempt, fabricate approval evidence or automatically resend.
- Changes to an already-created panel meeting remain an explicit organizer
  action in Outlook; the candidate-only change workflow must not edit it.
- If rollout verification fails, do not enable staff use or guess that missing
  data means no saved panel/attempt. Follow the approved release recovery
  process; do not drop private tables or remove RLS, grants or erasure barriers.

Production rollout and live acceptance remain pending until the corresponding
evidence above is recorded. This document itself performs no migration,
deployment, calendar change or email send.
