# Native Google Meet recording provider — development groundwork

## Status

The read-only provider adapter is implemented and covered by synthetic tests.
The separate staff OAuth connection, appointment-linked recording preview,
controlled private import routes and review interface are now implemented.
Background sync has not been enabled. See the
[application implementation and test boundary](native-google-meet-recording-import-development-2026-11-04.md).
Existing Calendar/Meet scheduling and Zoom recording imports are unchanged.

This work does not block the already documented Linx dummy-workflow testing.
It is not evidence of a successful live Google recording download.

## Implemented boundary

- Resolves one meeting code to Google's canonical space, then discovers
  conferences only in that space within an explicit window of at most one day.
- Requires staff to explicitly select an exact conference instance; does not
  automatically choose the latest instance of a recurring/reused link.
- Rechecks the space and exact completed conference for a recording preview.
  A meeting code alone is not durable proof of a historical meeting space.
- Only accepts `FILE_GENERATED` recordings whose recording timestamps fall
  within that conference, with a valid underlying Drive file ID.
- Reads exact Drive objects only. Never lists the user's Drive, fetches playback
  links, follows redirects, accepts arbitrary URLs, or writes to Google.
- Requires downloadable, non-trashed MP4 metadata, version, checksum, size and
  duration. Missing/deleted/inaccessible evidence fails explicitly.
- Marks media over the existing 50 MB / 15-minute processing bounds ineligible.
  Those are media-processing bounds, not commercial access restrictions.
- Bounds metadata bodies to 2 MiB; discovery to one 100-instance page; previews
  to at most 20 recordings. An incomplete page fails explicitly rather than
  pretending all results were reviewed. Discovery has a shared 20-second budget;
  preview and download each have a shared 60-second budget.
- Downloads from the fixed Google Drive API endpoint, checks reviewed metadata
  before and after download, and verifies the complete size and content checksum.
- Sanitizes errors, does not retry automatically, and never exposes provider
  error bodies or credentials.
- Observes request status through the existing usage transport without reading
  or cloning private recording metadata for telemetry. Costs remain unknown.

## Integration checklist (implemented; live acceptance remains)

1. **Implemented in development:** separate staff opt-in authorization for
   `meetings.space.readonly` and `drive.meet.readonly`, verify granted permissions
   and the account identity, and bind them to the current employer/staff actor.
   Do not add these to the default Calendar consent or disconnect working
   calendar accounts. Google classifies the recording-specific Drive scope as
   restricted; external app verification remains an operator responsibility.
   See [authorization implementation and test boundary](google-meet-recording-authorization-development-2026-11-04.md).
2. **Implemented:** bind discovery and imports to a currently authorized candidate, job, native
   appointment, confirmed organizer receipt and account revision. Provider
   visibility alone is not employer/job authorization or organizer proof.
3. **Implemented:** a short-lived, actor/context-bound signed recording review token.
   Revalidate current authority and evidence immediately before private storage.
4. **Implemented:** reuse the consent, actual-media validation, erasure fencing, private storage,
   source provenance, scoped deduplication and deletion/recovery mechanisms.
   No automatic transcription, hiring scoring or ATS transitions.
5. **Implemented:** contract-first routes and staff review/import controls with authorization
   cache cleanup; test unauthorized actors, changed appointments, retries and
   duplicate imports before calling the feature ready.
6. Perform one explicitly approved live organizer-owned recording import.

The later application implementation exposes these steps only through explicit staff actions.
No production data, database schema, AI configuration, commercial plan or Google
account grant was changed.

## Verification

The focused command covers the new provider, existing Zoom provider and usage
transport. All requests in provider tests are synthetic/injected; the test egress
guard remains enabled.

```sh
pnpm --filter @workspace/api-server exec tsx \
  --import ../../scripts/test-egress-guard.mjs --test \
  src/lib/google-meet-recordings-provider.test.ts \
  src/lib/zoom-recordings-provider.test.ts \
  src/lib/vendor-usage.test.ts
pnpm --filter @workspace/api-server run typecheck
node --import ./scripts/test-egress-guard.mjs --test \
  scripts/assisted-test-batches.test.mjs
```

The Meet provider tests are registered exactly once in the existing assisted
release runner. This does not overwrite the original prior release-run result.

Observed result: 40/40 provider/Zoom/usage tests and 11/11 release-registration
tests passed. The final telemetry-spy adjustment was confirmed with its targeted
test. API typecheck, changed-code lint/format and the API build/security guards
passed. The managed API was restarted once; `/api/healthz` reported healthy
database access and the existing login page rendered. These checks do not prove
an authenticated Meet import; that application flow was added in the later
implementation linked above. These original provider-only results are not live acceptance.

## Official reference

- [Meet recording resource and Drive destination](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.recordings)
- [Conference filtering and pagination](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list)
- [Meeting space identity and reusable codes](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/get)
- [Meet authorization scopes](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)
- [Drive exact-file retrieval](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Drive file content/version/download metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
