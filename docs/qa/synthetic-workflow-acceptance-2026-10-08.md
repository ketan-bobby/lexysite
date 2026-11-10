# Scoped live-screening activation — additional milestone

Admin controls now permit an expiring internal profile-screening pilot on a
separate `[AUTONOMY PILOT] ` work order. Activation requires an approved current
journey, a ready workflow, a candidate inbox matching active internal staff in
scope, and explicit acknowledgement that provider costs are unknown.

- Activation is configuration only: it does not launch an agent or send mail.
- One natural screening claim per workflow/journey; expiry, revocation and
  changing request keys do not grant a retry of a claimed action.
- Authority is rechecked before preparation and within the serialized claim.
- Native screening is forced to exactly the canonical candidate, including
  overriding conflicting batch targets. Zero-work or malformed grading output
  is uncertain, not successful. Native screening can update its usual scores
  and pipeline classification; it does not complete the workflow review step.
- Workflow-bound agents no longer launch unclaimed legacy background rescoring.
  Existing assisted/background behavior outside this path is unchanged.
- Source updates in bounded screening are restricted to the job's tenant.
- Human evidence review remains mandatory. A completed agent call does not
  complete the screening step or authorize subsequent actions.
- Outreach, verification, invitations and full metered autonomy are NOT unlocked
  by this screening permit. Existing assisted external sourcing is unchanged.

Verification uses private synthetic database fixtures and controlled native-core
outputs. It is not a real-provider screening acceptance run, a delivery claim,
or proof of a completed six-step autonomous journey. No live grant or candidate
email was issued while building this milestone.

The regression pass reported 417 API checks, 50 frontend-logic checks and five
test-egress checks passing, plus frontend typechecking and the API build/security
guards. The initial formatting-only failure was corrected separately. Later
focused checks cover malformed-grade rejection and the distinction between
journey approvers (including hiring managers) and pilot-authorising admins.
Browser-only mocked UI verification covered gated activation, normalized request
data, no automatic execute/send, reload persistence, revocation, visible
conflicts, non-approver restrictions, claimed-action disabling and Pause.

# Synthetic workflow acceptance

Date: 8 October 2026

## Scope

Fictional candidate profiles and controlled source results exercised the real
workflow HTTP routes, authentication, authorization, evidence reader, transaction
logic and persistence. This was not a browser journey or live-provider test.

An independently owned PostgreSQL schema contained every fixture table and was
removed at teardown. Fixture connections cannot fall back to application tables,
and an explicit shared-table access attempt was rejected. Existing Linx work
orders and the earlier live pilot were not updated. The supplied optional
personal profile link was not fetched or used.

The test-only network guard allowed only its local HTTP harness and denied
provider access, including local AI proxies. No sourcing, email, voice,
screening-model or verification-model calls were made. Source results labelled
sent, verified or assessed were deliberate test inputs, not real-world claims.

## Verified behavior

- All six AI-path workflow steps begin pending, with human-review authority.
- Anonymous reads receive 401; foreign-account reads receive 404.
- A recruiter cannot approve the journey; an authorized admin can.
- A saved screening result becomes observable without completing the step.
- Pending verification is visible but cannot be accepted as completed evidence.
- Flagged verification remains visible for explicit human review.
- A review-required step blocks progression until resolved and reviewed.
- Sent outreach alone cannot satisfy engagement; a recorded positive reply can
  be reviewed after the preceding steps.
- Interview assessments do not automatically complete workflow steps and do not
  expose private answer text.
- Evaluation cannot be accepted before the interview step.
- Pause blocks new evidence acceptance; changed briefs prevent resume.
- Cancel retains completed evidence, cancels remaining steps and is terminal.
- Final decisions require an approver; retrying the same accepted decision is
  idempotent.
- Completing the fixture workflow does not move its application pipeline stage.
- Workflow planning/review/control leaves the AI job queue empty.

## Initial source-acceptance results

The new HTTP integration suite and existing projection suite passed together:
23 tests, zero failures and zero skips. Targeted lint and formatting passed.

The repeatable command is:

    pnpm --filter @workspace/api-server run test:workflow-journey

The integration suite is also included in the assisted-baseline test list.
The whole assisted baseline was not rerun at that initial test-only stage.

## What remains unproved

- Paid autonomous dispatch remains locked; no live pricing/adapters were enabled.
- Workflow Pause/Cancel is not a stop authority for separate untagged legacy
  assisted automation. The explicitly bound execution boundary is described
  below; legacy calls are not retroactively enrolled.
- The fictional screening and verification inputs do not validate real models,
  independent identity checks or vendor delivery.
- Recruiter UI interactions were not driven in a browser.
- Cloned fixture tables do not copy RLS policies. HTTP foreign-account rejection
  passed, but this is not a new RLS-policy acceptance test.
- The real pilot still lacks a résumé and has unresolved identity review.

Models, provider routing, prompts and existing external sourcing are unchanged.

## Workflow-bound execution boundary

The agent-start and first-touch-send entry points now accept an explicit
server-side workflow binding. Untagged existing callers retain their previous
behavior; a recruiting-mode label alone does not enroll a legacy action.

The boundary revalidates current staff authority, requisition access/approval,
the exact approved journey and brief, workflow revision/status, candidate
eligibility and the first unresolved step. It rechecks after preparation.
Human hiring decisions and evaluation reviews cannot be executed by an adapter.

A durable claim is the start point, serialized with the same lock used by
Pause/Cancel. A saved Pause or Cancel prevents a subsequent claim. Already
claimed work may finish, with its outcome retained as history. Provider calls
do not keep a database transaction open.

Claims use stable workflow/journey/step/action identity, so changing request
keys or pausing/resuming does not authorize a duplicate effect. Exceptions,
timeouts and unconfirmed results remain uncertain and require reconciliation;
they never automatically complete workflow steps or become permission to resend.

Agent-generated outreach in this new lane remains approval-required even when
the work order has prior approved first-touch messages. New workflow-bound
agent input is restricted to the enrolled candidate, with no whole-job fallback.
Direct workflow-bound sends validate message/source and recipient identity.

Controlled adapters are test-process-only. Real adapters retain the existing
new-paid-lane lock. This change neither enables paid providers nor disables
existing external sourcing. Browser interaction and live provider execution
remain outside this acceptance.

## Execution-boundary regression results

The complete assisted regression gate passed after the runtime changes:

- 406 API tests passed, with zero failures or skips.
- 50 frontend logic tests passed, with zero failures or skips.
- All five test-network-guard checks passed.
- Frontend type checking, API build/security guards, lint and formatting passed.
- The private workflow integration suite now contains 19 passing checks,
  including preparation/Pause and preparation/Cancel races, concurrent different
  request keys, uncertain outcomes across Pause/Resume, deadlines, negative
  confirmation, in-flight completion, and both production entry-point fences.

This is not a clean full API type-check claim or a live-provider/browser journey.

The managed API was restarted once and is serving requests. The public sign-in
page rendered normally afterward. Startup also emitted the pre-existing dormant
Stripe-key warning and its platform-admin alert email; no billing secret,
checkout setting or candidate invitation was changed by this work.

## Approved-workflow launch and durable outreach ownership

The candidate workflow now has a **Request next action** control and an
authenticated HTTP endpoint. The server derives the candidate, journey version
and next executable step from the scoped workflow; callers cannot substitute
candidate IDs, arbitrary agent inputs or provider choices. Requests carry the
displayed workflow revision and use the existing guarded agent entry point.
The UI reports refusals and refreshes workflow state after either success or
failure. Human coordination, evidence review and final decisions remain separate.

New workflow-generated first-touch drafts and their ownership records commit
together. The shared dispatcher recovers that ownership even when an older
approval route supplies no execution context. It rechecks current controls and
the original approved journey before any send. Canonical candidate identity and
job membership are also verified for globally stored sourced profiles.

An approval refused before the physical action claim releases only that
request's approval stamp, so the draft is not stranded after Resume. Uncertain
provider outcomes do not release their claim or authorize automatic retries.
Replacement drafts retain ownership and require fresh approval; the older
work-order-wide approval shortcut cannot auto-send them. Regeneration itself is
blocked before model access when workflow controls or live activation forbid it.

These connections do **not** unlock live providers, auto-accept evidence, migrate
existing Linx work orders, or retroactively bind unrelated legacy messages.
Scheduled follow-ups and other separately initiated legacy actions are not
covered by this first-touch binding. Live end-to-end execution and signed-in
browser acceptance remain outstanding.

### Verification of these connections

- The broad regression gate passed 412 API tests, 50 frontend logic tests and
  five network-guard checks, with frontend type checking, build/security guards,
  lint and formatting also passing.
- After the final concurrent-approval response fix, the focused private HTTP
  suite passed all 26 checks. Targeted lint passed. The only subsequent source
  edit was formatting that test assertion.
- The new checks cover launch authorization/input validation, stale revisions,
  Pause/Cancel, the retained activation lock, durable draft ownership, fresh
  approval, sourced identity, approval-stamp recovery, regeneration refusal and
  concurrent approval responses. Existing unbound drafts remain unbound.
- No candidate emails or provider/model calls were made by these tests. This
  remains controlled acceptance, not a claim of live autonomous hiring.
