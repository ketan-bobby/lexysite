# Candidate data download UI — 2026-10-11

## Delivered

Candidate Settings (`/portal/settings`) now includes a **Your personal data**
card with **Download my data**. It uses the existing authenticated
`/portal/me/export` endpoint through the artifact-aware shared API helper.

- Progress state and synchronous request guard prevent duplicate requests.
- Separate download state never saves or changes profile/privacy forms.
- Errors are announced visibly; successful initiation tells the candidate to
  check browser downloads and store the personal file securely.
- HTML, error bodies, malformed/partial exports and mismatched payload identity
  cannot become downloaded files. Filename characters are sanitized.
- Navigation/unmount cancels the request. A 60-second timeout permits retry.
- Temporary links are removed and blob URLs revoked after browser consumption.

## Verification

- Five download-helper tests passed: real JSON preservation, failed responses,
  invalid/partial/identity-mismatched output, safe filename, browser link and
  object URL cleanup including blocked clicks.
- Full frontend typecheck exited zero.
- Changed-source lint: zero errors, two existing settings-page warnings.
- New files pass formatting; whitespace check passed.
- Web workflow restarted after changes and is running.
- One signed-in browser pass used a newly created synthetic candidate and
  normal candidate login. The actual API produced browser JSON downloads whose
  top-level/candidate identity matched that fixture. Success feedback appeared
  and retry remained usable.
- Intercepted-only delayed request confirmed disabled loading state and one
  request despite a second attempted click. Intercepted HTTP 500 produced a
  visible error, no browser download, and enabled retry. Restoring the real
  endpoint produced another correct JSON download.
- Desktop and 390px mobile screenshots show the card/button/status fitting
  without horizontal overflow. The tester removed only its exact new fixture
  rows and temporary session/download files.

The browser pass reported unrelated resource 403s; the actual export succeeded.
It also identified a shared floating Help control overlapping Save Changes on
mobile. That issue is separate from the new card.

## Limits and remaining work

Candidate erasure handlers, AI configuration, human offer controls, commercial
access, discovery/privacy writes and real Linx records were not changed.

At the original download verification, the broader assisted baseline was **not green**: an SES-metering coverage guard,
a notification-cap false positive in the score-band scanner, and existing
offer/ATS formatting remain unresolved. A run captured the new component/helper
before formatting edits; their final focused formatting check passed. This
feature's test command is registered separately but is not yet in the explicit
assisted web-test list. Separate release-check and mobile-access follow-ups
describe those remaining gaps; do not treat this feature verification as a
clean whole-project release certification.

### Subsequent release-check verification

The release-check corrections now pass the complete assisted baseline:
523 API tests across four batches, 55 frontend logic tests, 12 runner and
egress-guard tests, frontend typecheck, API build and guards, lint with zero
errors, and repository formatting with zero failures. The download tests are
now included in the assisted frontend test list.

The SES guard verifies each newly constructed client rather than an old cache
variable name. The notification badge uses a named display cap without changing
candidate scoring. AI settings, provider routing and real Linx data remain
unchanged. These results cover the assisted checks, not full API typecheck or
live-provider certification.
