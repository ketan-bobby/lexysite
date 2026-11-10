# Controlled offer provider-delivery tracking

## Implemented

- Future SES-controlled-offer sends carry server-owned workflow, offer, exact
  version and send-attempt tags. No financial terms, candidate answers or
  private response capability is included in tags.
- `/api/webhooks/ses-events` accepts SNS JSON using both application/json and
  SNS's default text/plain content type, bounded to 1 MB at the route parser.
- The existing shared-secret and AWS signature checks remain intact. Offer
  events additionally require an exact configured topic allowlist even in
  development; the unsigned development escape hatch cannot write offers.
- Delivery, delivery delay, permanent/transient bounce, rejection, rendering
  failure, complaint and provider acceptance are distinguished. Open/click
  tracking is not introduced.
- Events must match the offer version, original attempt, provider message and
  intended recipient. Updates are durable and serialized with the same job lock
  as manual offer changes. Duplicate events do not duplicate revisions/audits.
- Callback history is bounded, and out-of-order events cannot erase terminal
  failures or complaints. Matching archived versions remain separate from a
  replacement offer.
- Offer details show provider status and poll for changes even after a recipient
  response. Employer inbox warnings identify delivery issues.
- A callback never approves, sends, resends, accepts, declines, changes terms or
  creates employment/fees. Uncertain delivery remains held until human review.
- Financial-letter SES sends use a single transport attempt; other transactional
  email behavior is unchanged. Conflicting callback/send receipts remain held.
- Exact-attempt verified provider evidence is available to the existing manual
  reconciliation action and prevents an incorrect no-effect release.

## Verification

- 25 targeted tests passed: the new provider parser/reducer, real local RSA
  signature verification through the HTTP webhook, persistent database reads,
  replay/concurrent-update behavior, and the existing controlled-offer authority,
  privacy, inbox, correction and recovery regression checks.
- SNS text/plain and the forbidden unsigned-offer escape hatch were verified.
  The SES command's exact tags and single-attempt transport were also checked
  with a mocked SDK send; no actual provider request was made by that fixture.
- Frontend TypeScript passes. Shared library TypeScript passes.
- Backend TypeScript remains at the existing 520 diagnostics; none originate
  from this change. Changed-source lint has zero errors and one existing unused
  variable warning in the inbound conversation handler.
- No live candidate offer, candidate email, interview or offer-provider send was
  initiated. All database fixtures are fictional and cleaned by exact IDs.
- Tests use local signing keys and a mocked certificate fetch. They prove the
  validation/processing contract, not AWS's live publishing configuration.

## AWS setup still required

Existence-only checks in the development environment found:

- `SES_CONFIGURATION_SET`: present.
- `INBOUND_EMAIL_SECRET`: absent.
- `SES_SNS_TOPIC_ARNS`: absent as both a secret and an environment variable.

Have the AWS/application administrator:

1. Connect the already selected SES configuration set to an SNS event destination
   for Send, Delivery, DeliveryDelay, Bounce, Complaint, Reject and Rendering
   Failure. Keep existing SES sender/region/model/provider routing unchanged.
2. Configure an HTTPS subscription to this environment's actual
   `/api/webhooks/ses-events` endpoint. Do not point development records at a
   different environment or assume a development domain is the production URL.
3. Add a strong `INBOUND_EMAIL_SECRET` through Replit Secrets. The subscription
   must supply the same secret via the existing guarded transport (SNS endpoint
   query parameter, or a trusted proxy header). Never commit or share its value.
4. Set `SES_SNS_TOPIC_ARNS` to the exact approved SNS topic ARN(s), comma separated,
   and complete the signed subscription confirmation.
5. With explicit authorization, use a fresh isolated offer for one live
   callback check. Do not resend the retained offer or fabricate old tags,
   delivery timestamps, candidate reading or recipient responses.

This setup is not a commercial-tier or payment restriction. Offer sending stays
human-operated; missing callbacks display as unconfirmed rather than disabling
the rest of the recruiting workflow.

The separate S3 résumé-tagging permission issue remains unresolved. Greenhouse
connection work remains separate; native employer-owned offers are retained.
