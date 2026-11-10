# Controlled Google rescheduling and cancellation

Implemented 2026-10-25, extending the candidate-and-organizer-only invitation
flow. It does not enable Google panels, change candidate consent or automate
staff approval.

## Staff flow

1. Save the new interview time or cancellation **in Lexy first**.
2. On the coordinator record, choose **Update Google** or **Cancel in Google**.
   These controls remain present for non-AI cancelled records.
3. Explicitly load and review the guest, organizer, old time, exact new time
   (or cancellation), including the actual UTC offset and sub-minute precision.
4. Acknowledge notifications and separately approve this exact operation.

Opening a dialog, reading, refreshing, changing a native record or an
AI/background action does not mutate Google. A ten-minute signed proof binds
the native revision, operation kind, current verified Google event/ETag,
account/connection, recipient, previous operation and exact source/target.
Fresh reads can rotate proofs; the client compares immutable details and
submits the original reviewed, still-valid proof.

Reconnecting the same verified Google subject requires a fresh review bound
to the new connection; it does not transfer the event to a different subject
or rewrite the original send evidence.

## Provider behavior

- Only the original deterministic primary-calendar event can be changed.
- Rescheduling sends one conditional, time-only PATCH with an operation marker
  and `sendUpdates=all`. No attendees, description or conference request are
  rewritten; the existing Meet link is preserved.
- Native cancellation permits a separately approved conditional DELETE with
  `sendUpdates=all`. Received empty successful responses are recorded as
  Google's acceptance, never email delivery or guest acknowledgement.
- Recurring events, foreign guests, changed owners, hostile entity tags,
  uncertain initial sends and unsupported panels are rejected.
- Rescheduling checks personal working hours and current interval conflicts.
  Free/busy cannot safely subtract an existing meeting while detecting another
  overlapping one, so this path inspects a bounded, primary-calendar event
  interval and excludes only the verified original ID. All-day, malformed or
  incomplete results fail closed; calendar contents never reach candidates or
  the staff response.
- An accepted cancellation cannot be used to recreate the original event,
  even if staff restore native content. A genuinely new invitation requires a
  new deliberately created native interview and its own approval.

## Durable evidence and uncertainty

Private Google receipt JSON now contains an optional append-only operations
history. No new database table, column or production migration is required.
The original send transaction, provider, snapshot and shared schedule primary
key remain unchanged. The existing forced RLS, denied request-role access and
candidate-erasure barrier still protect the row.

An immutable operation intent is committed **before** provider mutation.
The next transaction reacquires parent/privacy/staff/connection locks,
revalidates eligibility and approval, and uses `If-Match`. A lost response,
late conflict or database-save failure retains the intent and disables retries.

Explicit reads can reconcile an uncertain PATCH only from the exact original
event, operation marker, saved target interval and preserved Meet identity.
Matching timing alone is not attributable success. Completed moves update the
effective booking snapshot without rewriting the original invitation history.

An uncertain DELETE remains under review if Google returns an absent event or
minimal tombstone. Absence does not prove which action removed an event and
can be confused with permission/account drift. There is no automatic second
delete, replacement event or fabricated cancellation receipt. Staff must
inspect Google manually when this evidence cannot be recovered.

No native appointment, pipeline stage, candidate notification through Lexy's
email sender or payment is modified by these controls. Google may notify the
existing guest after deliberate approval. Google availability is a preflight,
not an atomic reservation across independent systems.

## Release and next work

Existing dedicated OAuth configuration and optional verified owned-event
permission are still prerequisites. No extra write scope is inferred.
Automated tests are synthetic and egress-blocked; real-account acceptance and
production deployment remain pending.

The next queued feature is a candidate-appointment Meet-link projection.
It must inspect the **latest Google operation**, not the original `accepted`
send status alone: pending operations or an accepted cancellation must never
resurrect a stale link. It must also enforce the candidate's canonical self
authorization and the current booking snapshot, without exposing private
receipts, organizer account details or calendar contents.

## References

- [Google conditional modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources)
- [Google event PATCH](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
- [Google event DELETE](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete)
- [Initial invitation scope](google-interview-invitations.md)
