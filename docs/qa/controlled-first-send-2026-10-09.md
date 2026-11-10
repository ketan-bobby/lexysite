# Controlled pilot first send

The owner explicitly approved one test email after reviewing the existing draft.
The draft body and subject were checked unchanged, with no previous approval,
send timestamp or interview link.

## Outcome

- Work order: `WO-2026-LIVE-MAIN-0013`.
- Workflow: `25f0638b-44ee-410a-aeb0-5d1f8163c49e`.
- Existing message: `d16aee37-41e0-4412-8cca-072f99936e9b`.
- Subject: “Exciting TypeScript Backend Opportunity in Bengaluru”.
- Normal authenticated approval endpoint returned `dispatched: true`.
- Persisted status: `sent`, at 2026-10-09 05:21:06 UTC (10:51:06 IST).
- The durable workflow first-send claim is present.
- Zero interview plans; the message's interview link is null.
- Automatic pipeline execution remains off.

The previous one-hour test-recipient permission had expired. Its renewal and
the separate engagement activation used the normal admin-gated workflow API
following the owner's fresh approval. The candidate-login account was not
promoted. Synthetic identity clearance remained workflow-only; canonical
identity was not verified.

Execution authority was revoked again after the successful send. No draft was
regenerated, no screening/identity/interview provider was rerun, and no resend
was requested. Engagement remains pending until the recipient's response and
its required review. The next three stages remain pending.

## Delivery and cost limitations

Successful dispatch means provider acceptance, not confirmed inbox delivery.
A time-correlated SES receipt recorded HTTP 200 and one observed recipient,
but remained tenantless/unattributed. It is preserved unchanged; this is not
unique workflow-attributed telemetry. Actual cost remains unknown.

The earlier repair permits workflow labels in the usage table but does not
establish attribution for every dispatcher path. This first-send observation
must not be represented as complete workflow cost coverage or justify repeating
an already-sent message.

Next: the controlled recipient clicks Interested; human review and separate
invitation approval still precede any interview invitation.

## Interested response confirmed

After the owner reported clicking Interested, the exact sent message recorded
`reply_sentiment=positive` at 2026-10-09 05:23:11 UTC (10:53:11 IST).
The normal workflow-state API exposes that message as current, job-scoped
engagement evidence ready for human review. Engagement is still pending review;
there are zero interview plans and the message has no interview link.
The click did not send or create an automatic interview invitation.
