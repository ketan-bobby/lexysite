# Legacy outreach retry safety

## Completed scope

The shared first-touch dispatcher and scheduled campaign sender now save a
compare-and-set claim before provider I/O. That claim stays in place through
post-send bookkeeping. Both request a single SES SDK attempt, complementing
the one-shot Outlook request path.

An uncertain result, provider exception, interrupted bookkeeping or unsuccessful
final persistence leaves a review hold. A second caller cannot acquire the same
unmodified source snapshot while the claim is present. The code does not replace
that hold with an ordinary error and then silently retry.

First-touch validation reads existing holds before it can mark a bad/missing
email as a new failure. Those validation writes also compare the source snapshot,
so a stale validator cannot overwrite a newly acquired claim. Already sent,
opened, replied or suppressed first-touch messages are not dispatched again.

The campaign sender skips held rows before enrollment, workflow-contact and
DNC preflight mutations. Those mutations also compare the original scheduled
state/reason, preventing a stale worker from clearing another worker's claim.
Existing ownership, contact approval and DNC checks remain in place.

Known explicit provider rejection and known non-attempt are distinguished from
uncertainty. The common guard does not create an uncertainty hold for those
results if final persistence succeeds. Existing caller approval/retry rules
still apply; this is not a new permission to contact a candidate.

SES network/timeout/server failures now report uncertainty rather than definite
non-delivery. Pre-dispatch validation and missing production configuration are
classified as not attempted. Supported explicit 4xx rejection responses remain
distinct. A failed email operation does not by itself prove that no mail left
the provider.

## Simulation cannot erase an attempt

`POST /api/outreach/enrollments/:id/simulate-next`:

1. Keeps the existing authenticated ownership checks.
2. Locks/rechecks the enrollment and the next step's existing messages.
3. Returns 409 for failed, claimed, unapproved, sent or other historical next-step
   rows, without deleting them or changing the enrollment clock.
4. Only resets a clean, unattempted scheduled step (or an absent step). Deletion
   and clock adjustment happen in the same transaction, so a provider claim
   racing the reset cannot silently proceed against a deleted step.

This deliberately removes simulation as a way to erase a prior failure. Even a
known rejected campaign step is history, not an unattempted scheduled draft.
Properly reviewed campaign recovery is separate from this testing shortcut.

## Representation and limitations

The existing failed-reason field holds an opaque local claim marker; existing
failed/scheduled/sent statuses and API contracts remain unchanged. No database
migration, model/prompt changes, new mail routing or production access.

The marker is not a provider receipt, send timestamp, delivery event or
exactly-once guarantee. No automatic expiry/release or manual “mark delivered”
override was added. Historical unclassified failures are not retrospectively
declared rejected or undelivered.

This covers the two named outreach send boundaries and the simulation reset,
not every transactional email/manual reply/re-engagement entrypoint. It does
not deduplicate different message rows or different campaign enrollments, recover
lost business counters automatically or provide a provider-idempotency contract.
Review the existing Activity log evidence before any further contact; do not
resend to repair bookkeeping.

## Verification

- Eight isolated guard/source tests: concurrent claims, unknown/legacy results,
  claim/final-write failure, post-send exceptions, known rejection/non-attempt,
  and the actual first-touch function's hold-before-invalid-email order.
- Existing Graph/SES/SNS/offer regression tests passed alongside the guard tests.
- Twenty-three authenticated development HTTP fixture tests passed, including
  five simulation history cases asserting 409 and byte-for-byte unchanged
  message/enrollment reads. Staff/tenant/recruiter positive and negative controls
  in that fixture remain intact.

All provider operations in these tests were mocked or not reached. No live
candidate invitation or real AI generation was used. The helper's concurrency
unit test is not a database load test; live provider/process-crash acceptance
remains a separate, explicitly authorized team exercise.
