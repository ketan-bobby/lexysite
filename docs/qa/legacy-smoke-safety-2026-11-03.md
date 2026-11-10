# Legacy mutating smoke safety

## Finding

The older release checklist instructed operators to run a mutating smoke against
an external API, and to copy a staff token from browser local storage. The script
had an implicit localhost target, accepted arbitrary external origins and followed
redirects. Its best-effort branches and absent admin session also mean exit zero
cannot establish all the listed hiring journeys.

## Correction

- Added an early guard before any request or synthetic identity generation.
- Require explicit mutation consent, an explicit loopback HTTP(S) URL, and
  exact normalized-origin confirmation.
- Refuse production runtimes, external hosts, embedded URL credentials, paths,
  queries and fragments. Do not echo supplied URL values in errors.
- Refuse fetch redirects so credentials/writes do not follow another location.
- Replace the production smoke recipe with evidence-based release checks and
  remove instructions to extract browser tokens.
- Add pure guard tests to the existing assisted baseline; the legacy mutating
  smoke itself is not added to automatic runs.

This affects the legacy operator script only, not app features, pilot access,
commercial settings, sourcing, interview configuration or provider permissions.
Local URL consent is not independent database verification. Operators must still
verify backing services and accept cleanup responsibility before opting in.
The script is not upgraded into a comprehensive or automatically cleaned fixture.

## Verification

`pnpm test:smoke-target-guard`: **10/10 passed**. Includes a real subprocess of
the legacy entrypoint pointed at an ephemeral local HTTP listener: it exited
with preflight refusal and the listener received **zero requests**. The
subprocess inherited no workspace secrets.

No actual mutating smoke, provider calls, database checks, email, production
access or service restart was performed. Focused lint, formatting and Node syntax
checks cover the new guard/tests; legacy script formatting debt is unchanged.
