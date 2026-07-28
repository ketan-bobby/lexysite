# Lexy — Known Technical Debt & Backlog

> Engineering documentation set · Doc 9 of 9
> What is intentionally deferred, and **why**. Debt is fine when it's a conscious
> choice with a recorded reason — this document is that record. Each item:
> **What → Why deferred → Impact / when to pay it down.**

---

## A. Sourcing & enrichment

### A1. `AbortSignal` is not propagated into provider adapters
- **What.** `runProvider` enforces a per-kind timeout (discovery 20s / enrichment
  90s) so a hung provider can't block the sourcing fan-out — but on timeout it
  only *unblocks orchestration*; the in-flight network request keeps running until
  it finishes on its own.
- **Why deferred.** The timeout closed the user-visible bug (whole search hanging).
  Threading an `AbortSignal` through every adapter is a wider refactor with no
  additional *correctness* benefit today.
- **Impact / pay-down.** Wasted upstream work + a small window of orphaned
  sockets under heavy timeout rates. Pay down when adding more providers or when
  provider cost/latency metrics (Theme 2) show it matters.

### A2. Legacy availability flags in `/sourcing/search`
- **What.** `pdlAvailable` / `serpAvailable` / `enrichLayerAvailable` flags
  predate the adapter registry and **don't reflect config-based disabling**
  (`SOURCING_DISABLED_PROVIDERS`).
- **Why deferred.** They're cosmetic/legacy; the registry's `skipped` reasons are
  the real source of truth now.
- **Impact / pay-down.** Mildly misleading status. Remove/redefine in terms of
  `isProviderEnabled()` next time the search response shape is touched.

### A3. Enrichment seed URLs hardcoded to PDL + SERP
- **What.** The enrichment seeding step is wired to the pdl+serp pair rather than
  being generic over the provider registry.
- **Why deferred.** Those are the only enrichment providers today; generalizing
  before a second one exists is speculative.
- **Impact / pay-down.** Adding an enrichment provider requires touching seed
  logic, not just registering an adapter. Generalize when the 2nd enrichment
  provider lands (Roadmap Theme 5).

### A4. `/sourcing/search` auth-hardening TODO
> ⚠️ **Priority flag:** this sits low in the list but, because security ranks
> first (see Doc 4 Part D and Doc 6), it should be **scoped sooner than its
> placement suggests.** Do not read its position here as "low priority."
- **What.** A noted auth-hardening follow-up on the `POST /sourcing/search`
  route. To be precise about scope: the route is **already authenticated** — it
  is *not* in the `withTenantContext` bypass list, so every call requires a valid
  HMAC-verified bearer token and runs under a resolved tenant context, and the
  body is Zod-validated. This is a **hardening gap, not an open/unauthenticated
  endpoint.**
- **What's actually missing.** The follow-up is about **foreign-id
  authorization**: a caller supplies a `jobId` (and related ids), and those
  should be validated against `getAllowedTenantIds()` *before* the route links
  rows or fans the search out to external providers — the same standard applied
  elsewhere (see §C and the `tenant-scoped-foreign-ids` memory). Without it, the
  theoretical risk is a caller referencing an id outside their allowed tenant
  subtree on this specific route.
- **Impact if left.** Medium-bounded: exploitation requires an *already
  authenticated* user and is limited to cross-referencing ids within reach of the
  auth layer — not anonymous access — but it touches an external-spend, data-
  fan-out path, which is exactly where an authorization slip is most expensive.
- **Why deferred.** Tracked but not yet fully scoped; the surrounding tenant-
  gating standard (§C) already exists, so this is "apply the existing pattern to
  one more route," not net-new design.
- **Pay-down.** Add an explicit `getAllowedTenantIds()` check on every
  caller-supplied id at the top of the handler, mirroring `/sourcing/nl-search`
  and the §C tenant-gating standard; add a test that a foreign `jobId` is
  rejected with `403`.

---

## B. Observability

### B1. AI/sourcing observability is logs-only
- **What.** Provider skip/timeout/error rates and scoring fallbacks are emitted as
  structured logs but **not** persisted to a metrics table or alerted on. (STT is
  the exception — it already persists `stt_transcribe_events` and alerts.)
- **Why deferred.** Logs were enough while autonomy was low and volume modest.
- **Impact / pay-down.** As autopilot/auto-scoring expand, "read the logs" stops
  scaling — degradations go unnoticed. This is **Roadmap Theme 2**; promote the
  STT health pattern into a general AI-ops surface.

### B2. No health dashboard for the AI job queue / schedulers
- **What.** Queue depth/age/failure-rate and scheduler health aren't surfaced.
- **Why deferred.** The queue (`SKIP LOCKED`, DB dedupe) is robust enough that it
  hasn't needed eyes yet.
- **Impact / pay-down.** A stuck queue or wedged scheduler is currently invisible
  until downstream symptoms appear. Pair with B1.

---

## C. Tenant isolation hardening (ongoing discipline, not a one-time fix)

- **What.** RLS is a backstop; correct isolation still depends on every handler
  scoping with `getAllowedTenantIds`, gating foreign FKs, staff-allowlisting
  staff-only routes, and self-gating `WITH CHECK(true)` policies
  (`tps_insert`/push-to-client).
- **Why "deferred".** This isn't a single ticket — it's a standing requirement
  that each new route must satisfy. The risk is *regression*, not an open hole.
- **Impact / pay-down.** Highest-severity class of bug if missed. Keep it in code
  review's #1 slot (Doc 6 §5); consider a lint/test that flags un-gated
  caller-supplied FKs. *(See Doc 4 Part B and the memory topic files.)*

---

## D. Type system

### D1. ~300 pre-existing `tsc` errors
- **What.** `tsc` reports ~300 errors, mostly Express request-param typing noise.
- **Why deferred (intentional).** The build gate is **esbuild**, not `tsc`.
  Driving `tsc` to zero is a large, low-value typing project that doesn't affect
  shipped behavior.
- **Impact / pay-down.** Editor noise + reduced type signal in affected handlers.
  Pay down opportunistically (e.g. typed Express request helpers) — not a
  blocking project. *(memory: express-params-tsc-noise)*

### D2. `@workspace/db` must be rebuilt after schema changes
- **What.** After editing the Drizzle schema, `tsc` shows phantom "no exported
  member" until `@workspace/db` is rebuilt (`tsc -b`).
- **Why deferred.** Inherent to the project-references build setup.
- **Impact / pay-down.** A footgun for newcomers; documented in onboarding (Doc 3)
  and memory. Could be smoothed with a watch/prebuild step.
  *(memory: db-dist-typecheck)*

---

## E. Interview pipeline residuals

- **What.** Real-time interview reliability is much improved (pooling, admission,
  watchdog, mobile STT, typing fallback) but remains the most
  environment-sensitive surface — most incidents were "fine in dev, broke under
  concurrency / on a specific device."
- **Why deferred.** Each fix was reactive to an observed failure; full
  device/concurrency matrix coverage is open-ended.
- **Impact / pay-down.** Directly affects candidate conversion and brand. Tune
  pool sizing/admission from real metrics (depends on B1); broaden device
  coverage. *(Roadmap Theme 4.)*

---

## F. Documentation & knowledge

- **What.** The deep "why" lives across `.agents/memory/` topic files; this
  engineering doc set is the first consolidated, downloadable digest.
- **Why deferred (until now).** Knowledge was captured incrementally in memory as
  it was learned.
- **Impact / pay-down.** Keep this set in sync — when a memory topic and these
  docs disagree, the memory files and code are newer; update the docs.

---

## G. Pipeline board UI

### G1. No drag-and-drop stage moves on the Kanban board
- **What.** The pipeline board advances candidates via an explicit **Move-to-stage
  dropdown / Advance button**, not by dragging cards between columns. (The only
  drag handlers on the panel are the CSV/résumé **file-upload drop zone** — card
  DnD has never existed here.)
- **Why deferred (deliberate).** Given the board's stage gating — the no-email
  block and the verify→outreach gate — explicit menu moves are arguably the
  *better* fit than drag: a refused drop is a mystery, whereas a disabled menu
  option can state its reason. DnD is a nice-to-have, not a correctness need.
- **Impact / pay-down.** Purely ergonomic; power users may expect drag. **Revisit
  if user feedback asks for it; if built, gates must render as disabled-with-reason
  options, and the collapse-strip spring-open behavior comes with it** (a dragged
  card hovering a collapsed empty column should spring it open).

---

## How this list is maintained

- A deliberate deferral gets an entry here **with its reason** — not a silent
  shortcut.
- When a code review surfaces a non-severe finding, it lands here rather than
  blocking the change (Doc 6 §5).
- Items graduate to the **Roadmap** (Doc 7) when they become active themes; the
  cross-references above show where each is already heading.

> Note: two earlier follow-up tasks (referenced as #41/#42, around sourcing
> hardening) were **cancelled by the product owner** — their substance is captured
> in §A above so the reasoning isn't lost even though the tickets are closed.
