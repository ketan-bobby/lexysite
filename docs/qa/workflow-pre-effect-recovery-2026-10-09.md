# Trusted pre-effect workflow recovery

## Implemented

- Read-only interview eligibility runs before reserving an external action.
- Trusted native control-flow failures carry a private server-only marker; provider errors,
  timeouts and inconclusive results never become pre-effect proof.
- A scoped admin may acknowledge a durably proven pre-effect failure and authorize one
  new claim generation. The original claim and outcome stay intact.
- Recovery uses revision checking, strict request validation and idempotency.
- Recovery revokes existing pilot spending authority. It never sends a message, runs a
  provider, completes a workflow step or creates interview evidence.
- The workflow view displays the proof or the reason recovery is blocked. Its recovery
  authorization message persists after reload; live execution remains separately locked.

## Verification

- All 50 recruiting workflow integration tests passed with the outbound-provider guard.
- Additional recovery assertions cover role/scope denial, missing acknowledgement,
  stale revisions, strict-body rejection, unknown errors, timeout rejection, claim
  retention, idempotent authorization and concurrent single execution.
- Shared libraries and Lexy frontend typecheck passed. API startup build/security guards
  passed. Existing unrelated API-wide TypeScript diagnostics remain.
- Signed-in browser verification used only a disposable synthetic tenant and workflows:
  unknown outcome had no recovery button; proven no-effect case required acknowledgement;
  one authorization persisted after reload; original history remained; live authority was
  inactive. Fixture-scoped interview, outreach and vendor-usage counts stayed zero.
- Initial browser setup lacked the session cookie; setting the fixture-only cookie
  resolved navigation. No application authentication settings were changed.

## Current controlled pilot limitation

The previous controlled interview attempt remains locked. Its durable outcome is unknown,
not a trusted pre-effect proof. Read-only checks found no job interview plans and no
workflow-scoped interview usage receipts, but absence of best-effort records is not proof
that a vendor performed no work. No recovery, new invitation or resend was performed on
that pilot. Its interview step remains review-required, and subsequent steps remain pending.

LLM models, prompts, provider routing and existing customer work orders were not changed.
