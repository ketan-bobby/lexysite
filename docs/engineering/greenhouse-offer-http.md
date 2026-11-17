# Greenhouse offer wire transport — local implementation

## Scope

The [configuration reader](greenhouse-offer-configuration.md) adds bounded,
read-only employer field/choice/visibility/opening discovery under one deadline.
It does not authorize financial writes or assume missing employer settings.

The [permission-evidence and approval-read increment](greenhouse-offer-evidence.md)
adds mandatory credential-bound server evidence and separate job/offer approval
metadata reads. The module remains unconnected to the application.

Added a server-only, fixed-purpose Harvest v3 wire encoder and HTTP transport.
**This is not a connected offer integration.** Nothing imports it into the
application's offer workspace, public routes, schedulers or generic ATS gateway.
It has no default token resolver or fetcher and reads no environment credentials.
Tests supply a synthetic authorizer and mocked fetch. No provider requests,
application database changes, customer messages or production changes are made.

The current application workspace still allows only local proposal save/review
and explicitly injected simulations. This increment must not enable live buttons.

## Supported operations and safeguards

- Read the latest offer with exact application/candidate/job filters, at most one
  result, and no pagination following. Unexpected foreign/broad results fail.
- Create a draft only through fixed `POST https://harvest.greenhouse.io/v3/offers`.
  There is no arbitrary URL, method, headers, approval endpoint or send operation.
- Exactly one fetch invocation per operation. No status-code retry, token-refresh
  retry, redirect following or Retry-After retry.
- At most 10 seconds for authorization, fetch and response consumption combined.
  The deadline works even if an injected fetch ignores AbortSignal. Late
  authorization cannot begin a deferred write after that deadline.
- Streamed responses and UTF-8 requests are bounded to 512 KiB. Unexpected status,
  media type, redirects, pagination, oversized or malformed responses fail closed.
- Failures after a create invocation return **uncertain**, never a no-effect
  assurance. Read failures expose only a generic error without provider details,
  raw payload, token or nested cause.
- Private read authority is checked before and after the read. Employer,
  connection and saved-intent revision must match the server-owned permit.
- Creation additionally requires the designated submitter, current human hiring
  intent, a fresh verified employer contract, create authority, a claimed-attempt
  reference and the exact previously reviewed wire-body hash.

The authorizer is an injected trusted server dependency, **not implemented
permission discovery**. It must independently verify current HR authority,
employer/connection custody, private read permission, create permission, the exact
durable claim and financial approval. A well-shaped permit or token is not proof
of those facts. Neither permits nor tokens may come from request JSON or logs.

No in-memory exactly-once promise is made. Future assembly must call this only
through the existing durable human-controlled claim protocol, never directly from
a route, background job or automatic retry.

## Financial encoding

The encoder follows Harvest's `custom_fields` array with `name_key` and `value`.
Optional opening and date fields are omitted when unset. It supports Lexy's
current scalar/choice/date and currency subset; it does not invent mappings for
multi-select, boolean, calculated, range or other unsupported employer fields.

Currency conversion requires explicitly supplied, verified decimal precision
per currency, including currencies that do not have two minor-unit digits.
The exact decimal JSON amount is checked against integer minor units using
integer arithmetic. Values that would lose a minor unit at large magnitudes are
rejected. The reviewed wire-body hash binds this conversion before any write.

A create response is accepted only as a **Created draft** if its identities,
dates, opening and financial values match, it has no sent/resolved date, and it
contains no unexpected non-null financial defaults. This is not independent
read-back verification, an approval-flow request, approval, delivery or employment.

Read results provide a chain fingerprint containing the returned financial terms
and update metadata, not just offer ID/version. This matters because Harvest may
update the existing offer in place without creating a new version.

## Contract findings and remaining work

Official Harvest documentation was checked on 2026-11-14:

- [Create offer](https://harvestdocs.greenhouse.io/reference/post_v3-offers.md)
- [List offers](https://harvestdocs.greenhouse.io/reference/get_v3-offers.md)

An empty list does not independently prove there is no existing offer: a Site
Admin token without the required private-offer advanced permission can receive
an empty list despite having the list scope. The trusted authorizer must establish
that authority separately before absence can be used.

Creating an offer attaches configured approval flows but does not establish that
approval has been requested or granted. The
[controlled assembly](greenhouse-offer-assembly.md) now adds a separate
claim-bound internal approval request only after committing the exact draft
receipt, then independently reads back the resulting flow and financial terms.

Still required:

1. Real employer field/opening/permission and approval-flow discovery, plus
   verified credential/connection custody and durable-claim authorization.
2. Authoritative custody, employer-review and workflow-evidence loaders plus
   explicit API bootstrap for the implemented dependency-injected assembly.
3. Authorized dummy-employer and deployment acceptance. No generic gateway
   financial-write exemption has been added.

BUILD-02 remains Blocked.

## Verification and files

On 2026-11-15, the expanded suite passed **75 mocked HTTP/encoding,
permission/approval and configuration tests**, along with API type checking and changed-source
formatting. The full assisted baseline and live Greenhouse acceptance were not
run for this increment.

Run:

```sh
pnpm --filter @workspace/api-server run test:greenhouse-offer-http
```

The suite is registered in the assisted baseline. It tests valid encoding and
creation, zero-/three-digit currencies, lossy large amounts, exact permit/actor
and revision bindings, request/response limits, malformed or foreign results,
permission loss during reads, separate approval semantics, timeouts, cancelled
streams, and no retries for 301/401/403/422/429/500/503 or network failure.

- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-wire.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-http.ts`
- `artifacts/api-server/src/lib/ats-connectors/greenhouse-offer-http.test.ts`
