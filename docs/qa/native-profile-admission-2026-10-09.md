# Native profile human admission

Selected successful PDL/Serp discovery references can be admitted through
Workflow controls, separately from discovery or EnrichLayer. An authorized
work-order approver must supply a confirmed name. New canonical candidates stay
tenant-private and unverified; absent email uses a non-deliverable import
placeholder. New applications enter Sourced with no fabricated match score.
Existing canonical identities and application stages/origins are preserved,
including applications whose row tenant differs from their authorized job.

Admission performs no provider request, assessment, invitation or outreach.
It requires current approved workflow/policy and the selected saved reference.
Replay is idempotent, privacy exclusions fail closed, and candidate/source/
application/audit persistence is atomic.

## Verification

- Full sourcing-control regression suite: 56 passed.
- Five focused admission cases passed again after the dual-tenant preservation
  check was added; includes audit-failure rollback and restricted identities.
- Signed-in browser: empty-name gating, explicit confirmation, HTTP 200 import,
  imported flag, one sourced application with null match score, unverified
  candidate and zero job-scoped outreach messages verified.
- Frontend typecheck passed; API build/security guards passed. Full API
  typecheck has pre-existing unrelated diagnostics.
- Broader assisted baseline: 431 other API checks passed, but the workflow-
  journey batch timed out at 240 seconds. This is not a complete baseline pass.
- Phone layout remained cramped with small horizontal overflow in the wider
  job/planning screen. Admission fields/buttons now have shrink/wrap safeguards;
  full interactive phone acceptance remains unverified.

## Browser-test incident

The first browser check mistakenly used the live sourcing action to seek review
controls. It started a real search; a PDL attempt returned 404. The test cancelled
the run immediately and confirmed zero linked applications before admission.
This session must not be described as entirely provider-free or as proof of
zero vendor cost. No retry was made. The header now distinguishes **Workflow
controls** (navigation/read-only) from **Start live sourcing** (execution).

EnrichLayer account-credit retesting remains deferred. Provider availability,
commercial tiers, older Linx work orders and stabilized LLM/provider routing
were not changed.
