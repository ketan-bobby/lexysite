# Controlled contact pilot — 2026-10-08

## Implemented scope

Isolated pilot controls now support separately approved engagement and AI
interview-invitation steps alongside screening and advisory identity assessment.
This is not unrestricted autonomous rollout.

- Engagement requires saved verified identity evidence and prior human-reviewed
  workflow steps. Pending model advice cannot satisfy the identity prerequisite.
- Engagement grants permit one held draft and one separately approved first-touch
  send. Renewing an unused send window cannot authorize another draft or resend.
- Invitation activation requires a positive reply to this workflow's bound,
  sent message, valid reply chronology and human-reviewed engagement.
- Prerequisites and authority are checked again at the atomic action claim.
- Bound legacy reply helpers and unbound interview-agent batch paths defer to
  the workflow instead of generating invitations. Manual reply logging does not
  advance stages or create an INTERVIEW_INVITED event when deferred.
- Mere planning/enrollment does not transfer legacy contact ownership. Persisted
  draft ownership remains authoritative even if the work-order mode changes.
- Native completion requires one held draft or one accepted real invitation;
  generated links, suppressed recipients and simulated sends are not acceptance.
- The invitation recipient is snapshotted before claiming and checked again
  before delivery. Bound invitation URLs use the existing environment-aware
  URL helper.
- Models, prompts, providers, external sourcing, commercial tiers and existing
  complimentary Enterprise access were not changed.

## Verification

The assisted regression gate passed 478 tests: 423 API, 50 frontend logic and
5 egress-guard tests, plus frontend typecheck, API build/guards, lint and format.
After final ownership/route corrections, the six contact-focused private-DB
tests passed across a five-test successful pass and the repaired real-HTTP
manual-reply test. The latter also exercised the actual interview agent's
explicit-candidate and batch fallback paths without model or mail calls.
Final API build/guards, frontend typecheck, lint (zero errors; warnings remain)
and format checks passed.

The single browser-only testing pass, continued over its discovered fix,
verified real contact-control components with all API traffic intercepted:
normalized inboxes, explicit step keys, cost acknowledgment, no execution on
activation, disabled duplicate-draft controls, unused-send renewal, claimed-send
and claimed-invitation blocks, non-controller and paused states, and visible
409 errors. The mock did not propagate successful activation into fixture
props; post-activation browser persistence was not claimed. Real HTTP tests
covered persisted approval state.

The full API TypeScript check still fails on existing project-wide errors. It
was used to identify and correct new undefined names/types; the focused gate is
not a claim that the entire API is type-clean.

## Limits and next acceptance

Private synthetic evidence and mocked adapter acceptance are not real identity
proof, real candidate interest or real transport acceptance. No candidate
outreach, invitation or new paid provider invocation was performed in this pass.
No older Linx work-order records were changed by these tests.

Resolve the pilot's identity evidence with actual corroboration before a
separately authorized controlled-inbox live contact test. Verify actual receipt,
Interested before invitation, environment-correct links and durable delivery
state. Human-interview and later workflow steps remain outside this pilot's
live authority; existing assisted capabilities remain available.

The API restarted successfully. Its pre-existing dormant-Stripe configuration
sentinel remains and emitted an operational admin alert on startup; this was
not a candidate message or activation of checkout.
