# Greenhouse employer HR workspace

**Current update:** the [controlled assembly](greenhouse-offer-assembly.md) is
available as an explicit server dependency. Controlled mode has its own
confirmation and employer-email acknowledgment; a committed draft hold permits
read-only recovery, never resubmission. The expanded browser harness passed
26 checks, including retained history and access-loss redaction. Default live execution remains unavailable until trusted server
bindings, bootstrap and authorized employer acceptance are complete.

## Implemented in development

The Greenhouse handoff now includes an authenticated, employer-scoped **local
financial proposal workspace**. It is not a live Greenhouse offer connection.

Find it under a candidate's workflow, employer-owned external offer routing and
Greenhouse HR handoff. The existing routing must name Greenhouse and designate
an active employer owner. The current approved/exported handoff packet and
explicit human Hire decision are required before saving a proposal.

The owner can enter human-authored named financial fields, an optional opening
ID and start date, and select the financial approver and submission operator from
active employer staff with work-order access. No employer fields or compensation
defaults are guessed. Currency amounts are explicitly entered in integer minor
units, not whole dollars.

The proposal and previous versions are saved privately in the existing workflow
JSONB. This needs no SQL migration. Generic workflow views exclude both current
and historical financial proposals. The audit journal records a hash, not raw
financial terms.

## Authority and version controls

### Read-only submission history

The existing HR financial workspace now shows **Submission history** from the
committed private offer-control journal. It retains transitions across attempts
in journal sequence order, even when timestamps are equal or out of order.
Each entry exposes only the sequence, attempt ID, recorded state/time, actual
Lexy staff ID (or an explicit missing-identity label), and whether a receipt
reference was retained. It does not serialize financial values, credentials,
remote application/candidate identifiers, raw responses or the receipt hash.

This history uses the same fresh job, tenant, candidate-privacy and designated-HR
authorization as the workspace. It is not exposed through a generic workflow
response. Failed refreshes hide cached history along with the financial form.
The backend rejects malformed/duplicate journal sequences and journals over
1,000 entries rather than presenting an apparently complete partial timeline.
No migration is required; existing audit entries are read without backfilling.

The timeline does not retroactively label older entries with today's execution
mode: historical execution mode and provider credential identity were not
retained in this journal. A staff ID is the Lexy operator/recording identity,
not a claim that Greenhouse attributed the request to that person. A draft
receipt is not a verified approval request; `observed_match` is only a read-only
observation and never proof of attribution, financial approval or retry authority.
There are no history actions that submit, resend, release a hold or recover.

Local verification: 25 policy/private-SQL checks, 17 controlled-offer HTTP and
workflow checks, and 26 synthetic browser checks passed. Coverage includes
multiple attempts, deliberately reversed timestamps, minimal serialization,
foreign tenant/workflow isolation, suspended staff rejection, cached-history
removal after HTTP 403, escaped text, and the 390px timeline layout. Browser
checks use the real component with synthetic API responses, not a signed-in
employer account or live Greenhouse.

### Existing workspace controls

- Both reads and writes use the existing authenticated job/candidate privacy gate.
- Only the designated active owner, approver, submission operator or employer
  administrator may read the financial workspace.
- Only the designated current owner can edit. An approver can inspect all saved
  financial terms without obtaining edit rights.
- Saves compare an exact workspace revision and record a request-bound idempotency
  reference. Replays do not add versions. Stale editors cannot overwrite.
- Changed workflow evidence, decision, employer ownership, proposal terms or
  designated operators invalidate the connected-control fingerprint.
- Saves retain prior financial versions. Unresolved submission attempts prevent
  replacement terms rather than silently permitting a duplicate offer.
- Job/workflow and designated user rows are locked during local mutations.
- The UI retains unsaved edits when saved terms change, shows the new saved
  version and requires an explicit keep/discard choice. Keeping edits does not
  save or approve them.
- Cached financial content is hidden during failed/refetching access checks.

## What happens without verified employer configuration

Local save and read-only review work. **Prepare, financial approval and submission
remain unavailable** because no default employer-evidence adapter or offer
transport is installed. The API cannot be enabled by client-supplied proof,
connection flags or simulation settings.

The server assembly accepts an explicitly injected simulation for development
tests. That exercises the real workflow/HR source and the existing control
protocol: preparation, separate human financial approval, separate deliberate
simulation submission and read-only recovery of held attempts. No default or
live transport is supplied, and no candidate-delivery operation exists.

Simulation submission means acceptance by a local fake provider, not a
Greenhouse-created offer. An exact read-back can establish only the corresponding
simulated submission. A pending remote approval is not approval, delivery,
acceptance or employment.

## API and implementation

- GET/POST `/api/jobs/:jobId/candidate-workflows/:workflowId/greenhouse-offer`
- OpenAPI-generated client hooks and server schemas.
- Backend: `artifacts/api-server/src/lib/greenhouse-offer-workspace.ts`
- Routes: `artifacts/api-server/src/routes/greenhouse-offer-workspace.ts`
- UI: `artifacts/lexy/src/components/jobs/GreenhouseOfferWorkspace.tsx`
- Field validation: `artifacts/lexy/src/lib/greenhouse-offer-fields.ts`

Repeat the API/offer regression with
`pnpm --filter @workspace/api-server run test:greenhouse-offer-workspace`.
It uses isolated synthetic development records and injected provider responses;
it sends no candidate email or provider request. The regression checks
authentication, foreign/candidate/unassigned access, private serialization,
idempotent save, stale edits, separate operator authority, approval invalidation,
history retention, submission replay protection and revoked staff access.

### Verification on 2026-11-14

- **17 offer/workspace API regression tests passed**, including the new real
  authenticated HTTP and server-owned HR-source integration scenario.
- **24 internal offer-protocol tests passed.**
- **7 frontend field/action tests passed.**
- **23 browser checks passed** against the real workspace component with synthetic
  responses and external traffic blocked. These cover local saving and invalid
  input, background-edit conflicts, separate financial approval and simulation
  submission confirmations, held-attempt recovery, hiding cached terms after a
  403, and 390px layouts. An initial mobile conflict-button overflow was fixed
  and the isolated runner then passed all 23 checks.
- Shared-library, API and frontend type checks passed. The full consolidated
  assisted baseline was not rerun.

Repeat the browser regression with
`pnpm --filter @workspace/lexy run test:greenhouse-offer-browser`.
The browser runner and field tests are registered in the assisted baseline.
The runner mounts the real component in a temporary loopback-only Vite fixture;
it does not use a customer login, database, provider or candidate recipient.
Its API responses are simulated; the separate HTTP regression supplies real
local backend evidence.

## Remaining before connected Greenhouse offers

1. Authoritative employer-specific field/opening and approval configuration
   discovery, verified connection/custody evidence and permission checks.
2. Real authoritative custody/review/evidence loaders and explicit deployment
   bootstrap for the implemented controlled assembly. Existing routes accept the
   configured workspace as a server-only dependency, but the default instance
   has no live credentials, verified employer input sources or financial access.
3. Authorized dummy-employer acceptance and eventual deployment-specific recovery
   checks. The [local committed-ledger durability test](greenhouse-offer-durability.md)
   now passes across independent worker processes, SIGKILL and a disposable
   PostgreSQL crash/restart; it does not establish deployed/provider durability.

BUILD-02 remains Blocked. Production, credentials and provider configuration were
not changed. The generic ATS gateway still prohibits financial-offer writes.
