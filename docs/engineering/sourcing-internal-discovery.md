# Approved local-only internal discovery

## Available scope

Work-order Overview → workflow planning → sourcing controls now supports Start
internal discovery and Resume internal discovery against an approved allocation
hold. This is actual database discovery, not a simulated external-provider run.

- Existing approved journey, active work order, Autonomous mode and approved
  sourcing limits are required. Preparing holds still requires budget authority.
- Assigned recruiters can run the local discovery. Current staff status,
  tenant/work-order authority and the human approver are rechecked.
- Only the job's exact client tenant and tenant-owned candidates are searched.
  Internal Mobility includes current employees only; otherwise discovery includes
  known nonemployees. Platform/personal profiles, erased and do-not-contact rows
  are excluded.
- Ranking is the existing deterministic local skill/title match, **not an AI
  assessment**. The approved candidate cap bounds the saved shortlist.
- No paid provider/model, application linking, stage transition, outreach,
  interview or hiring decision is dispatched by this action.

Costs remain deferred/unverified. Local discovery does not unlock external
dispatch or create synthetic cost receipts. Subscription prices are unchanged.
Existing assisted tools remain available independently.

## Persistence and recovery

The internal plan is bound to the immutable hold/brief/policy identities. The
shared worker lifecycle claims an exclusive, generation-fenced lease and
heartbeats authority. Its original runtime deadline never resets.

Local search queries have a ten-second statement timeout. Pause, cancellation,
revocation or deadline expiry prevents committing the shortlist. A database query
already in progress may finish, but its result cannot bypass the final fence.

Completion saves ordered canonical candidate IDs in the existing execution lease
and a scoped completion event in the **same transaction**. Empty completion is
also durable. Repeated completed starts reuse that checkpoint rather than
searching again. Current privacy/compliance and employee mode are reapplied when
displaying saved results.

An interrupted, incomplete local search can be explicitly resumed after lease
expiry because it has no vendor or candidate side effects. A different/paid
operation plan cannot be adopted as an internal run. An expired deadline requires
a fresh approved hold, not silently extending the old run.

Paused internal work resumes its hold first, then starts a fresh fenced worker.
If that second action fails, the UI refreshes the real persisted hold state and
shows the error; resuming an allocation alone is labelled separately.

No new database schema or scheduler is required. This is request-triggered work,
not continuous background recruiting. Only final shortlist completion is
checkpointed; later multi-stage/provider result checkpoints are not implemented.

## Verification

- Assisted regression gate: 317 API tests, 34 frontend logic tests and five
  outbound-guard tests passed, with frontend typecheck, API build/structural
  guards and no-new-debt lint/format checks.
- Logs: `/tmp/lexy-assisted-baseline-V8QDRG`.
- Tests cover local scope/privacy, assigned-recruiter access, repeat completion,
  interrupted recovery, original deadlines, stale approvals, paused/revoked/
  expired checkpoint rejection and employee-only discovery.
- Signed-in browser verified Start, reload persistence, Pause → Resume, visible
  shortlist, no DNC exposure and no fixture-scoped paid operations, applications,
  outreach or pipeline runs.
- Browser testing found cramped phone spacing. Nested mobile padding was reduced
  and the workflow card widened within the existing page gutters; desktop
  spacing is unchanged. The post-fix phone layout was not separately browser-tested.
- Test fixtures were removed. No live paid sourcing run or publish occurred.

## Remaining phases

External sourcing requires audited request-level ports and its separate live
activation boundary. Durable external results, dynamic provider stage planning,
candidate linking/screening, engagement and interview orchestration remain
separate work. This phase does not enable the full autonomous hiring pipeline.
