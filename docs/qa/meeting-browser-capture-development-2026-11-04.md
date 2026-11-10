# Browser meeting capture — development verification

## Implemented and development-verified

The candidate Meeting notes upload panel has an experimental local capture
component. It requires recording consent before device access, shared audio and
microphone, and explicit stop/preview/use/upload steps. No provider or server
contract changed. Browser reload warnings protect unsaved local selections.
The helper includes bounded duration/size, source-loss errors and cleanup.
Existing recording import remains independently available. This is not a meeting
bot or speaker diarization.

## Initial failure and investigation

- Eight helper unit tests initially passed, including size/duration failures,
  permission cancellation, explicit discard and track cleanup.
- Frontend type checking and changed-source lint initially passed.
- One testing-agent browser pass reached consent gating, missing shared-audio
  errors and active-recording upload suppression, but failed waiting for the
  stopped recording preview. Remaining UI checks were not reached.
- Targeted investigation established that the recorder returns an empty data
  event. Its mixed audio context advances very little despite elapsed wall time.
  State-only tests did not establish an actual functioning recording graph.
- Retaining graph nodes, a zero-gain output path and replacing synthetic
  oscillator inputs with Chromium's virtual media devices did not resolve it.
- The browser harness retains diagnostics and fails rather than manufacturing
  a successful file.

## Resolution and final evidence

- Isolated fresh-browser experiments compared the real helper with default
  output, a fixed sample rate, and a non-playing sink. Default output produced
  no recording; fixed sample rate alone could yield a short silent result.
  The non-playing sink yielded decodable audio with a real synthetic signal.
- The helper now creates/resumes its recording AudioContext during the initiating
  click and uses the non-playing sink. It retains graph nodes and connects sources
  only to the MediaStream recording destination, with no speaker output branch.
- The full actual-panel browser harness now passes **22/22 checks**, with default
  autoplay policy and Chromium virtual media devices. It decodes the captured
  blob using OfflineAudioContext, verifies duration above 0.5 seconds and nonzero
  samples, then verifies preview/no autoplay, release of sources, explicit
  use/upload/processing separation, consent, discard/context cleanup,
  authenticated download, delete confirmation, cached-data suppression on
  403/404, and no horizontal overflow at 390 pixels.
- Fixture setup explicitly refreshes the replaced synthetic note before testing
  later permission failures, rather than depending on a 30-second cache expiry.
  Embedded native audio-control data images are allowed locally; remote API
  traffic still fails interception. Fixture cleanup precedes bounded browser
  shutdown so failed runs do not strand a temporary TSX file.
- Capture helper and real-browser tests are required entries in the combined
  development gate, with a registration regression.
- Final focused verification passed 12 capture-helper tests, 10 release-manifest
  and batch-planning tests, frontend type checking, changed-source lint and
  repository-wide formatting. The 22-check browser result remains the completed
  UI verification for this fix; subsequent UI edits changed guidance copy only.

No real meeting, microphone, applicant, database, provider call, invitation or
production environment was used for these browser checks. Browser fixture media
is synthetic. Do not weaken the nonempty-preview assertion to make a gate green.

## Remaining boundaries

Browser capture is verified with synthetic media, not a real conference call.
Browser/device audio-sharing support varies. This provides local staff-initiated
source recording, not automatic meeting attendance or speaker identity.
The subsequent complete combined development gate passed **52/52 groups**,
including this browser harness. See
[the November 4 release verification](assisted-release-verification-2026-11-04.md).
That combined development result does not substitute for live-provider or
production acceptance.

Application-scoped Zoho stage writing remains separately blocked on the provider
contract described in `docs/zoho-stage-handoff.md`; public documentation rechecked
on 2026-11-04 did not establish a safe application-ID/allowed-transition contract.
