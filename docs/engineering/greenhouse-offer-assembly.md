# Greenhouse controlled financial offers — assembly and acceptance

## Readiness

The local implementation now connects the financial-offer controls, durable
attempt journal, verified-configuration boundary, bounded Harvest transport and
HR workspace. It is dependency-injected and tested with isolated fixtures.

**This is not an activated customer integration.** The application's default
workspace remains `unavailable`. Having a Greenhouse connection or API key does
not enable financial writes. BUILD-02 remains **Blocked**, not Passed.

Before activation, integration engineering must supply authoritative server-side
custody, employer-review and workflow-evidence loaders and explicitly install the
configured workspace in the API bootstrap. Those account/deployment-specific
bindings are not supplied by the default application. They require verified
employer configuration and authorization, followed by sandbox acceptance.

No live Greenhouse requests, candidate contact, production changes, secret
changes, LLM changes or database migrations were performed for this increment.

## Implemented sequence

1. The designated terms owner saves a **local** financial proposal.
2. Prepare validates current staff/HR authority, tenant and application binding,
   employer contract, exact financial values, custody and current metadata.
3. The designated human approver deliberately approves the exact saved intent.
   This does not create a Greenhouse offer or request employer approval.
4. The designated submitter separately confirms the financial action and
   acknowledges that employer approver emails may be sent.
5. A durable database claim prevents another Lexy process from repeating that
   attempt. A fresh preflight checks the current offer chain and approval state.
6. The transport makes at most one draft-creation/versioning request. Exact
   returned financial values and application binding must match.
7. The created-draft receipt is **committed before any approval-request POST**.
   Losing that commit's acknowledgement does not authorize another create.
8. The controller rereads the exact draft and applicable job/candidate approval
   flows. It requests internal approval only for the exact eligible,
   not-yet-requested flow. An already requested flow is not emailed again.
9. A successful approval-request response is followed by independent read-back.
   Exact draft/terms and a pending or approved request are required for a verified
   submission receipt.

Creating a draft is not requesting approval. Requesting approval is not employer
approval. A verified submission is not candidate delivery, acceptance, employment
or a fee trigger. Lexy exposes no candidate-delivery action in this adapter.
The employer must independently verify that its own Greenhouse automations do
not deliver an offer as a side effect of these operations.

### Approval-request contract

The fixed endpoint is `POST /v3/approval_flows/{id}/request_approvals`, with the
separate `harvest:approval_flows:request_approvals` scope. The request body is `{}`.
The documented response is 204 with no body. That response alone does not prove
the flow reached the expected state.

This operation emails the initial **employer approvers**, not the candidate.
Greenhouse attributes the request to the credential identity. Lexy's private
journal separately retains the actual human operator; the adapter does not
invent an unsupported requester override.

Reference:
https://harvestdocs.greenhouse.io/reference/post_v3-approval-flows-id-request-approvals.md

## Server-only composition

Relevant files:

- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-assembly.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-review.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-http.ts`
- `artifacts/api-server/src/lib/greenhouse-offer-workspace.ts`
- `artifacts/api-server/src/routes/greenhouse-offer-workspace.ts`
- `artifacts/api-server/src/routes/controlled-offers.ts`

Composition outline — `trusted` below denotes deployment-specific services,
**not implemented bindings or a client-supplied proof object**:

```ts
const controlled = greenhouseControlledOfferAssembly({
  readCustody: trusted.readCurrentGreenhouseCustody,
  readEmployerReview: trusted.readIndependentEmployerOfferReview,
  fetcher: trusted.singleAttemptFetch,
});
const workspace = greenhouseOfferWorkspace({
  database,
  evidence: trusted.greenhouseWorkflowEvidence,
  controlled,
});
const offersRouter = createControlledOffersRouter(
  deliver,
  atsGateway,
  workspace,
);
```

The configured router must replace the default mounted instance, not be appended
after it. The default financial workspace has no credentials or network access.
Do not configure simulation and controlled execution together.

Required trusted inputs:

The existing Greenhouse connector interfaces cover bounded reads and separately
authorized notes. They do not supply the financial credential-custody,
independent employer-review or workflow-evidence bindings below. Completing this
requires a real authoritative server adapter and employer-admin verification,
not an environment toggle or permission booleans supplied by the browser.

- **Custody:** current employer/account/connection revision, actual credential
  identity and verified caller/private-offer authority, including advanced
  permissions and relevant scopes. Never infer private-read permission from an
  empty offer list, token presence or the application's generic connection status.
- **Workflow evidence:** existing authenticated tenant/privacy/HR gates, current
  human decision, saved proposal, exact application mapping and current chain.
  Source fences must protect and recheck the complete authoritative state.
- **Independent employer review:** exact tenant/workflow, contract hash and
  configuration hash; reviewer and short expiry; explicit currency precision,
  choice encoding and any no-job-approval exception; reviewed operation with no
  candidate delivery. A candidate flow's absence is never an approval waiver.
- **Metadata:** matching bounded reads of applicable fields, required rules,
  choices, hierarchy, openings/reservations and approval state. Unsupported or
  undisclosed rules remain unknown until independently verified; they are not
  guessed from successful mocks or probed with financial writes.

These inputs are not accepted from the public financial-workspace request body.
They need a real authoritative record source and deployment wiring before any
claim of live readiness. The generic ATS gateway's financial-write ban is intact.
Changing simulation/controlled mode changes the source revision, so an earlier
approval cannot silently authorize a different execution mode.

## Uncertainty and recovery

Both mutating HTTP operations are single-attempt, bounded and pinned to the
Harvest host. Redirects, timeouts, malformed receipts, permission loss, changed
terms, changed job approval and ambiguous outcomes stop the workflow.

The durable `draft_created` state is an unresolved hold, not permission to resume
the approval POST after a crash. Reconstructed controllers cannot resubmit it.
Its receipt survives process termination and PostgreSQL WAL recovery.

Read-only recovery requires fresh custody and current read authority, but does
not require a still-unexpired financial-write approval. It can observe matching
or different remote state; neither observation proves who made an external
change, releases the claim, verifies a lost submission or grants another POST.
HR can handle the external offer manually while the Lexy attempt remains held.
No automatic release/resume or exactly-once provider guarantee is claimed.

Local fencing does not provide a Greenhouse-wide transaction or remote
compare-and-swap. Employer users/automations may change state between requests.
Sandbox acceptance must include that limitation and an operational response.

## Verification performed

All checks below passed:

| Check | Result |
| --- | --- |
| HTTP, configuration, assembly and financial-field tests | 106 tests |
| Policy and private SQL control tests | 24 tests |
| Controlled-offer HTTP/workflow regressions | 17 tests |
| Independent workers, SIGKILL and PostgreSQL crash/WAL recovery | 9 tests |
| Real HR component in a synthetic browser fixture, including 390px layout | 25 checks |
| API and web TypeScript checks, generated API contracts, diff whitespace | Passed |

The browser run verified explicit controlled confirmation, unsaved-edit conflicts,
unauthorized refresh handling, uncertain holds and draft-created read-only
recovery. All API responses were synthetic and external traffic was blocked.
Screenshots/report are in the ignored
`generated-artifacts/greenhouse-offer-browser/` directory.

Useful commands:

```sh
pnpm --filter @workspace/api-server run test:greenhouse-offer-assembly
pnpm --filter @workspace/api-server run test:greenhouse-offer-controls
pnpm --filter @workspace/api-server run test:greenhouse-offer-workspace
pnpm --filter @workspace/api-server run test:greenhouse-offer-durability
pnpm --filter @workspace/lexy run test:greenhouse-offer-browser
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/lexy run typecheck
```

This is not live-provider, production-capacity or deployment-recovery proof.
The frontend login page also rendered after its managed workflow restart. That
unauthenticated screenshot does not verify the signed-in finance workspace.

## Team acceptance after verified activation

Use an authorized sandbox employer, a dummy job/application, controlled staff
inboxes and explicitly designated terms-owner/approver/submitter identities.

| Case | Action | Required result |
| --- | --- | --- |
| GH-A1 | Start with default configuration | Financial provider stays unavailable; a saved connection/key does not activate it |
| GH-A2 | Supply real verified bindings and fresh employer review | Exact employer/job/application and supported fields appear; no writes |
| GH-A3 | Save and prepare a local proposal | No Greenhouse financial change or email |
| GH-A4 | Approve as the designated reviewer | Exact intent approved locally; still no provider write |
| GH-A5 | Change a term, assignee, source revision or execution mode | Old approval cannot submit |
| GH-A6 | Submit without acknowledgment or as another user | No financial write |
| GH-A7 | Confirm one authorized submission | One draft operation; committed draft receipt precedes any employer approval email |
| GH-A8 | Inspect Greenhouse and Lexy receipts | Exact values, correct current chain and requested approval state; no candidate delivery |
| GH-A9 | Repeat the same submission or use another API instance | No second create/version or approval-request email |
| GH-A10 | Recover a held attempt | Reads only; observation does not authorize retry or assert attribution |
| GH-A11 | Revoke private permission or change employer metadata | Fail closed without showing private cached values or silently reusing approval |
| GH-A12 | Use unsupported fields, unknown precision or unverified opening rules | Explicitly blocked; no guessed values or probe writes |

Use the automated isolated fixtures for deliberate network/commit-loss and
process-kill injection. Do not induce these faults against real candidates.

## Development runtime recovery

The port conflict was resolved after the assembly increment. The listener was
verified as an older development API from this project, with no active network
connections. It exited gracefully on SIGTERM; no force kill was used.

The existing managed API workflow then rebuilt the current source, passed its
type/security-boundary build checks and started successfully. Exactly one API
listener remained. Both `/api/healthz/live` and `/api/healthz` returned HTTP 200
through the development proxy; readiness included a successful database check.
This demonstrates the current recovery, not permanent prevention of every
possible orphaned process or full signed-in acceptance.

Normal startup generated the existing Stripe dormancy warning and a platform-admin
alert email. Billing activation, its safeguards, schedulers, secrets and production
configuration were not changed. This runtime recovery must not be described as
having sent no emails, even though the earlier isolated financial tests made no
live provider requests.

For future conflicts, identify the listener's owner and preserve active work
before cleanup. Do not remove billing safeguards, change production settings or
start a duplicate replacement service to hide the conflict. Use the existing
managed API workflow and verify one fresh listener.
