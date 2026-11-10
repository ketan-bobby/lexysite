# Candidate-owned Google Meet projection

The candidate interviews page can now show **Join Google Meet** for a confirmed
native appointment. This is a projection of a previously provider-verified
receipt bound to the current booking, not a live Google availability check.

## Read boundary

`GET /api/portal/interview-schedules/:scheduleId/google-meet` requires the canonical
candidate session. Its administrative SQL is constrained by both the candidate
ID and owning portal user ID, joined through that candidate's application.
Employer, agency and portal tenant IDs may differ; tenant membership alone
is never self authorization. Foreign and missing appointments return the same
404 response. Non-candidate identities cannot enter the reader.

The response contains exactly five fields: appointment ID, start instant,
duration, `ready`/`unavailable`, and a nullable Meet URL. It never serializes
staff notes, Google identity, organizer account information, tokens, event IDs,
approval digests, private receipts, calendar contents or guest rosters.
Responses are `no-store`; storage failures return a generic 503 without private
provider or database payloads.

The reader makes **no provider request**, refresh, reconciliation, database
mutation, credential decryption or notification. It cannot create a conference.
External changes made directly in Google are not discovered by this projection;
staff reconciliation or future provider synchronization must detect those.

## When the link is withheld

- Native booking not confirmed, expired, AI-only, unsupported panel or an
  unapproved job; erased or do-not-contact profile.
- Missing/uncertain initial send, non-Google provider, wrong candidate,
  application, recipient, event, organizer or verified Google subject.
- Missing/revoked/replaced grant, missing configuration, mismatched OAuth
  fingerprint, inactive or erased organizer.
- Pending/failed conference, unsafe URL, pending or malformed operation
  history, broken operation chain, cancelled original event, or stale target.

Cancellation stays terminal even if native content is restored. No old link is
resurrected from the original accepted send status.

Joining is available before and during the appointment, with one hour after
its scheduled end for reconnection or overrun. A send-time-only future gate
must not block a candidate who joins on time. After that grace, the read
returns no link; it never cancels or alters the actual Google conference.

## Candidate vs staff revisions

Staff approval still binds the full staff-visible revision. Candidate link
publication uses a separate candidate-visible booking binding, computed only
when the existing staff writer saves a provider-verified acceptance or accepted
event change. It excludes staff-only notes/feedback, so those edits do not
remove a valid candidate Join control or reveal a private content digest.
Identity, recipient, appointment, connection and public booking drift still
invalidate publication.

This optional binding is stored in existing private Google receipt JSON; no
new column or SQL migration is required. Legacy receipts without it retain
strict full-snapshot matching until a verified staff read or accepted change
can safely publish the binding. The candidate reader never invents or upgrades
legacy evidence. Pending operations hide links even when a previous binding
exists; accepted cancellation cannot be undone by a binding.

## Client behavior

The client validates the exact appointment ID, instant and duration and permits
only an HTTPS `meet.google.com` conference-code URL without credentials,
alternate ports, query strings or fragments. It scopes cache by candidate
identity and booking, refreshes on mount/focus and while visible, and does a
fresh uncached read before joining. A changed identity, role, booking, failed
read, cancelled booking or unmounted control cannot navigate on a late reply.

AI room links, native time-change/confirmation and Prep remain unchanged.
The controls do not claim delivery, RSVP, attendance or a live reservation.

Real staff OAuth consent and a consenting isolated live Google booking remain
release acceptance work. No live meeting or candidate email is created by this
feature's automated checks.
