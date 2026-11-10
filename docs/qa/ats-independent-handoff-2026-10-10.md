# ATS-independent mapping and reviewed manual handoff

## Scope delivered

Lexy retains its native hiring/offer workflow. An employer can additionally
select external offer ownership, record manual ATS account/job/candidate/
application identifiers, prepare a structured decision/evidence snapshot,
explicitly approve it, and download the approved JSON for manual handoff.

This is **not an ATS connector**. Every state and downloaded packet identifies
the connection as `not_connected`. There is no Greenhouse authentication, remote
record discovery, remote write, synchronization, external delivery receipt,
automatic offer, confirmed employment or fee action.

### Boundaries

- Current employer administrators and the explicitly designated external
  handoff owner may manage mappings/packets. Staff still need current job access
  and candidate visibility; recruiters do not gain employer authority merely
  from a recruiting role. Other permitted readers receive no mapping/packet.
- Tenant/account-level locking rejects conflicting manual job, candidate and
  application bindings across local workflows. These checks do not establish
  that the external records actually exist; only a future authorized connector
  can verify that.
- Each explicit mutation is revision-bound and idempotent. Approval binds the
  precise packet ID and snapshot hash. Changes to the decision, brief, routing,
  candidate name, mapping or underlying assessment versions require fresh review.
- Export is a separate explicit action. Replay rechecks current ownership,
  privacy, workflow readiness and packet freshness before returning a file.
- Clearing/remapping requires explicit UI confirmation and invalidates the
  current review. Prior prepared/exported snapshots remain in protected history.
  It never deletes an ATS record.
- Native offer draft/send operations remain unavailable under external offer
  ownership. Switching processes continues to use the existing controlled
  ownership/withdrawal/reconciliation rules.
- Exports contain structured job/identity assessment summaries and human decision
  evidence, not raw answers, media, résumé access, contact fields, private learning,
  free-form workflow evidence or financial offer terms. Candidate-action
  capabilities are redacted. Unresolved signals and TEST ONLY evidence remain
  explicit cautions, not identity or hiring clearance.
- General workflow responses omit ATS mappings and protected snapshot history;
  the dedicated handoff endpoint uses current authority and no-store caching.

## Verification

- 16 focused HTTP/database controlled-offer regression tests passed, including
  the new mapping/review/export test and the no-provider/no-stage-effects check.
- Positive and negative checks cover save/clear, employer authority, foreign
  tenant denial, conflicting cross-job mappings, revision conflicts, required
  review, prohibited unapproved/stale exports, replay without extra revision,
  remapping/decision-change invalidation, snapshot history and native/external
  offer-path separation.
- Shared library TypeScript and frontend TypeScript passed before the final
  small unsaved-edit button guards. Changed-source lint
  passes. Backend remains at the known 520 diagnostics, with none from this work.
- API build/security guards pass and both application services load the changes.
- The signed-in browser check used disposable fictional records, not old Linx
  work orders. Results and remaining limitations are recorded below.

### Signed-in browser verification

The initial harness used direct authenticated API probes but did not authenticate
all browser queries. A corrected cookie-first session passed browser-origin
identity, job-details and workflow-state positive controls and reached the normal
Workflow tab. The browser verified:

- External employer ownership with no native approver/sender.
- Visible Not connected / Manual export only messaging.
- Saving all four synthetic mapping identifiers.
- Preparing the TEST ONLY snapshot, its human decision and six workflow steps.
- Approval/export disabled before explicit acknowledgment.

The remaining interactions subsequently passed in one focused continuation after
pausing overlapping validation jobs and restoring the managed app services:

- Checking the acknowledgment enabled approval; approval succeeded.
- The actual browser download was intercepted and saved. Its JSON had schema
  version 1, `not_connected`, `external_employer`, the exact fixture mapping and
  workflow/job/candidate IDs, the TEST ONLY human decision, and approval/export
  metadata. The UI confirmed that nothing was sent to an ATS.
- Unsaved mapping edits disabled approval/export. Saving the edit invalidated the
  previous packet; a fresh snapshot required new acknowledgment and approval.
- Clearing required explicit confirmation. After clearing and reload, the
  mapping and current packet were absent and preparation was disabled.

The downloaded fixture had no assessment summaries; this proves the browser
download contract, not a real provider assessment or external-record existence.
No raw/private/contact/résumé/media/financial/coaching keys were present. Backend
regressions separately cover omission of populated private free-form evidence.

All exact owned fixture entities, related events/receipts/audits/notifications,
auth material and temporary downloads were removed, and owned browser contexts
were closed. No candidate email/offer or ATS/provider request was made by this
flow. The existing passing API checks were retained rather than rerun.

## Remaining integration work

The next vendor-dependent step requires an employer-authorized ATS connection:
verify current APIs/scopes, validate these external IDs against real records,
map remote versions/statuses, and add explicit idempotent reviewed writes and
real provider receipts. Local export must never be renamed to “synced” or
“delivered” merely because a file was downloaded.

The existing AWS email-callback and private résumé-tagging live checks remain
separate infrastructure blockers. This foundation introduces no payment gate
and does not disable external sourcing or change stabilized LLMs/prompts.
