# Candidate inactivity and self-reported job-change mail

## Completed scope

The platform inactivity sender and candidate self-report sender now reserve a
pending communication record in a short, independently committed development
database transaction before transport I/O. A candidate/message-type advisory lock
serializes competing reservations. The provider call runs **after** that
transaction commits; no provider promise is held inside it.

This closes the gap between checking a cooldown and recording the result:

- Parallel eligible calls cannot both reserve the same current cadence window.
- Provider uncertainty, an exception, or a final receipt-write failure leaves
  the sender's pending record held for review. There is no automatic hold expiry.
- Explicit rejection/non-attempt is recorded as failed, without inventing
  acceptance. An otherwise eligible later attempt gets its own record.
- Accepted processing is recorded as sent with its receipt timestamp. This is
  not proof of delivery, inbox placement or reading.
- Explicit simulation/suppression leaves no false sent count or cooldown receipt.
- Each later valid reminder cycle gets a fresh identity; a permanent
  manual-reply/body-hash key is deliberately not reused.

## Existing behavior retained

- Passive inactivity starts at 30 days, inactive at 90 days.
- Accepted inactivity mail retains the 30-day passive / 60-day inactive cadence.
- Self-reported job changes retain the shared 30-day follow-up receipt cooldown.
- Both named senders keep their existing SES routing and request one SDK attempt.
- Existing subject/HTML templates and branding remain unchanged. The HTML-only
  transport behavior is retained while a summary is stored for the activity log.
- Fuzzy title/company matching and cosmetic spelling sync remain unchanged.
- DNC and erased candidates are not contacted. Self-report discovery pause
  continues to suppress email without suppressing an allowed profile update.
- Platform own-profile nudges retain their existing candidate-directed privacy
  policy: employer discovery visibility is not converted into a new global
  lifecycle-email restriction.
- Missing tenant branding never falls back to Lexy for a tenant-owned profile.
- Erasure is terminal: an already-erased canonical profile is not rewritten.

Reservation rechecks current ownership, recipient and relevant snapshot fields
before contact. It also checks quiet flags. Candidate updates still synchronize
when congratulations mail is suppressed, held or fails. Unrelated manual-reply
or interview pending records are not treated as this sender's global contact lock.
Existing accepted receipts continue to participate in the shared cooldown.

## Implementation

- `artifacts/api-server/src/lib/cadenced-communication.ts`
- `artifacts/api-server/src/lib/candidate-reengagement-scheduler.ts`
- `artifacts/api-server/src/lib/self-report-reengagement.ts`
- Existing recorded-communication transport and scoped finalization store.

No schema migration, production access, payment guardrails, LLM/prompt changes,
or new employer-facing use of private career information.

## Verification

29 focused/regression tests passed across cadence, self-report, recorded mail
and existing manual-reply/reminder wiring. Coverage includes:

- Real development-database reservations, concurrency, positive future cadence
  cycles, preserved failed history, pending uncertainty and interrupted writes.
- Profile sync through held outcomes; DNC, discovery pause, erasure, stale
  ownership/profile/email checks and unresolved branding.
- Shared legacy accepted receipts versus unrelated pending messages.
- Simulation/suppression, invalid cadence and reservation failure.
- The current platform loop executed with injected dependencies, verifying
  passive/inactive intervals and truthful accepted-versus-skipped counts.

Fixtures were synthetic and cleaned up; transport was mocked or not reached.
The self-report regression suite no longer removes/restores credential values
to simulate mail—it injects an accepted mock transport instead.

## Explicit limits

The initial increment covered the two senders above. The November 10 handover
adds status-check-in reservation sharing and separate weekly-digest receipts;
see `docs/qa/code-handover-closeout-2026-11-10.md` for current verification.
The earlier default-disabled monitor description was incorrect for current
startup: status check-ins are default-on with their existing opt-out. This was
documented correctly without changing the flag or provider behavior.

Historical unclassified failures are not retroactively declared undelivered.
Reservations and current privacy reads cannot atomically recall an accepted
external email. The inactivity scheduler's existing selection of recent pool
pushes is unchanged; this is not a redesign of activity or ranking.

There is no override that declares a pending attempt accepted or automatically
resends to repair evidence. Real provider/team acceptance remains separate from
these isolated tests.
