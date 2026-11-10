# Controlled workflow preparation

## Agreed order

1. Complete one live, approved controlled workflow.
2. Finish the controlled autonomous sourcing lane.
3. Extend bounded engagement beyond the first-contact pilot.
4. Implement human and mixed interview coordination.
5. Add independent automated identity verification only if that optional
   capability is required; human corroboration remains supported.
6. Complete operational and production acceptance.
7. Clean up the remaining full-backend TypeScript errors.

The first item is in progress, not accepted as complete.

## Prepared configuration

A new isolated AI-path work order, `WO-2026-LIVE-MAIN-0013`, now has the
`[AUTONOMY PILOT]` label, an approved journey and one enrolled workflow.
The older standalone/E2E work orders and their interview evidence were not
relabelled, reset or imported as completed workflow evidence.

All six steps are still pending because configuration is not execution.
Auto-run is false; the new work order has zero outreach messages and zero
linked interview sessions. No provider invocation, invitation or hiring
decision was made.

The current recipient matches an active candidate-portal account, not an active
staff account eligible for the controlled live pilot. Live authority has not
been granted. Obtain an eligible staff/admin inbox and verify its scope before
binding the recipient and requesting separately approved execution.
Do not change an existing user's role merely to bypass this safeguard.

Subsequent authorised work added the alternative, one-workflow, one-hour
admin-approved candidate-login test recipient described in
`workflow-test-recipient-permission-2026-10-08.md`. That narrow permission was
approved for this pilot without changing the login role; agent and contact
authority remain separate. The preceding paragraph describes the original
preparation checkpoint, not the current state.

## Tooling and verification

- Preparation now uses the label recognised by the current pilot policy.
- Reuse rejects mismatched titles, interview paths and ownership rather than
  changing old work orders.
- Privacy checks use the canonical erasure field; do-not-contact, erased,
  foreign-owned and platform-pool profiles fail preparation.
- Four focused policy tests passed under the external-egress guard.
- Guarded read-only preparation passed before the configuration write.
- Authenticated workflow-state HTTP read returned 200 and confirmed one approved,
  enrolled workflow with all six steps pending.
- Database inspection confirmed auto-run false, messages zero and interviews
  zero for the new work order.
- Targeted lint and formatting passed.

This is preparation, not live delivery acceptance or a completed autonomous run.
