# Optional meeting speaker separation and human review — development

## Delivered

- Explicit, unchecked-by-default speaker separation for uploaded/retryable human
  recordings. Default processing still sends `{}` through the existing route.
- One bounded Deepgram request using the existing `nova-2` model, with an explicitly
  pinned v1 diarizer. No interview model, voice routing, summary prompt, rubric,
  candidate score or hiring decision changed.
- Timestamped anonymous groups with provider/build provenance. Invalid/missing
  diarizer metadata or malformed segments fail explicitly, without automatic
  fallback or guessed participant identities.
- Optional staff-confirmed names/roles. Server-owned reviewer/time, source and
  review revision checks, competing-save protection, explicit clearing, stale-draft
  handling and existing scoped private-data access/deletion controls.
- Fixed duplicate sibling React keys that could leave stale speaker sections
  beside the latest saved review. Browser verification now requires one section.

Human annotations do not prove identity or become an approved assessment, score,
automatic applicant advancement or offer authorization. No attending meeting bot
has been introduced.

## Verification

- **76** targeted API unit tests passed, including existing transcription,
  media/core and question-review regressions.
- **46** isolated development HTTP/privacy/processing checks passed, including
  source-bound labels, authorization, stale saves, simultaneous edits and clearing.
- **29** real-browser component checks passed using synthetic API/media fixtures,
  including actual captured-audio decoding, speaker review persistence, stale drafts,
  duplicate-section prevention, deletion, cached-data hiding and mobile overflow.
- Frontend typecheck and changed-component lint passed.
- API typecheck, build and its existing authorization/privacy/prompt/rubric guards
  passed. Generated client/schema and shared library declarations were refreshed.
- **14** release-manifest/schema tests passed. The new read-only meeting/usage
  metadata check passed all four assertions against development.
- **One live Deepgram request** using its official public NASA sample returned
  HTTP 200, `nova-2`, v1 diarizer metadata, eight segments and one anonymous group.
  No candidate audio was sent and no meeting-note record was created. This proves
  basic provider integration, not two-person diarization accuracy or live meeting
  attendance. No speech content or credentials are printed by the diagnostic.

The earlier 52/52 combined release execution predates these additions. It is not
represented as a full combined rerun of this feature. A subsequent combined run
also includes the newly required `meeting-usage-database-schema` check.

## Usage observation issue discovered and repaired

The paid public-sample request succeeded, but its start/final usage receipts could
not persist: development still had the older observation-area constraint, missing
the existing migration `0076_usage_economics_labels.sql`. Applied that migration
only to the verified development target.

After repair, the **actual `persistUsageAttempt` sink** saved start/final observations
inside an intentionally rolled-back development transaction. The test confirmed
unknown cost remains unknown and no fixture row remains. No provider call was
repeated and no historical receipt or charge was fabricated.

The one earlier diagnostic call therefore remains known missing usage coverage,
not a zero-cost request. Prices, payment guardrails and commercial restrictions
were not changed.

The release metadata check now rejects the old area constraint, missing speaker
column, broadened cost semantics or disabled usage RLS. It performs catalog reads
only and is required before fixture journeys. It is a schema observation check,
not a new runtime payment gate.

## Rollout boundaries and remaining work

Applied nullable-column migration `0108_meeting_speaker_evidence.sql` to verified
development only. Existing rows, note ownership, deletion/erasure fencing and
assessment separation are preserved. External operators must verify/apply 0076
and 0108 as appropriate before rolling out this code.

Production was neither queried nor changed. No real candidate messages,
invitations, remote ATS mutations or staff approvals were performed.

Both development services restarted successfully and the public login screen
rendered. On startup, the existing dormant-Stripe safety monitor emitted its
warning and sent one administrator alert email. This was a restart side effect,
not a candidate message or a billing activation; no payment settings or secrets
were changed. The existing unrelated warning is not represented as a clean
security/billing configuration.

Still separate: real meeting-provider capture/attendance acceptance, multi-speaker
accuracy acceptance, the team's work-order/Zoho acceptance steps and a verified
application-specific ATS transition contract. Do not treat source annotations or
this provider sample as completion of those items.

### Reproducible checks

`node --test scripts/check-meeting-usage-schema.test.mjs scripts/assisted-test-batches.test.mjs`

`node --import ./scripts/test-egress-guard.mjs scripts/check-meeting-usage-schema.mjs`

The optional `artifacts/api-server/scripts/check-meeting-speaker-provider.ts`
diagnostic performs a **paid** request and is never part of the automatic gate.
It requires explicit live-call confirmation, a confirmed development database
fingerprint and an existing controlled job. Do not rerun it to repair an old
missing receipt.
