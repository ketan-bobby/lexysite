# Target-company role-alert safety

## Candidate-facing publication boundary

Internal creation and approval do not announce a role to target-company
subscribers. In this product, `active` is an internally available work order;
`published` is the explicit career-site publication action. Role-alert fan-out
now runs after that authorized action, and after eligible edits to an already
published work order. It reloads the job and rejects confidential or
non-published roles.

Deferred alerts are not permanently lost: staff can approve and then publish
a role, or explicitly clear confidentiality on an already published role.
The ordinary edit route cannot directly enter publication or move an
approval-protected draft/pending/rejected job out of its workflow. Candidate
and interviewer accounts cannot use ordinary editing to reveal a job.
Clearing confidentiality on a published role requires publication permission.
Existing tenant and recruiter-assignment checks remain in force.

## Current authority at delivery

`role-alert-policy.ts` reloads the canonical job, employer, candidate and
candidate subscription. The emitter does not trust supplied company/title
snapshots. It requires a published, non-confidential job, a current matching
subscription and a non-erased candidate.

Do-not-contact, discovery pause, empty destinations and synthetic placeholder
addresses suppress email without consuming an email claim. An otherwise
eligible candidate-private activity entry is retained: quiet does not mean
discarding the candidate's own activity history. Erasure or a withdrawn
subscription suppresses both new activity and email.

The private feed write is serialized per candidate/job with a transaction
advisory lock. Current authority is loaded under share locks in that
transaction, and duplicate calls create one feed event rather than repeated
events. The existing six-hour atomic email cooldown remains unchanged.

Immediately before transport, current job visibility, contact settings and
subscription are read again. Committed withdrawal or opt-out observed at that
check suppresses delivery. Acquired claims are not released automatically
after a failed, suppressed or uncertain attempt. Transport results that are
failed, simulated or suppressed are not logged as successful delivery.

This is not a distributed exactly-once guarantee. A preference change after
the final check/provider handoff cannot recall an email. Existing historical
events and already-delivered email are not retrospectively erased by these
job-alert changes.

## Verification

One combined run passed **60 tests, zero failed, zero skipped**:

- Nine sender-policy regressions with intercepted transport and disposable
  development fixtures: eligible positive, concurrent deduplication, blocked
  job states/confidentiality, DNC and pause, withdrawn/malformed subscriptions,
  invalid destinations, final-check changes, thrown/returned transport
  failures and erased/missing candidates.
- Six real HTTP job/privacy regressions, including deferred approval and
  publication, confidential-role recovery and candidate-edit rejection.
- Assisted job baseline, recruiting-configuration authorization/mode coverage,
  private-development read firewall and employer-presentation firewall.

The new sender suite is registered in the consolidated release runner.
API typecheck, build and all build guards pass after these changes, and the
managed API restarted successfully. Targeted lint has zero errors and seven
existing unused-import/variable warnings across jobs and market-event emitter.
The public login screen renders; the authenticated policy paths were verified
with the HTTP/database tests above, not the unauthenticated screenshot.

The focused verification above was followed by a fresh consolidated execution
on 2026-11-02, from 11:47:14 to 12:02:46 UTC. All 49 check groups passed,
including these sender/HTTP suites, 101 API files, frontend logic, nine browser
groups, strict typechecks, build guards, lint and formatting. The result and
its acceptance limitations are recorded in
`assisted-release-verification-2026-11-02.md`.

Role-alert delivery and model triggers are intercepted in the relevant
fixtures. No real role-alert email or live provider acceptance was tested.
No production access, database migration, billing change, model, prompt or
provider-routing change was made.
