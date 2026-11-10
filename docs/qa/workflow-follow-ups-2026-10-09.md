# Separately approved workflow follow-ups

## Scope

An isolated-pilot check-in path now exists alongside the held legacy contact
lanes. It does not unlock general autonomous spending, create interview links,
rotate tokens, generate AI text or modify stabilized models/providers.

Staff can see held legacy campaign messages, prepare a separate plain-text
check-in, save/edit it, approve the exact stored version with an explicit
unknown-charge acknowledgement, cancel unclaimed follow-ups, and request a
due approved send. The existing 15-minute scheduler also handles due approvals.
Approval is not delivery. Provider acceptance is not inbox confirmation.

## Authority and replay rules

- Parent job and current candidate visibility are checked for reads and writes.
- Approval and dispatch require a currently active approver with job authority.
- Screening, identity and engagement must have human-reviewed evidence.
- Current identity corroboration or explicit synthetic-pilot clearance is checked.
- Recipient must still match the canonical candidate and controlled-inbox authority.
- Paused/cancelled/stale/unapproved work, declined contact, erased/DNC candidates,
  tenant messaging disablement, expired approval and future schedules are held.
- Workflow revision, journey, recipient and per-message version changes invalidate
  the previous approval. Editing creates an unapproved version.
- Every send has its own durable natural claim, distinct from first outreach
  and invitation claims. An uncertain original action blocks this new path.
- A claimed/unknown message cannot be edited, cancelled, automatically retried
  or relabelled as a fresh message to evade uncertainty.
- Claims precede transport. An interrupted process remains claimed, not retryable.
  In-flight effects may finish after pause or timeout; pausing blocks new claims.
- Usage remains workflow-attributed; actual charges remain unknown.
- Follow-up queue errors are logged without disabling assisted campaigns.

Journal and receipt persistence use the existing workflow control tables and
job lock. No schema migration, credential change, live follow-up approval,
candidate email or old Linx work-order update was performed.

## Verification

Four private-database test cases cover authenticated HTTP review, exact saved
snapshots, reload reads, edit invalidation, role/tenant gates, concurrent claims,
scoped usage, ambiguous outcomes, schedule timing, scheduler dedupe and contact
blocks. All outbound networking is denied; delivery adapters are fictional.

The regression run passed the other API tests, frontend logic/type-check,
API build/security guards, lint and formatting. One scheduler test initially
counted another test's restored approval; its counter was corrected to the
specific message being verified, without changing delivery behavior.
The corrected four-case run passed with outbound networking denied, including
the added DNC check. Formatting and whitespace checks pass. The API and frontend
are serving; the final API restart also passed its build and security guards.

The browser tester could not finish the consent flow: real browser signing was
unavailable, and the browser-only replay fixtures did not resolve workflow-state
rows. This is not successful authenticated UI acceptance. API persistence tests
and frontend type checks do not replace that remaining browser acceptance.

The older pilot invitation outcome is still unresolved. No historical claim was
released and no replacement invitation was sent. Budget-controlled general
sourcing dispatch and the pilot's final three evidence/decision steps remain
separate unfinished work.
