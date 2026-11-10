# Zoho stage handoff: preparation and simulation

For reviewed interview-progress and assessment notes, see
[Zoho interview notes](zoho-interview-notes.md). Publishing a note is separate
from, and never authorizes, a hiring-stage change.

## Available now

In **Settings → ATS connections → campaign → applicant review**, an employer
tenant admin can:

1. Save proposed mappings for Advance, Hold and Do not advance. Blank clears a
   mapping. Saving requires acknowledgment and the current mapping revision.
2. Review the exact external application, job and candidate IDs, the current
   human decision and its proposed target status.
3. Separately confirm a simulation. It records an immutable, deduplicated receipt
   with the reviewing admin, target status and evidence/mapping revisions.

Mappings are campaign-specific and apply to that campaign's imported job.
They are **proposals**, not provider-validated statuses. No labels are guessed
or supplied as defaults.

Changed evidence, another human decision, changed mappings, incomplete
interviews, unavailable candidates or revoked staff permissions block a new
simulation. Conflicts do not overwrite prior history. Current privacy and
erasure rules also apply to historical receipts. Deleting a recipient cascades
to its handoff receipts; candidate erasure also inventories them directly.

Recipient rows must match the campaign's employer tenant, Zoho account reference
and external job ID. Same-tenant rows with a mismatched account or job are excluded
from campaign counts/details and review queues; review details, decision saves,
handoff reads and simulations return unavailable. These checks do not substitute
for the provider-verified application → job → candidate binding below.

## Read-only metadata checks

The applicant handoff panel now has an explicitly confirmed **Check saved mappings
in Zoho** action. It verifies the current employer connection, reads the exact
job and application, proves the application → job → candidate IDs, and compares
saved mapping values against the provider's canonical status values. Display
labels are not treated as canonical values. Missing, ambiguous and obvious
offer/employment mappings are reported separately.

Reads are bounded to ten pages of 200 stage records, reject repeated IDs and
incomplete metadata, and recheck staff authority and connection custody around
provider I/O. Local privacy and mapping/decision revisions are rechecked before
returning a result. Raw records, tokens and provider error messages are not
returned or logged. Results are on-demand snapshots, not persistent approval.
Reloading requires a new explicit check.

Each mapping also returns a read-only disposition and a next action: configure a
mapping, review a missing/ambiguous value, use a separate human-controlled process,
or obtain application-specific transition verification. If an unambiguous,
unrestricted target exactly equals the application's current canonical status,
the result says **no update needed**. That observation is not proof Lexy made a
change and does not create a delivery receipt. Restricted and ambiguous statuses
are never cleared by equality. Every disposition has `canWrite:false`.
Unsaved edits and changed human-review revisions clear the displayed snapshot;
the handoff also refreshes every 30 seconds while the page is visible.

**A default-catalog match is not job-specific transition permission.**
Zoho's `GET /recruit/v2/settings/stages` documentation explicitly says that
application-enabled accounts return the default pipeline. The
`.../hiring_pipeline` and `.../hiring_pipeline_transition` endpoints document
history, not a complete list of permitted next transitions. The UI and response
therefore keep `transitionEligibilityVerified:false` and `liveEnabled:false`.
No historical status is inferred to be an allowed next status.

The existing OAuth scope list is unchanged by default. While connecting a new
account, an employer admin may explicitly select **Also request read-only stage
metadata access**, which adds only `ZohoRecruit.settings.stage.READ`.
Zoho may additionally require its Customize Zoho Recruit permission. A denied
read reports the required access; it does not silently escalate scopes.
Existing connections are not upgraded automatically. The current disconnect
and employer re-review process still applies to replacing a connection, and a
new connection revision invalidates old campaign bindings.

Official metadata documentation:

- https://www.zoho.com/recruit/developer-guide/apiv2/get-all-stages.html
- https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-of-a-record.html
- https://www.zoho.com/recruit/developer-guide/apiv2/change-pipeline.html

The change-pipeline API changes a Job Opening's pipeline assignment; it is not
an application's allowed-next-transition reader. The generic update-record API
can trigger workflows/approvals/blueprints and even add picklist values, so it is
not used as a shortcut for verified stage transitions.

## Deliberately not available yet

**There is no live Zoho stage executor in this release.** The only accepted mode
is `simulation`; `live`, caller-provided candidate/status overrides and
unconfirmed requests are rejected. No provider client or credential access is
present in the handoff service. Existing read-only OAuth scopes are unchanged.
Simulation receipts are never proof that an ATS update occurred.

The remaining implementation is:

- Read actual allowed job/application statuses or transitions, prove the exact
  application → job → candidate binding and verify the proposed mappings against
  the connected employer's **application-specific** pipeline and allowed actions.
  The application identity and default-catalog comparison above are implemented;
  per-application transition eligibility is not. Do not equate a global candidate
  status with an application-specific stage.
- Add a separately authorized live executor with explicit write consent,
  connection/version-bound approval, durable attempt claims, provider response
  verification and reconciliation of uncertain outcomes. Never automatically
  retry a possibly accepted request. A hiring decision, offer or candidate
  communication must not occur as a side effect.
- After those capabilities are built, have the employer authorize write scopes
  and validate one dummy application through the live path before activation.

Official provider documentation consulted:

- https://www.zoho.com/recruit/developer-guide/apiv2/change-status.html
- https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-transition-details-for-an-application.html

The status API documents multiple modules and job-scoped candidate status
inputs; those examples alone do not prove a safe application-specific write
contract for this employer. This release intentionally does not invent one.

### Provider contract needed before implementation

Public documentation rechecked on 2026-11-04, without employer credentials or
calls to an employer account:

- The Change Status page lists application UPDATE scope, but its purpose and
  payload examples describe candidates/job openings and use `Candidate_Status`.
  A scope name alone does not establish an application-ID request contract.
- Application hiring-pipeline transition details describe stage/status history,
  not an authoritative list of currently allowed next actions.
- These public documentation checks do not demonstrate that an application
  transition API does not exist. Its supported contract remains unverified.

Obtain the following from Zoho's official documentation or an authorized
provider confirmation before connecting a live writer:

1. The exact endpoint, HTTP method and payload that affect **one application**,
   including how application, candidate and job IDs are bound. Confirm that
   unrelated applications for the same candidate are unaffected.
2. A supported way to establish allowed next actions for that application,
   including any Blueprint requirements, mandatory fields and actor permissions.
3. The minimal write scope and the documented workflow/notification side effects.
   Do not silently request broader scopes or assume changing status sends no mail.
4. The per-record response and read-back contract, plus any provider idempotency
   or concurrency guarantees. A timeout after submission must remain uncertain,
   not trigger an automatic retry.

Only after the contract is established should the adapter be implemented against
recorded synthetic responses. Employer write consent and a separately approved
dummy-record live acceptance test are still required before activation. None of
these requirements authorizes production access or provider mutations.

## Public-contract investigation — 2026-11-05

This review used public provider documentation and the existing local handoff
source only. No employer records, credentials, OAuth changes or writes were used.
It does not establish that Zoho lacks an application-update API.

| Question | Public evidence | Implementation consequence |
| --- | --- | --- |
| Is there a plausible job-specific update route? | [Change Status](https://www.zoho.com/recruit/developer-guide/apiv2/change-status.html) documents `PUT /recruit/v2/{module_api_name}/status`. Sample input 2 supplies candidate `ids`, `jobids` and `Candidate_Status`; the scope table includes application UPDATE. | This is a candidate/job-scoped example, not proof of the module name, ID semantics and full behavior for an Applications-enabled employer. Do not infer `Applications/status` or replace application IDs with candidate IDs without confirmation. |
| Does application transition history list allowed next actions? | [Application transition details](https://www.zoho.com/recruit/developer-guide/apiv2/get-hiring-pipeline-transition-details-for-an-application.html) explicitly describes chronological stage/status history. | Historical transitions remain unsuitable as a current permission or mandatory-fields check. |
| Can Blueprint affect an otherwise valid status? | [Recruit Blueprint overview](https://help.zoho.com/portal/en/kb/recruit/automation/blueprint/overview/articles/zoho-recruit-blueprint) documents actor/role criteria, mandatory fields/checklists and interview-decision prerequisites. After-transition actions can send email, trigger webhooks/functions and update fields. | A canonical status match alone does not establish that the approving actor can perform the transition or that the operation sends no communication. |
| Is removing Blueprint a solution? | [Revoke Blueprint](https://www.zoho.com/recruit/developer-guide/apiv2/revoke-blueprint.html) removes the record from its process; it does not execute an approved transition. | Never revoke Blueprint to make Lexy's update succeed. The reviewed public Recruit API index did not establish an allowed-next-action/execute-transition contract; do not import one from Zoho CRM by analogy. |
| Is a generic field update a safe fallback? | [Update Records](https://www.zoho.com/recruit/developer-guide/apiv2/update-records.html) says omitted triggers execute workflows, approvals and blueprints; picklist writes may add values. | Do not implement generic status-field editing as an undocumented fallback. `trigger: []` is not evidence that all status-change side effects are suppressed or that Blueprint requirements may be bypassed. |
| Can a status have effects outside this application? | [Applications module](https://help.zoho.com/portal/en/kb/recruit/talent-management/applications/articles/applications-in-zoho-recruit) documents automatic notifications, archiving other applications when a candidate is hired, and locked/rejected states. | Preserve the separate human-owned offer/employment boundary. Do not assume a single-record request guarantees no effects on other applications. |

**Conclusion:** the public documentation supplies a plausible status-write
mechanism, but not the complete contract needed for this controlled writer.
The existing implementation correctly remains mapping/validation/simulation
only. No live executor or additional permission was added during this review.

The next provider/account-owner confirmation should answer this concrete case:

> For an Applications-enabled Recruit account, how can an integration change
> exactly one existing application's non-offer status for a specified candidate
> and job? Please confirm the supported endpoint, module, ID semantics, payload,
> minimal OAuth scope and per-record response. How does the caller obtain and
> satisfy current Blueprint actions, mandatory fields and actor permissions?
> Which workflows, email/SMS, webhooks or other-application effects can occur,
> and what supported controls exist? What read-back and concurrency/idempotency
> guarantees distinguish a completed request from an uncertain timeout?

A provider-supported candidate/job-scoped contract can be considered if it
proves the exact application binding and required behavior; direct application-ID
syntax is not itself a product requirement. Do not send this question, reconnect
accounts, broaden scopes or mutate even dummy records without authorization.

## Storage and deployment

Migration `0104_zoho_stage_handoff_preparation.sql` creates private, forced-RLS
mapping and simulation-history tables. It was applied to verified **local
development only**. External production was not migrated or accessed.
Use the existing external release process to apply it before deploying these
routes. Never run `drizzle push`.

Run `scripts/sql/check-zoho-handoff-storage.sql` against the intended target
after migration. All 12 result rows must be true. The script is read-only and
reads catalogs only. The previous ATS storage audit does not include these new
tables; run this supplementary check as well.

## API and regression checks

- `GET /api/zoho-recruit/campaigns/:id/recipients/:recipientId/handoff`
- `PUT /api/zoho-recruit/campaigns/:id/stage-mapping`
- `POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/handoff`
- `POST /api/zoho-recruit/campaigns/:id/recipients/:recipientId/stage-validation`

Run the service tests with the existing egress guard:

```
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs --test \
  src/lib/ats-connectors/zoho-stage-handoff.test.ts
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs --test \
  src/lib/ats-connectors/zoho-stage-validation.test.ts
pnpm --filter @workspace/lexy run test:zoho-campaign-browser
```

The service tests use only uniquely scoped synthetic local-development records;
the browser harness intercepts every API response and denies unexpected network
requests. Both are included in future assisted release runs. They do not
establish live provider acceptance.
