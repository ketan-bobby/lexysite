# Lexy autonomy readiness audit

Date: 8 October 2026  
Target: current workspace/development database and source code.

This was a read-only audit, not a production audit or a new live-provider test.
No candidate messages, paid searches, configuration changes, or historical
assessment changes were initiated by this audit.

## Confirmed working evidence

- LINX INC and its two named LINX India accounts are active on Enterprise.
- Linx's 13 current work orders are active, human-assisted, with the interview
  path set to recruiter choice.
- Two separate isolated test work orders are labelled autonomous: one selects
  the human interview path and the E2E work order selects the AI interview path.
- The E2E test work order has one sent outreach message and one recorded positive
  reply. Its eight completed interview sessions have canonical assessment scores
  and attached recording pointers. These are sessions, not eight distinct candidates.
- Its linked candidate application has reached `interview_completed`.
- The earlier standalone test has one completed, assessed, recorded session.
- Linx's three historical completed sessions also have canonical assessments.
  The legacy session score field being null is not evidence of missing grading.
- At audit time, no AI queue rows were pending, processing, or failed.
- Queue code includes atomic claims, deduplication, bounded retries/backoff,
  terminal failures, and reclaiming abandoned processing locks. This audit did
  not inject a fresh crash or test provider delivery.

## Readiness gaps

### Existing Linx configuration is intentionally unchanged

Linx has no saved recruiting journeys, enrolled workflows, sourcing policies,
or sourcing cost operations. Enterprise features being available is distinct
from an autonomous workflow being configured, approved, and executing.
The owner asked to leave existing Linx work orders as they are. Their assisted
mode is not a defect or a blocker; assess new autonomy using the isolated pilot.

### Existing pilot activity is not accepted workflow completion

The isolated E2E pilot has one approved AI journey and one ready workflow.
All six tracked steps remain pending, with one workflow event. Completed
interview and pipeline activity must not be presented as completion of this
approved journey. All tracked steps currently retain human-review authority.

Follow-up source inspection confirmed that the review projection already links
the actual saved positive reply and eight interview assessments to this workflow:
17 observations (one engagement, eight AI-interview, eight evaluation-review).
The current approved brief matches and there is no overall blocking reason.
All observations are blocked for acceptance by incomplete preceding steps.

The missing prerequisites are concrete: no job-specific résumé-screen record,
no linked sourced screening record, and one candidate identity-verification
record still in `pending` status. A pending identity record is not completed
verification evidence. The UI renders these observations and their sequencing
reason; accepting them is deliberately human-controlled.

This corrects the interpretation that the pending checklist alone proved an
unconnected evidence reader. It does not prove autonomous execution is enabled.
Do not fabricate screening/verification completion, replay the interviews, or
use an interview assessment as identity-verification evidence.

The eight existing runtime-evidence projection tests passed without database
writes or live-provider calls. They cover sequencing, positive-reply timing,
attempt/candidate/path boundaries, paused/terminal state, and source-token binding.

Further pilot-data inspection found no résumé, LinkedIn URL or phone number.
The existing verification result is an actual agent `review` verdict explaining
the incomplete profile, not evidence that the agent never ran. This does not
independently prove candidate identity.

The evidence reader previously excluded the verifier's actual `pending` and
`flagged` statuses. It now surfaces pending verification as unresolved and
ineligible for acceptance, and flagged outcomes as needing human attention.
The existing observed-activity UI consumes these entries without a contract
change. A fresh read of the pilot returned its unresolved verification alongside
the reply and assessments; workflow state, revision and step statuses remained
unchanged. Thirteen projection tests, targeted lint and formatting passed, and
the managed API build/restart succeeded. No résumé or verification success was
invented, and no assessment or candidate record was changed by this fix.

Real job-specific screening remains blocked on a résumé for the pilot candidate.
Repeated AI verification against unchanged sparse data is not a remedy for
missing evidence. A human must resolve the outstanding identity review before
claiming verification completion.

### Planning controls are not a live paid execution engine

The sourcing-controls response explicitly reports execution and outreach
disabled for the new controlled lane, while internal discovery is enabled.
The sourcing meter's live pricing catalog is empty and its real-dispatch
assertion always refuses dispatch. Its bounded adapter execution is test-only.
This does not mean existing external sourcing is disabled; it is a separate path.

### Pause/cancel is not a universal automation stop

Workflow pause/cancel changes tracked workflow state. The legacy orchestrator
and its outreach dispatcher do not use this state as a global stop authority.
Existing assisted automation remains separate.

Legacy first-touch outreach normally requires approval initially, then permits
subsequent first touches after any outreach approval on the same work order;
explicit callers can also request immediate sending. Do not represent this as
per-candidate approval or as enforcement of the newer journey controls.

### Enterprise is not itself a fee waiver

No active complimentary pilot grant was found for Linx or its descendants.
The Enterprise plan is active, but a redeemed complimentary pilot grant is
needed for the blanket Lexy fee waiver. This audit did not charge an account
or infer that any invoice was actually collected. External vendor charges remain
independent of free Lexy access.

## Recommended next engineering unit

Connect an explicitly approved journey to a controlled runtime coordinator,
enforcing current approval, scope, consent, pause/cancel and evidence requirements
before each action. Start with a no-send/no-spend verification path, preserve
existing assisted work orders and external sourcing, and keep hiring decisions
human-owned. Do not enable live paid dispatch merely by changing a boolean.

This is an execution-integration gap, not a reason to retune the stabilized LLMs
or ask the candidate to repeat another interview.

## Source references

- artifacts/api-server/src/lib/recruiting-workflows.ts
- artifacts/api-server/src/lib/workflow-runtime-evidence.ts
- artifacts/api-server/src/lib/sourcing-controls.ts
- artifacts/api-server/src/lib/sourcing-meter.ts
- artifacts/api-server/src/lib/agents/orchestrator.ts
- artifacts/api-server/src/lib/outreach-dispatch.ts
- artifacts/api-server/src/lib/ai-queue/queue.ts
- artifacts/api-server/src/lib/ai-queue/worker.ts
