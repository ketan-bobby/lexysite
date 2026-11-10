# Human identity resolution and synthetic pilot clearance

## Implemented

- Admin-only identity-resolution form in the work-order Workflow row, with explicit
  decision, evidence and acknowledgment; no automatic execution or contact.
- Corroborated real identity, internal synthetic staff-inbox clearance, or unresolved
  review. Human verification preserves original AI advice and does not invent scores.
- Test clearance completes only the workflow's labelled test review. Canonical identity
  and verification records stay pending and unverified.
- Test contact exception is bound to workflow/journey, source fingerprint and timestamp,
  canonical recipient, approved isolated work order and active authorised staff inbox.
- Pending identity records predating enrollment remain visible for resolution, never as
  completed verification evidence.
- Atomic source/workflow/journal updates, optimistic concurrency and idempotent receipt.
  Foreign owners/records, erased/DNC candidates, stale/paused/terminal workflows,
  out-of-order reviews and missing acknowledgment fail closed.
- Canonical-owner permission is separate from job/platform-discovery visibility.
  A customer controller cannot globally adjudicate another tenant's identity;
  the UI receives an explicit owner-scope permission flag.

## Verification

- Focused HTTP/contact regression checks and pending-source projection check passed.
- Actual form and WorkflowRow interactions passed one browser-only mock-based pass,
  including ISO JSON payload, explicit acknowledgment, role/state visibility,
  stale-source errors, no automatic retry and desktop/mobile layout.
- API build and security guards, frontend typecheck and lint passed (no lint errors).
- The earlier combined API stage exceeded its existing 240-second budget. The
  bounded-batch follow-up below resolves that timeout without dropping coverage.
- Final complete assisted baseline passed: 445 API tests across 37 files,
  50 frontend-logic tests, four batch-planner checks, five egress-guard checks,
  frontend typecheck, API build/security guards, zero lint errors and zero
  unformatted files. No test was skipped.
- The two API batches finished in approximately 101 and 118 seconds, each below
  the unchanged 240-second limit. This is the complete configured assisted gate,
  not proof of every UI journey, real transport delivery or a clean full API
  TypeScript project.

## Regression-gate follow-up

The runner now partitions its API manifest into independently bounded batches
without removing tests or increasing the existing per-process time limit. A
pure batch-planner test enforces complete, duplicate-free manifest coverage and
prevents overlapping log names. Stage timings and batch file lists are retained
in the summary. The runtime-evidence unit suite is now part of this gate.

Including that suite exposed an old expectation that all pre-enrollment pending
identity evidence was invisible. It is now aligned with the approved unresolved-
evidence exception, while continuing to exclude other candidates, future
activity and completed checks initiated before this workflow.

A new private mock-transport sequence proves synthetic clearance survives
legitimate progression without changing global identity: held draft, separately
controlled send, recorded Interested reply, human review, distinct invitation
authority and duplicate-attempt prevention. The real pipeline reply handler
defers automatic invitations. Transport acceptance is deliberately mocked; no
email is delivered, no real interview is created, and identity stays pending.

## Acceptance boundaries

HTTP tests use private cloned database tables with egress prohibited. UI tests use
browser-only intercepted API fixtures. Neither proves real provider corroboration,
transport acceptance, candidate interest or inbox receipt.

The development database was read only during implementation: no isolated enrolled
AUTONOMY PILOT workflow was found. No existing Linx work orders were modified and no
candidate contact or paid provider calls were made. Existing assisted features,
models, prompts, providers and commercial tiers remain unchanged.

After a human deliberately records the appropriate review, engagement still requires
a separately scoped pilot grant and explicit held-draft approval/send. An interview
invitation still needs bound positive interest, human review and separate authority.
