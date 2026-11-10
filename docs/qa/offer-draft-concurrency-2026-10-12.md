# Controlled-offer draft concurrency

## Corrected behavior

The controlled-offer editor previously replaced a dirty local form when polling
returned a different saved offer/version. A human's unsaved letter and structured
terms could disappear without a choice or warning.

The editor now:

- Preserves dirty forms across remote version changes, replacement offers and
  the first remotely created offer.
- Shows the latest saved terms alongside a conflict warning.
- Blocks save, submit, approve, send and withdraw while the conflict is unresolved.
  The mutation handler also rejects an unresolved conflict.
- Allows an explicit choice to keep local edits for a new draft or discard them
  and load the latest saved offer. Neither choice itself performs a mutation.
- Still requires saving changed terms as a new version, invalidating approval,
  before approval or delivery can proceed.
- Immediately displays the successful mutation response instead of restoring
  older cached terms while waiting for a refetch.
- Resets editor state when switching job/workflow context so one candidate's
  local draft does not carry into another candidate's view.

The pure synchronization policy and conflict presentation are focused modules.
The ten new policy checks are included in future assisted-baseline runs.

## Verification

- Ten synchronization-policy checks: pass.
- Full frontend strict typecheck: pass.
- Changed-file ESLint and Prettier: pass.
- Nine baseline planner/sharding checks: pass.
- Frontend restarted once; Vite served normally and reconnected.
- One browser pass against the real editor in a development-only fixture: pass.

Browser cases included dirty v1 to remote v2, keeping edits and saving with the
latest workflow revision, explicit discard/load-latest, clean refresh, local
first-draft conflict, and switching candidate context. The simulated save used
the local terms and latest expected revision; the returned version appeared
immediately. Desktop and 390px conflict controls were verified; no horizontal
overflow was measured.

All fixture API requests were intercepted. Only synthetic reads and one simulated
`save_draft` POST were permitted. No approve/send POST or unallowlisted API call
was observed. The test did not sign into a real account or mutate database rows.
Server authorization evidence remains separate.

The initial intercepted test HTML lacked Vite's React-refresh preamble; the tester
corrected that test page without changing app code. A test request-listener setup
error was likewise corrected before continuing. No fixture-runtime errors
remained in the completed pass.

The later retained managed assisted-baseline receipt shows a successful broader
pass, including formatting; this does not erase the earlier formatting-only
failure or claim that every check was rerun after this frontend change. Current
changed-code verification is listed above.

## Unchanged boundaries

No models, providers, prompts, plan/pilot access, prices, email dispatch, offer
authorization, historical Linx records or provider integrations were changed.
Offer approval and delivery remain human-controlled, version/revision-bound
actions. This does not certify the live offer journey or multilingual grading.

## Separate next work

The expired/withdrawn fresh-draft gap identified here is now addressed. See
[offer replacement verification](offer-replacement-2026-10-12.md). The old offer
is not reopened or resent automatically.

The browser fixture is reusable, but its concurrency scenarios should also become
a repeatable browser regression check. The current baseline includes the pure
policy tests, not this entire browser pass.
