# Outlook invitation send-result evidence

## Scope

Existing recruiter-mailbox-enabled sends now distinguish Microsoft Graph request
acceptance from uncertainty and explicit rejection. This includes the existing
native interview-reply invitation path and mailbox-enabled outreach/manual mail.
It does not turn on Outlook sending for every invitation. Dedicated Greenhouse
and Zoho campaigns keep their existing transport selection.

No new permissions, credentials, database tables/migrations, automatic resend,
production changes, model changes or prompt changes were introduced.

## What Microsoft actually establishes

[Microsoft sendMail documentation](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)
states that success is **202 Accepted**, with no response body. It does not
establish completed processing or delivery.

| Observation | Interpretation | Immediate SES fallback |
| --- | --- | --- |
| 202 | Accepted for processing; delivery/reading unverified | No |
| No token or pre-dispatch preparation failure | Not attempted through Graph | Existing fallback allowed |
| Explicit supported 4xx rejection | Rejected through Graph | Existing fallback allowed |
| Network failure, timeout/408, 5xx, redirect, unexpected response or post-dispatch exception | Acceptance uncertain; review original attempt | No |

The adapter makes one Graph request with a bounded timeout. Each request has a
fresh opaque Lexy correlation reference, also sent as an `x-lexy-mail-attempt`
message header. A bounded safe Microsoft `request-id`, when returned, is recorded
separately. Neither is presented as an email message ID.

There is no mailbox scan, new Sent Items polling, delivery/read inference,
Exchange message-trace integration or fabricated message reference. Raw provider
error bodies are not retained as evidence.

## Staff UI

Open **Activity log** at `/activity`.

- **Interview** shows accepted interview actions that retain their original
  `interview.*` action.
- **Email** shows `email.review_required`, `email.graph_rejected` and
  `email.graph_not_attempted` observations. The original action remains in
  structured audit metadata for investigation.
- **All activity** shows Graph observations and any separate SES fallback event.

Graph rows show processing status, explicit delivery/reading caveats and safe
request references. A rejection observation alone does not assert that SES later
succeeded. Old Graph rows without structured evidence say so; absence is not
proof of rejection or non-delivery. SES rows do not acquire Graph claims.

There is no “mark delivered,” resend or override control. The current containing
log hides cached rows during refetch and after a failed/denied read; explicit
Refresh requires a fresh successful read before restoring details.

The existing tenant boundary remains in force. Audit reads now additionally
require an explicit staff-viewer role; in-tenant candidates and interview-only
accounts do not gain access through tenant membership. Responses are private,
no-store. This is a tenant activity viewer, not a newly introduced per-job audit
authorization model.

## Backend

- `graph-mail-transport.ts`: bounded, one-shot request and pure routing policy.
- `graph-mail.ts`: existing per-user OAuth/metering adapter; no token sharing.
- `email.ts`: only a known non-attempt/rejection can reach SES fallback.
  Structured Graph observations use the existing best-effort audit writer.
  Audit timestamps are local observation/recording times, not delivery times.
- `outreach-dispatch.ts`: an uncertain first-touch result retains a marked
  failure reason; the dispatcher refuses another attempt while that marker
  remains. This does not provide global exactly-once delivery or introduce a
  manual release mechanism.
- Native interview reply communications use pending rather than definite failure
  for an uncertain send. Existing scheduling/claim behavior is otherwise unchanged.

This is not a durable Graph reconciliation service equivalent to the new signed
SES observation pipeline. Audit insertion failure, process crashes, historical
untagged sends and legacy caller retry behavior must not be interpreted as proof
of non-delivery. Existing audit retention/erasure applies. Never replay a past
send solely to repair missing evidence.

## Verification

Automated tests cover 202, distinct request identifiers, unchanged recipient/
reply-to/inline attachments, no-token and token failures, explicit rejections,
5xx/408/redirect/unexpected status, network/adapter exceptions, no immediate SES
fallthrough on uncertainty, bounded references and separate account token use.
Staff-role policy tests exclude candidate/interviewer/unknown roles.

React rendering tests cover accepted, uncertain, rejected, not-attempted and
legacy rows, exclusion of raw metadata/unsafe references and no Graph label on
SES rows. The real Activity page was also exercised through a synthetic browser
harness: delayed refresh, 403 privacy hiding, explicit fresh recovery, exact
Email/Interview filters and a 390px viewport. The table scrolls inside its
container without horizontal page overflow.

These intercepted presentation tests do not prove real session authorization or
Microsoft account access. Existing SES/offer/webhook tests were run as regression
coverage. No live candidate invitation was sent in these tests.

## Team acceptance later

With an authorized test mailbox and one approved dummy recipient, verify the
existing OAuth binding, 202 observation and matching opaque request references.
Verify that a received message retains the custom correlation header, without
calling receipt proof of inbox placement for other messages. Test revoked
permissions/failure conditions in an isolated provider sandbox, not real
candidate traffic. Do not intentionally time out and resend a real invitation.

Real Exchange delivery tracing would require separately scoped provider support,
permissions and evidence validation; it is not implied by Mail.Send/Mail.Read.
