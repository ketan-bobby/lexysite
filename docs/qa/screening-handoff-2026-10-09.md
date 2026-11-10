# Screening handoff — 2026-10-09

## Delivered

- Authorized workflow snapshots expose screening-input readiness, without
  exposing additional résumé links or profile details.
- Planning remains available while qualifications are missing.
- The existing stabilized screening prompt consumes canonical role and skills.
  A name, public-profile reference or unparsed résumé URL alone is not sufficient.
- A missing-input request fails before the durable action claim or assessor
  invocation. Saved qualification inputs allow the existing controlled execution
  path; approvals, revocation and human evidence review remain separate.
- Workflow-bound source reuse updates its qualification snapshot from canonical
  profile data. It preserves the source identity, job linkage, previous stage,
  prior grade and native discovery provenance.
- No model, prompt, provider routing, commercial tier or EnrichLayer setting
  was changed. No old Linx work-order records were modified.

## Verification

- 34 unit/regression checks passed across profile screening, runtime evidence
  and workflow shadow planning.
- Three focused transactional integration checks passed: missing input is
  rejected without a claim or invocation; usable saved inputs proceed while
  retaining human review; source reuse preserves prior evidence and avoids
  duplicate rows. The existing production-wrapper test also rejects zero-work
  and malformed grades using substituted assessor results.
- Generated API libraries and frontend typecheck passed; touched-file lint and
  whitespace checks passed.
- Full API typecheck remains non-green from existing unrelated diagnostics,
  including an unchanged integration-fixture transaction-type mismatch. No new
  diagnostics remain in changed production modules.
- Tests used isolated synthetic fixtures and controlled/substituted execution,
  with external test egress blocked. This is not a live-provider assessment.

## Signed-in acceptance and ingestion boundary

- A disposable synthetic tenant/job/candidate session used the real API.
  Profile editing returned HTTP 200; after reload, saving a role changed
  screening readiness to `ready:true, reason:null`.
- A separate candidate with only an unparsed fictional résumé reference could
  be enrolled through the real candidate-workflows endpoint (HTTP 200).
  Reload confirmed persistence, the missing-qualifications warning, all six
  steps pending, no execution evidence, and no active pilot. Planning is not
  an assessment result.
- The browser mutation allowlist was installed before navigation. It permitted
  only the fixture profile edit and exact fixture enrollment. The initial
  rejected enrollment was a mistaken harness URL, not an app failure; correcting
  it preserved fixture/body restrictions and did not require an app change.
- Three new isolated PostgreSQL tests exercise the production résumé enrichment
  path with substituted storage bytes and AI extraction. Extracted skills become
  canonical before readiness changes; empty extraction stays unready; repeated
  extraction preserves manually saved skills, provenance and absent scores.
  External test egress was blocked. This does not prove live-provider extraction
  or real PDF/DOCX storage delivery.
- At 390×844 the phone navigation overlays rather than narrows the page.
  Close/Escape work, closed navigation is inert/hidden, and hidden links do not
  receive Tab focus. Document width remained within the viewport.
- Expanded desktop navigation remains the original `w-64`/`ml-64`: the app's
  existing 20px root typography renders these at 320px, not the tester's assumed
  256px. Collapsed navigation remains 72px. No root font size was changed.
- Final phone confirmation shows the full selected evidence-source label
  wrapping beneath the native select. The help launcher is now in the recruiter
  header, not over the screening warning. Its local menu opens without network
  requests. Closing that menu was not confirmed because the browser harness
  failed with `performance is not defined`; its existing dropdown close behavior
  was not changed. A 9px internal workflow-card overflow remains, while functional
  controls fit and the document has no horizontal overflow.
- The focused résumé tests and frontend typecheck passed; touched-file lint
  has no errors and one pre-existing unused import warning.
- The later available assisted-baseline log passed its API batches (431 and 58
  tests), frontend logic (50 tests), typecheck, build/guards and lint. Its final
  failure was formatting in the two newly written test/helper files; their
  subsequent whole-workspace formatting check passed. Do not label the entire failed
  workflow green or rerun the costly passed batches just to reconfirm formatting.

## Still to verify

- Live-provider résumé ingestion remains separate from substituted extraction
  acceptance.
- EnrichLayer account-capacity retest is deferred pending the user's update.
- This preparation check does not establish that all six autonomous stages have
  completed with live provider evidence.
