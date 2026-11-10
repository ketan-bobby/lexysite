# Native six-stage evidence audit — 2026-10-10

## Current retained pilot

Read-only checks confirm the isolated, server-marked controlled-inbox workflow
still has all six operational steps completed. This is not a production
certification, real candidate qualification or independent identity clearance.

| Stage | Operational status | Evidence and limits |
| --- | --- | --- |
| 1. Screening | Completed | Retained pilot uses synthetic predecessor evidence. A separate isolated native screening fixture has one successful HTTP 200 model receipt; its documented screening result was 85/100. Do not describe that receipt as this pilot's screening. |
| 2. Verification | Completed, test-only | A separate advisory-identity fixture has one successful HTTP 200 model receipt. AI profile advice is not independent identity verification. The retained candidate's canonical identity remains pending. |
| 3. Engagement | Completed | Saved controlled-inbox interest/review/invitation evidence and scoped successful email/model usage exist. Provider acceptance alone is not proof of inbox receipt. |
| 4. AI interview | Completed | Five expected answers, five captured and five graded. Stored score 46/100 and recommendation Yes remain unchanged; the disagreement warning requires human review. No new interview or grading was run. |
| 5. Evaluation review | Completed, test-only | Recorded explicit human review, not automatic endorsement of the model recommendation or a real hire. |
| 6. Hiring decision/offers | Completed, test-only | Explicit structured synthetic Hire intent exists. Version-2 controlled offer is approved and Sent with a non-demo receipt; no recipient response is recorded. Sent means provider acceptance, not confirmed inbox delivery. |

The retained application remains `interview_completed`; the test candidate is
excluded from real hiring statistics. Employment outcomes and fee items are zero.
Neither offer sending nor response is an employment/identity/fee trigger.

## Existing provider evidence

The earlier EnrichLayer 403/capacity report is historical, not its current status.
The subsequent standalone retest already returned one usable profile, HTTP 200
and an operation-bound durable receipt. Screening and advisory identity also
already have successful scoped receipts. Those calls were not repeated.

## Fresh combined discovery → enrichment check

A new provider-only work order and fresh approved reservation were used in the
existing isolated live-pilot tenant. Original claims were not reset or retried.
The existing native registry, credentials and provider routing were used unchanged.
The human-approved test scope allowed at most two enrichment profiles; this is
not a new commercial restriction on external sourcing.

| Operation | HTTP | Result | Attributed usage |
| --- | --- | --- | --- |
| PDL discovery | 200 | Two saved discovery profiles | One attempt; provider reported two credits |
| SerpAPI discovery | 200 | No usable profiles in this query | One attempt with provider request ID |
| EnrichLayer profile 1 | 200 | One usable enriched profile | One attempt with operation key and provider request ID |
| EnrichLayer profile 2 | 200 | One usable enriched profile | One attempt with operation key and provider request ID |

All four durable receipts are bound to the new tenant/reservation and individual
operations. The repeated execution command returned replay and added **zero**
requests. Stored HTTP statuses and observed request counts were independently
asserted through read-only database queries.

The new work order has zero applications, candidate workflows, imported sourcing
rows or outreach messages. No candidate contact/import, interview, screening,
identity reassessment or offer send was invoked by this run. Platform
recommendations and pipeline autorun remain off for this isolated work order.
The source work order and old Linx hiring data were not edited.

Actual dollar costs remain unknown. PDL's two credits are a usage observation,
not a dollar bill; EnrichLayer and SerpAPI success do not establish billed cost.

## Native uploaded-file intake check

Fresh fictional, unlinked candidates were created only inside the retained
isolated test tenant. Both **DOCX and PDF** passed the ordinary authenticated
staff upload → résumé attachment → skills extraction → fresh candidate read.

- The stored pointer survived, and attachment/fresh-read responses exposed the
  same SQL/PostgreSQL skills saved in the database.
- The pre-existing manually entered skill and `manual` provenance were preserved.
- Both profiles remained excluded from real hiring statistics and were marked
  Do Not Contact after verification. No job links, job assessments, interviews
  or candidate emails were created.
- The explicit opt-in QA driver uses create-once journals; an attempted or
  uncertain attachment cannot be automatically repeated. Preparation recovery
  is allowed only before upload, with no candidate insert having taken effect.
- The initial fixture setup needed a non-null fictional email; it was corrected
  before any upload/model call. The PDF fixture was produced with installed
  Chromium and locally validated before live submission. These were harness
  corrections, not production parser or LLM changes.

This proves the native staff attachment/skills path in both formats. It does
**not** prove full-field machine-to-machine bulk import, browser file download,
job-specific résumé screening or a clean repository-wide TypeScript check.
Résumé parsing dollar costs remain unknown; operation-bound receipt coverage
from the discovery/enrichment run must not be attributed to these separate calls.

The QA driver passed changed-file lint and formatting checks. No production
application code, workflow configuration, credentials or LLM settings changed.

## Remaining work, without overstating gaps

1. **Remaining résumé coverage:** native PDF/DOCX attachment and skill persistence
   passed the earlier live check. Secure file ownership, current candidate scope,
   duplicate skill preservation and bulk-import responses now have isolated
   regression coverage. Live secure intake/download verification is **blocked**:
   AWS denies `s3:PutObjectTagging` and `s3:GetObjectTagging`. Those permissions
   are required on the résumé object prefix; do not bypass them with a public
   grant or an arbitrary candidate URL pointer. The machine-to-machine importer
   also needs its separately configured `LEXY_IMPORT_API_KEY`; its isolated
   contract tests are not evidence that the deployed importer is enabled.
2. **Genuine identity evidence:** the implemented AI path is advisory. Human
   corroboration is supported, but a fictional fixture cannot prove real-person
   identity. A new external identity provider is a separate product/integration
   decision, not a broken OpenAI key.
3. **Offer delivery/response:** local attempt reconciliation is implemented.
   Exact-attempt SES webhook tracking is now implemented and verified with
   signed local HTTP/database fixtures, including human-only reconciliation.
   Live callback verification still needs completed AWS SNS destination setup
   and the topic allowlist. The webhook variable was later found configured as
   an ordinary shared variable; secure setup is covered by
   `docs/ops/aws-live-test-checklist.html`. These AWS checks are deferred until
   the user confirms their team's setup is ready. The retained offer has no recorded
   response; no historical delivery evidence was invented.
   See `offer-provider-delivery-2026-10-10.md`. Do not resend or answer for the recipient.
4. **ATS layer:** local, ATS-independent record mapping and human-reviewed
   snapshot export are implemented; see `ats-independent-handoff-2026-10-10.md`.
   Greenhouse is not connected. Manual mapping/export is not synchronization
   or verified remote-record existence. Native hiring and one employer-owned
   offer process remain intact.

Notification-history pagination now preserves the existing array contract, adds
caller-bound keyset cursors, and uses exact PostgreSQL timestamp precision.
Real HTTP/database checks pass for historical read state, full unread counts,
insertions between pages, tied timestamps, invalid cursors and user isolation.
Signed-in desktop/phone browser acceptance also passed: retry retained loaded
rows, older pages and polling preserved history, and read state survived reload.
See `notification-history-2026-10-10.md`. Both test fixtures were cleaned up.
The backend-wide TypeScript backlog was a historical observation. The current
compiler check is clean; see `backend-readiness-closeout-2026-10-12.md` for the
later engineering checks and route-access corrections. No models, prompts,
rubrics, commercial tiers or external-sourcing
availability were changed.

## Subsequent multilingual diagnostic

See `multilingual-grading-2026-10-10.md`: ten selected languages returned valid
synthetic text grades with a maximum five-point detailed-answer difference.
This is not independently reviewed calibration or audio/whole-language coverage.
The original run's usage receipts failed to persist; the diagnostic label was
repaired and verified with a simulated transport, without repeating paid calls.
No historical six-stage evidence or configured grading behavior was changed.
