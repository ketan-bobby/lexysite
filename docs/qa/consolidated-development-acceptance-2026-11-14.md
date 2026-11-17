# Consolidated development acceptance — November 14, 2026

For the subsequent team handover, use the
[remaining acceptance checklist](../team-handoff/remaining-acceptance-2026-11-14.md).
Its execution sheet and the later campaign/HR-guide addenda do not alter the
historical run results recorded below.

## Purpose and boundaries

This run checks the current development build before IT handover. It does not
authorize production rollout, candidate contact or changes to a connected ATS.

- The assisted baseline uses isolated fixtures and a provider-egress guard.
- Browser acceptance uses the real routed frontend with intercepted synthetic
  API responses and synthetic staff identity, not an employer's credentials.
- No production migration, live offer, invitation or external stage update is
  part of this run.
- Models, prompts and provider routing are unchanged.

## Consolidated result

**Functional verification passed. The only quality failure was corrected and
its check passed on rerun.**

The assisted baseline ran from **18:38:58 to 18:58:06 UTC**:

| Area | Result |
| --- | --- |
| API regression | 1,373 tests passed, zero failed/skipped, across 147 files in 40 bounded batches |
| Frontend logic | 290 tests passed, zero failed/skipped |
| Baseline runner/planner | 78 tests passed |
| Provider-egress guard | Five tests passed |
| Database metadata | Recent, ATS, Zoho handoff and meeting-usage checks passed against the configured development connection |
| Automated browser groups | All 13 groups passed |
| Strict typechecks | API and frontend passed |
| API build and guards | Passed |
| ESLint | Zero errors; no new error allowances needed |
| Formatting | Initial run found three files; corrected formatting only, then repository-wide Prettier passed |
| Patch whitespace | `git diff --check` passed |

The raw baseline report correctly remains **65/66 checks passed** with its
original formatting failure; it was not rewritten to manufacture a green run.
The failed files were `outlook-calendar-transport.test.ts`,
`schedule-applications.test.ts` and `schedule-applications.ts`. Formatting and
redundant-parenthesis cleanup did not change behavior. Only the failed quality
check was rerun, using `pnpm exec prettier --check .`, which exited successfully.
Previously passing functional checks were not repeated.

The 13 browser groups cover meeting notes, controlled offers, session handoff,
all-device logout, Mail Holds, Zoho campaigns, Outlook panel invitations,
Google calendar readiness, Google invitations, Google operation recovery,
candidate Meet visibility, Google panels and staff calendar connections.
These are local fixture checks, not live provider receipts.

Separately, the targeted real-page browser pass below passed using synthetic
responses. No functional defect was found in the two targeted screens.

## Targeted browser acceptance checklist

| Check | Expected result | Status |
| --- | --- | --- |
| Canonical candidate names | First/last-name API rows appear in the scheduling picker | Passed |
| Legacy candidate names | Full-name rows remain selectable | Passed |
| Candidate and role search | The correct application is found by either display value | Passed |
| Failed candidate-list read | A visible retry action appears instead of a false empty list | Passed |
| Candidate-list retry | Options recover and the scheduling draft is preserved | Passed |
| Outlook sharing opt-in | Confirmed response changes the displayed choice to on | Passed |
| Outlook sharing reload | A fresh read shows the saved choice | Passed |
| Outlook sharing withdrawal | Confirmed response changes the choice to off | Passed |
| Uncertain sharing save | A visible warning and fresh status check appear; no automatic write retry | Passed |

These checks establish client behavior only. Intercepted authentication is not a
test of login/session authorization, and mocked sharing receipts are not proof
of live Microsoft consent or availability access.

Coordinator evidence: the real `/coordinator` route rendered with a synthetic
tenant-admin identity. Canonical and legacy rows appeared; name and role
searches filtered correctly; selecting the canonical row enabled submission,
but submission was never clicked. A failed read showed a retry alert and hid
rows. Retry restored both options while preserving the entered date, time,
interviewer and notes. All API requests were intercepted; zero non-GET requests
were made in this journey. Mocked unsupported shell requests returned 501 and
caused expected console noise. Nonblocking preexisting dialog-description and
HTML-nesting warnings were observed, not counted as failed interactions.

Sharing evidence: the real `/settings/calendar` route rendered from the same
synthetic identity. Opt-in and withdrawal showed the matching confirmed choice;
reload used the mocked saved state. Five rapid clicks during opt-in produced
one POST. Simulations covered 500 responses both before and after the synthetic
effect, a lost response after withdrawal, and a malformed successful write
receipt. Each uncertain attempt showed a warning, performed one status refetch
and issued no automatic write retry. Reload cleared the warning and displayed
the mocked current truth. This journey made seven mocked status GETs and six
mocked consent POSTs, with no other writes and nothing forwarded.

The pending button's disabled appearance was confirmed during withdrawal but
not cleanly sampled during opt-in. The single-write guard was confirmed. A
malformed status GET was not part of this browser pass; malformed write receipts
were exercised.

## One ordered IT handover checklist

### Implementation and local evidence

- [x] Record the consolidated assisted-baseline result above, including skipped
      checks, inherited quality allowances and any remaining failures.
- [x] Record the focused browser evidence above.
- [x] Link this report with the
      [November 14 hardening addendum](independent-ats-checks-2026-11-14.md).
- [ ] Identify the code revision delivered to IT. The older ZIP is a dated
      snapshot and does not identify edits made after its source manifest.

### External deployment — team-owned, not performed here

- [ ] Review local migration instructions and the target database. Never
      reapply every SQL file blindly or use schema push as a migration substitute.
- [ ] Confirm authentication migrations **0113 → 0114 → 0115** and coordinated
      API replacement requirements in the existing handover.
- [ ] Rebuild both the frontend and API. Candidate-name parsing and sharing UI
      fixes require the frontend; the minimal Outlook identity lookup fix
      requires the API. These recent fixes add no migration.
- [ ] Verify deployment origins, OAuth callbacks, cookies and signed webhook
      configuration against the externally hosted environment.
- [ ] Run the authorized LINX acceptance cases against the deployed build.

### Provider and product work still open

- [ ] **Zoho stages:** establish a trustworthy employer/application-specific
      transition contract and safe side effects before completing live dispatch.
      Catalogue/history metadata alone is not transition authorization.
- [ ] **Greenhouse offers:** complete the applicable connected handoff behavior
      with an authorized employer account. Local approval/export/manual receipt
      is not remote offer delivery or a completed provider integration.
- [ ] **Calendars and meetings:** accept real staff-owned calendar connections,
      approved visible slots, invitations, rescheduling/cancellation, meeting
      attendance and signed callbacks. Candidates must not receive whole calendars.
- [ ] **Recordings:** accept a real recording import/capture and verify the
      candidate's voice, retention and authorized download.
- [ ] **Business approval:** retain independent human work-order, assessment
      disclosure and offer approval. Automated test success does not replace them.

The provider work above is not silently counted as implemented just because
local fixtures pass. There is no claim of Noon feature parity, certified
compliance or production capacity.
