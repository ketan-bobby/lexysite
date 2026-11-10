# Google panel invitations and recording imports — development

## Implemented scope

The organizer can now review and approve a candidate invitation that includes a
saved **Google** panel. Previously, saving Google panels and finding shared time
did not produce a Google panel invitation receipt; the invitation service
deliberately rejected all saved panels. That upstream gap is now handled without
promoting old solo or Outlook receipts.

- The saved panel's coordinator must be the acting organizer. Every member must
  be active, authorized for the job, in the allowed employer/job context and
  still connected to the saved Google subject/revision with matching sharing consent.
- Availability sharing is not invitation-write permission. The organizer must
  separately hold current Google invitation permission and explicitly approve
  the candidate, all displayed panel recipients, organizer, role and time.
- Review signatures and both staff/candidate snapshot hashes include the current
  panel binding. Recipient emails are server-derived; send input does not accept
  addresses, member IDs or a caller-supplied panel.
- The provider request sends exactly the candidate and reviewed panel emails,
  excludes the organizer from the guest list and rejects duplicate/colliding or
  invalid addresses and more than five panel guests before egress.
- Provider acceptance requires exactly that guest set, verified organizer,
  native-event identity, private visibility, time, binding and Meet request.
  Guests cannot invite others or see the guest list. Acceptance is not delivery
  or attendance proof; unknown outcomes retain the existing no-resend behavior.
- The accepted Google snapshot stores a panel revision/binding; the unrelated
  Outlook `panelSnapshot` is not accepted as Google authority. No new table or
  column migration is required for these nullable JSON fields.
- Organizer/member/grant/consent locks follow the panel lock order before the
  organizer's token can be rotated. Overlapping panel writes serialize the small
  bounded grant set rather than acquiring each organizer first in opposing order.

The same organizer can then use the existing candidate/job **Meeting notes →
Import a Google Meet recording** flow for a confirmed/completed interview whose
accepted Google panel receipt still matches the current panel and accounts.
Only metadata discovery, exact-instance selection, explicit participant/source
consent and bounded private import are added. Nothing transcribes, scores,
emails or advances an ATS application merely because a recording was imported.

## Failure behavior

Adding a panel to an old solo invitation does not authorize panel import or a
replacement send. A changed panel revision, member account/email, sharing
consent, role/job access, organizer identity, provider outcome or native
appointment invalidates the corresponding review/receipt. This also fences
idempotent returns and a consent withdrawal during provider download. Failed
authority checks publish no new private recording.

Current receipt checks still reject pending/cancelled/uncertain changes.
The development Update Google / Cancel in Google controls now support an
unchanged, currently authorized Google panel. See
[panel change controls](google-panel-operations-development-2026-11-04.md).
This does not implement arbitrary guest-list edits. Candidate-portal panel
Join publication is now covered by
[the candidate Join increment](candidate-google-panel-join-development-2026-11-04.md).

## Verification

- API/web TypeScript and shared contract generation/build passed.
- Forty-eight focused backend cases passed across Google event validation,
  organizer approval, operation regressions, recording receipt proofs and
  existing native recording review/download persistence boundaries.
- Three HTTP route authentication/provider-isolation cases passed with Node's
  experimental module-mock flag and the test egress guard.
- The fingerprint-guarded development HTTP/private-processing fixture passed
  **79** combined groups, including real saved-panel/current-member/grant/consent
  joins, a synthetic accepted panel source, old-solo rejection, private import,
  denial after member account rotation, staff-role removal/coordinator changes
  and consent withdrawal during download.
  Provider, storage and AI adapters were mocked; fixture rows/objects were cleaned.
- The managed API restarted once after coherent changes; all build ownership,
  tenancy, privacy, serialization and rubric guards passed. `/api/healthz` was
  healthy with database access.
- One focused browser pass mounted the actual invitation component in an
  isolated synthetic host with only its exact Google invitation requests mocked.
  Both panel recipients were visible before approval; changing the panel on the
  pre-send read cleared approval and sent no POST. A stable approval sent one
  exact synthetic POST with no client-supplied recipients. Invalid/duplicate
  recipient responses and a subsequent 403 failed closed, removing cached
  details. The 402px dialog had no horizontal overflow. The accepted Meet link
  retained its not-delivery-proof disclaimer. This was **not** a signed-in LINX
  coordinator-page acceptance test; no browser database rows were created.

No live Google invitation or recording was sent/fetched by these fixtures.
The separate optional recording authorization and consented dummy-recording
acceptance remain operator work. Production, AI models/providers/prompts,
commercial permissions and the prior failed full assisted-baseline result were
not changed or represented as fully validated.
