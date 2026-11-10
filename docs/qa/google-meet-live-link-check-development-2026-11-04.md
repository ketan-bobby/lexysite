# Candidate Google Meet link checks — development

## Completed scope

The candidate-owned Meet endpoint now checks the known original Google event
before publishing the saved Join URL. A stored accepted invitation is necessary,
but no longer sufficient on its own.

- Canonical candidate/user ownership, current organizer access, native booking,
  approved job, current grant/consent and saved panel evidence are checked first.
- Only the original primary-calendar event is read. Exact organizer, guests,
  private binding, title, times, operation marker and conference must agree.
- External time changes, changed/removed guests, changed Meet codes, deleted or
  cancelled events, malformed responses, revoked access, throttling and provider
  failures withhold the URL. Provider response bodies are never serialized.
- Credential refresh and durable compare-and-swap rotation occur outside booking
  locks. A subsequent read failure does not roll back a provider token rotation.
- After the Google read, canonical ownership and current local evidence are read
  again. A concurrent local cancellation, erasure, permission change or replacement
  receipt cannot reuse the first read's ready result.
- The existing candidate component polls while visible, refreshes on focus and
  checks again on Join. Its Join timeout now allows the two bounded provider
  requests. No cached ready link is used while a request is pending or failed.

This is **read-time verification**, not a background Google synchronization
service. A visible button can remain until the next refresh, but clicking it
requires another successful check. Changes after that final check remain a
normal external-system race. This does not automatically change Lexy's native
appointment, adopt a new Meet code, repair an invitation or establish delivery,
RSVP or provider mutation acceptance. Recovery stays with the existing controlled
staff workflow; uncertain cancellation does not become accepted by absence.

## Verification

- **79 focused tests passed** across candidate projection/live verification,
  original-event parsing, invitation/operation behavior, recording boundaries
  and candidate/staff HTTP access controls. Google transport was synthetic.
- **101 combined development fixture checks passed** with a fingerprint-guarded
  development database and mocked provider/storage/AI adapters. The real candidate
  store is exercised before and after verification, including a cancellation
  committed during the provider callback. No live Google meeting was mutated
  and no invitation was sent by these fixtures.
- API and web TypeScript checks passed; changed-source ESLint, Prettier and
  `git diff --check` passed.
- Managed API and web workflows restarted once; API build/security guards passed.
  Development `/api/healthz` returned HTTP 200 with a healthy database.
- Login screenshot loaded normally. It is not evidence of signed-in LINX or live
  Google acceptance; those checks still require the controlled team test.

No schema migration, public contract shape change, production change, AI model,
provider-routing, prompt, rubric or pilot entitlement change was made.

The pre-existing Stripe sentinel alert remains and sent its existing admin
notification on startup. Billing settings were not changed. The existing failed
full assisted-baseline workflow was not rerun or declared passing.

## Remaining boundary

Controlled live Google/LINX acceptance and the independent dummy work-order
review remain pending. Passing these targeted development checks is not full
release readiness or completion of the broader competitor audit.
