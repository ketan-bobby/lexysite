# Controlled invitation attempt — 2026-10-09

## Owner authority and scope

The owner explicitly approved reviewing the controlled Interested response and
sending one test interview invitation. Scope stayed on isolated work order
`livepilot_e2e_20261008_controlled_job`, workflow
`25f0638b-44ee-410a-aeb0-5d1f8163c49e`, and its approved fictional candidate.
No existing Linx work order, identity result, model, prompt, or provider
configuration was changed.

## Actual outcome

- Positive reply evidence was revalidated against outreach message
  `d16aee37-41e0-4412-8cca-072f99936e9b` and reviewed through the authenticated
  workflow evidence endpoint. Engagement is completed.
- One native invitation execution was requested at `2026-10-09T05:28:14.518Z`.
  The native interview run finished in 19 ms; the execution endpoint returned
  HTTP 409 requiring human reconciliation.
- The runner's old eligibility gate required an `advance` recommendation,
  despite the previously approved test-only human review of the saved `hold`.
  That gate precedes question generation, session creation and invitation send.
- Audit found zero interview plans for this job and zero receipts in this
  workflow's `ai_interview` usage scope. No interview invitation was sent.
  Receipt absence is corroboration, not a general proof of no external effects.
- The original durable action claim was not deleted, reset or replayed. No
  second native invitation execution was attempted.

## Repair and validation

The native screening gate now lets a bound, already human-reviewed workflow
continue from `hold`, without changing the source score or recommendation.
Unbound automation still requires `advance`. Unperformed screening, `reject`,
and missing recommendations still fail closed.

Four focused checks passed: reviewed-hold handling, remaining screening gates,
invitation authority restrictions, and rejection of link-only invitation
success. Test egress was blocked. The API build/security guards passed and the
managed service restarted successfully. The public sign-in screen renders.
This is not proof of a successful native invitation or interview completion.

## Persisted final state

Workflow revision 15:

| Step | Status |
| --- | --- |
| Screening | completed — original grade retained |
| Identity review | completed — workflow-only synthetic test clearance |
| Engagement | completed — reviewed positive reply |
| AI interview | review_required — blocked attempt documented |
| Evaluation review | pending |
| Hiring decision | pending |

Execution permission was revoked through the normal control endpoint.
Pipeline auto-run remains false. The synthetic candidate's canonical identity
remains pending/unverified. The remaining blocker is an audited recovery path
for proven pre-effect failures; ambiguous provider outcomes must not be retried.
