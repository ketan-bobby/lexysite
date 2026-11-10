# Controlled Stage 2 verification — 2026-10-09

## Live scope

A fresh isolated synthetic tenant, fictional SQL profile, approved journey and
fictional staff inbox exercised the real HTTP verification activation/execution
boundaries. Screening was explicitly cleared as synthetic prerequisite setup;
there was no additional screening-provider call or qualification claim.
The profile was marked as a synthetic fixture before assessment.

The existing verification agent made one successful request through its unchanged
OpenAI proxy/gpt-4o configuration. It returned profile-consistency advice with a
`review` verdict. Canonical candidate and identity-record statuses stayed pending;
`identityVerified` stayed false and the displayed overall score stayed null.
Saved runtime activity explained that this is pending identity advice, not
completed verification or a job-fit assessment.

The receipt records 300 input tokens and 140 output tokens. Dollar cost remains
unknown. No independent identity source was queried. This confirms the existing
advisory and human-resolution boundary, not autonomous independent verification.

## Completion safeguard

The generic evidence path previously allowed a manual note to complete a
verification workflow step even while canonical identity remained unverified.
It now requires both the owner-scoped identity record and canonical candidate to
be verified, including the explicit record `identityVerified` flag. A note alone
or inconsistent “verified” status labels cannot satisfy that condition.

Existing corroborated identity may still be reviewed through this path. The
separate identity-resolution service retains its explicit workflow-only
synthetic-test clearance without verifying the fictional person. The evidence
form now explains these distinctions and displays the API's existing errors.
No model, prompt, provider, pricing or assisted legacy configuration changed.

## Acceptance

After a new snapshot read, real HTTP negative tests confirmed:

- Manual-note completion of pending verification: 409.
- Completion using the pending AI source: 409.
- Corroboration without explicit acknowledgment: 400.
- Outreach activation before resolving verification: 409.

Rejected requests did not change the workflow revision or identity record.
Verification and all downstream steps remained pending. There were no scoped
outreach messages or interview sessions. The one-step execution permission was
revoked afterward.

Three selected isolated PostgreSQL/HTTP regression tests passed with provider
egress blocked: existing corroborated/unresolved resolution, the new completion
guard including inconsistent labels and valid saved verification, and separate
verification authority with a substituted model “clear” response. These
substituted checks are distinct from the one live provider request.
Frontend typecheck and focused lint passed; both services restarted successfully.

An initial fixture-only setup used a mutation envelope instead of the persisted
workflow revision. It failed before any provider call. That unfinished fixture
was narrowly identified and removed, and the corrected setup read the actual
revision. No live request was repeated to repair setup.

Disposable recruiting records were removed after acceptance. The numeric
provider receipt remains for actual-request cost attribution.

## Remaining scope

Real independent identity verification requires independent corroboration and
explicit human review or a separately approved identity-provider integration.
The current agent does not supply that proof. Stage 3 remains a separate,
controlled outreach/interest sequence; this check did not send an email or
authorize any downstream contact.
