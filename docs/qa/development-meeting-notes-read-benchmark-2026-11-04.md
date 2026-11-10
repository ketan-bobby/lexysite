# Bounded meeting-note read diagnostic — development

## Result

The explicitly confirmed development fixture completed **102 HTTP/privacy/
processing checks**, including a new optional **80-read** diagnostic with four
concurrent requests per scenario.

| Scenario | Verified responses | p50 | p95 | Maximum |
| --- | --- | --- | --- | --- |
| Owned completed note | 20 × HTTP 200, exact ID/transcript/summary | 40.03 ms | 90.81 ms | 107.07 ms |
| Foreign job/candidate scope | 20 × HTTP 404, no private transcript/summary | 24.50 ms | 28.22 ms | 28.28 ms |
| Candidate fixture principal | 20 × HTTP 401, no private transcript/summary | 15.56 ms | 29.31 ms | 30.50 ms |
| Unsigned request | 20 × HTTP 401, no private transcript/summary | 8.67 ms | 15.92 ms | 21.44 ms |

The candidate lane accepts the staff-route denial contract of 401 or 403 and
records the actual response. In this run, the staff authentication boundary
returned 401 even with a candidate-role fixture token. This is evidence of
denied reads, not a claim that this lane reached a later object-authorization
check or proved a candidate-portal login journey.

Each successful owned response was checked against the saved fixture source,
not merely its status. Denied bodies were checked for absence of the protected
fields and source text. No additional transcription, summary generation, native
provider listing/download or stored-object creation occurred during these reads.

The largest sampled fixture-process RSS was 457,940,992 bytes. Sampling after
requests is not continuous peak-memory measurement. The process also includes
test instrumentation, database libraries and both local HTTP client/server.

## Implementation and checks

`artifacts/api-server/scripts/check-meeting-notes.ts --benchmark-reads` enables
the diagnostic; ordinary fixture runs do not perform it.

- It uses only the fixture's ephemeral loopback server and temporary synthetic
  development rows, with a required database-target fingerprint.
- Source storage, media processing and AI/native providers remain synthetic.
- A maximum of four requests runs concurrently in this invocation, with
  per-request abort signals. Failure stops new admission and settles active work.
- Reports contain fixed scenario labels, timings, counts and sampled process
  memory, not tokens, record IDs, private response bodies or email addresses.
- The fixture's `finally` cleanup removes its synthetic rows.
- **Four benchmark-helper unit tests passed**, covering bounded concurrency,
  safe failure reporting/settlement, abort deadlines and invalid options.
- Strict standalone helper/test typechecking, targeted lint and formatting
  passed. Release-manifest registration tests passed.
- The new helper unit suite is registered for future combined gate executions.

The first diagnostic attempt exposed a stale provider-module fixture mock that
omitted a newly used pure export. That mock now retains the real bounded-body
reader while preserving synthetic provider I/O. A second attempt exposed an
over-specific expected denial status; the fixture now mints matching principal
roles, checks the existing 401/403 denial contract and reports actual statuses.
The successful result above followed both corrections.

The combined **56/56** execution documented in
[the full-length recording report](full-length-human-recordings-development-2026-11-04.md)
preceded this test-harness-only addition. It is not being relabeled as a later
combined execution. The additional helper and HTTP fixture checks above passed
separately; no application-runtime source changed for this diagnostic.

## Reproduction

After independently verifying the development database target:

```sh
MEETING_NOTES_TEST_DB_CONFIRM="$CONFIRMED_DEVELOPMENT_FINGERPRINT" \
NODE_ENV=test \
pnpm --filter @workspace/api-server exec node \
  --experimental-test-module-mocks \
  --import tsx \
  --import ../../scripts/test-egress-guard.mjs \
  scripts/check-meeting-notes.ts --benchmark-reads
```

Do not substitute an unverified production target. A successful command must
exit zero and finish with the fixture's final `PASS` line; a partial per-scenario
report followed by failure is not a passing fixture run.

## What this does not prove

This is one small, warm, synthetic source with limited concurrency. It does not
establish a production SLO, cold-cache performance, large-tenant query behavior,
simultaneous 100 MiB upload capacity, full-hour provider throughput, continuous
memory peaks or horizontal-replica readiness. There is no production access or
real provider mutation in this diagnostic.
