# Outreach draft and outcome coverage access — 2026-10-12

## Corrections

The authenticated outreach router previously treated tenant membership as
sufficient for candidate-role users. It now explicitly requires a staff role.
Public `/outreach/reply/:token` and `/outreach/reply-msg/:token` paths retain their
separate HMAC authority and are exempt from the staff gate.

Draft edit, approve and reject now verify the complete parent chain: the
message's campaign must match its enrollment, and the campaign must match the
enrollment's tenant and job. Data scope and recruiter ownership are checked
before either mutation or the approval endpoint's idempotent read.
Enrollment also rejects a supplied requisition which differs from the
campaign's requisition before creating an inconsistent draft.

`GET /outcomes/coverage` now requires staff status before aggregating. Existing
data-scope tenant predicates, recruiter assignments, empty-scope responses and
compliance exclusions remain intact.

## Proof

Twenty-two egress-guarded HTTP/database checks use disposable independent
customer fixtures:

- Anonymous/missing accounts are denied, as are candidate accounts whose JWT
  falsely claims a staff role. The live identity row determines authority.
- Foreign and nonexistent drafts share 404 responses. Denied edit, approval
  and rejection leave both the draft and enrollment unchanged.
- Unassigned recruiters and recruiter admins with no data scope cannot act.
- Mismatched campaign identity and mismatched enrollment tenancy are refused.
- Assigned recruiters can edit, approve and reject their own drafts.
- Existing hiring-manager and interviewer staff access is preserved.
- A second customer's recruiter can read its own scheduled approval response;
  another customer's admin cannot. Platform-wide access remains intentional.
- Public reply paths still reach their HMAC verifier without bearer auth.
- Coverage returns each customer's own positive counts and quality averages,
  excludes the other customer, respects recruiter assignments, and excludes
  erased/do-not-contact candidates.

The first fixture setup attempt correctly hit the database's erasure write
barrier. The fixture was corrected to create a historical outcome before
marking that candidate erased; no barrier was disabled.

Fixtures use invalid-domain recipients, stopped enrollments and disabled draft
campaigns. Approval checks exercise queue state only and immediately cancel
their fixture message; no delivery test or real candidate contact is performed.
Fixtures and their audit rows are cleaned up.

These are application-layer authorization checks, not proof of request-role RLS
permissions or a completed real provider-delivery journey. Four historical
Class-B tripwires were replaced with specific reviewed reasons backed by these
tests; remaining unreviewed paths are not certified.

The new suite is part of the assisted regression manifest. Models, prompts,
rubrics, provider routing, free pilot entitlements, controlled offers and
historic Linx records are unchanged.

## Regression progress evidence

The assisted runner now writes an atomic `summary.json` before its first check,
before each subsequent check, after each result and at completion. It announces
that path immediately. An interrupted run retains completed evidence and its
active step with `complete: false` and `status: "incomplete"`; a partial set of
passes cannot appear as a completed green gate.

Only a finished nonempty all-pass report is marked passed. Duration, signal and
exit-code metadata are recorded before checkpointing. Eight new journal checks
passed, together with the nine existing batch/shard planner checks.

This is checkpoint reporting, not automatic resumption or cached test success.
Every invocation still executes its configured checks. Reports survive command
interruption within the current container; long-term CI artifact storage is not
provided by this change.

## Verification outcome

- The broad command completed 611 API checks before its five-minute outer
  deadline interrupted the first workflow-journey shard. Its report correctly
  remains incomplete rather than claiming a full gate pass.
- All three remaining journey shards passed separately: 27, 20 and 18 checks.
  The additional canonical enrollment check passed separately after its fix.
  Total backend evidence is 677 passing checks across these runs.
- All 128 frontend logic checks passed, as did the frontend typecheck.
- Restarting the managed API completed its strict typecheck, twelve build-gated
  safety checks and bundle, then served requests successfully.
- Repository ESLint returned zero errors; existing warnings remain. Repository
  formatting and patch-whitespace checks passed.
- Live unauthenticated coverage returns 401; the public invalid reply token
  reaches its verifier and returns 400. The visitor sign-in screen renders.

The full single-command assisted gate was not completed; its unchanged offer
browser phase was not rerun in this pass. Separate successful batches must not
be described as a completed single-command gate or blanket production proof.
An existing dormant-Stripe configuration alert remains at startup; no billing
activation or secret change was made.
