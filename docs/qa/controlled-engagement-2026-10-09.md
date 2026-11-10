# Stage 3 — native controlled outreach preparation

## Live check

A new isolated synthetic tenant, fictional SQL candidate and work order use the
previously designated Linx test inbox. Its existing candidate-portal account and
role were only read, never promoted or modified.

The real recipient-permission and identity-resolution HTTP endpoints recorded
explicit, expiring, workflow-only synthetic clearance. Canonical identity stayed
pending and `identityVerified` stayed false. Screening and identity prerequisites
were labelled fixture setup: no assessment calls were repeated and no real
candidate qualification or identity evidence was invented.

The unchanged native outreach agent made one successful OpenAI proxy / gpt-4o
request: 800 input tokens and 313 output tokens. Dollar cost remains unknown.
It created exactly one workflow-bound draft in `pending_approval`, with no
approval stamp, sent timestamp or reply.

The ordinary edit-before-approval endpoint added a prominent internal-test
disclosure and a Lexy / Linx subject. It did not change model configuration or
send the message. The subject is “Lexy / Linx internal test — are you interested?”
The message has no interview link and explains that any invitation requires
subsequent reviewed interest and separate approval.

Premature interview activation was rejected with HTTP 409. No interview session
was created. Engagement and every subsequent workflow step remained pending.
Execution authority was revoked after generation. The held draft and private
fixture metadata are retained so approval can send the same draft without
another model call.

## Regression coverage

Four isolated real PostgreSQL/HTTP tests passed with provider egress blocked:

- Synthetic contact sequence retains reviewed interest and separate invitation
  permission even with substituted transport.
- Invitation authority rejects unsent, negative, unbound, manual or out-of-order
  evidence.
- Manually recording Interested cannot auto-advance a bound workflow or claim
  an invitation.
- Native outreach must return exactly one held draft, never immediate sending.

Substituted transport proves those control boundaries, not inbox delivery.

## Live acceptance still outstanding

1. Owner explicitly approves the one held test email.
2. Canonical approval/dispatcher sends that existing draft once.
3. Owner actually receives the email and clicks its signed Interested button.
4. Inspect the saved reply and confirm no automatic invitation.
5. Review the real reply before any separately authorized Stage 4 invitation.

The read-only-by-default send runner targets only the exact isolated fixture and
existing draft. It renews the same approved inbox, uses the ordinary approval
route, and never generates a draft, creates an interview or directly changes a
message to `sent`. Changed or previously attempted messages are inspected rather
than automatically resent.

No commercial limits, worker settings, established prompts/models/providers or
older Linx work orders were changed.

The read-only send preflight passed. Preparation now exclusively claims its
private metadata file before database writes, preserving cleanup identifiers if
setup fails and refusing to replace an active pilot. A repeat-preparation probe
was rejected before writes and left the retained metadata unchanged. Formatting
and diff checks passed, and the running app's sign-in page rendered normally.
