# Manual inbox replies and interview reminder attempt safety

## Implemented

### Manual recruiter inbox replies

The existing authenticated inbox-reply route now saves a pending communication
record **before** calling the email transport. Its deterministic operation ID
represents the same tenant, inbox item, staff sender, subject and reply text.
Whitespace-only changes around the subject/body do not create a new intent.

- A repeated accepted request returns success without a second provider call.
- Concurrent requests cannot both acquire the same record.
- A pending/uncertain attempt remains held after reload or a lost response.
- Only an explicitly recorded rejection/non-attempt can be claimed for retry.
- A changed resolved recipient address does not bypass the same reply's hold.
- A different reply or different inbox item remains a separate intentional
  operation; this is not a conversation-wide/candidate-wide contact lock.

Ownership checks and candidate/address resolution remain in the existing route.
The shared store scopes reads and state changes by tenant and operation ID.
An unknown result still reaches the existing error UI and does not mark the inbox
item read. The original success-response shape remains unchanged.

### Interview re-engagement

`sendReEngagement` retains the existing atomic session claim, workflow/campaign
approval gates, token logic and message-generation configuration. The reminder
also gets a pending communication record before transport I/O.

The pre-existing session claim is not cleared on uncertainty or persistence
failure. Its timestamp is claim time—not evidence that an email was accepted or
delivered. This work does not change invitation TTLs, session-expiry/abandonment
policy or hiring-stage decisions.

### Transport and outcomes

Both named send boundaries request a single SES SDK attempt. Manual replies
retain their existing Outlook opt-in; interview reminders remain on their
existing SES path. Safe immediate Graph-to-SES fallback rules remain unchanged.

Communication status meanings for these newly managed records:

| Status | Meaning |
| --- | --- |
| `pending` | Claim/in-flight result or uncertainty; do not resend automatically |
| `sent` | Provider processing acceptance saved; **not** recipient delivery/open/read proof |
| `failed` | Explicit rejection or known non-attempt saved; ordinary caller retry policy applies |

If acceptance is saved but the response is lost, a replay reads the saved state
instead of sending again. If final persistence fails without a saved acceptance,
the pending claim remains. Provider exceptions and unclassified failures are not
converted into ordinary retryable failures.

Explicit simulation/demo suppression is a known no-provider-I/O result. Its
temporary pending claim is removed rather than creating false sent/failed
history or a permanent uncertainty hold. No real/uncertain attempt history is
deleted by this cleanup.

The existing Activity audit receives an opaque `mailOperationId` correlation
alongside the existing inbox/session context. That ID is not a provider message
ID or an authorization to resend. Communication `createdAt` is not a retry's
provider-attempt timestamp.

## Files

- `artifacts/api-server/src/lib/recorded-communication.ts`
- `artifacts/api-server/src/routes/outreach.ts`
- `artifacts/api-server/src/lib/agents/interview-reply.ts`

No schema migration, production access, new billing restrictions or changes to
LLMs, prompts, assessment rubrics or provider selection.

## Verification and remaining scope

52 targeted/regression tests passed, including:

- In-memory concurrency, replay, lost-response, claim/final-write failure,
  rejection/non-attempt, simulation and suppression cases.
- Execution of the current inbox handler and reminder function with injected
  dependencies—no real AI generation, mail transport or session mutation.
- Real development communication-store fixtures verifying concurrent claims,
  tenant isolation, accepted replay, persistent uncertainty and write failure.
- Existing authenticated outreach ownership, role, approval, simulation-reset
  and transport safety regressions.

Development fixtures were synthetic and cleaned up. All provider sends in these
checks were mocked or not reached. Browser/live-provider/team acceptance is not
claimed by these tests.

This protects newly managed attempts, not historical replies sent before these
records existed. There is no automatic hold expiry or override, no global
exactly-once guarantee, and no retrospective inference of delivery. Automatic
platform inactivity reminders, self-reported job-change follow-ups and other
mail entrypoints remain separate send boundaries to review.
