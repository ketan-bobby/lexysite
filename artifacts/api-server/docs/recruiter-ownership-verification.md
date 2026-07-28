# Recruiter Ownership-Ceiling — Verification Package

Verification-only companion to the ownership-ceiling enforcement (rows 1–16 + prep,
merged at checkpoint `19b3997`). **No enforcement code was weakened.** This document
records the audit evidence; the executable proof lives in the test files listed in §6.

Ceiling summary: a plain `recruiter` may only touch records tied to requisitions
**assigned** to them — a 2nd gate applied *after* tenant scope, fail-closed.
`recruiter_admin` is limited to assigned clients (`getDataScopeTenantIds`), not the
whole agency. Admin-class roles are governed by tenant/data-scope only.

---

## 1. Enforcement mechanisms (recap)

| Mechanism | Where | Behavior |
|---|---|---|
| `enforceOwnership({kinds})` middleware | by-id / action routes | 404 on non-owned (hides existence); returns TRUE for every non-recruiter; recruiter-only 2nd gate |
| `recruiterOwnsResource(user,{kind,value})` inline | routes with resolved/aliased ids | same semantics, called programmatically after tenant gate |
| `getRecruiterAssignedJobIds` intersect | LIST routes | recruiter result set intersected with assigned reqs (empty ⇒ empty) |
| `getDataScopeTenantIds` | tenant gate (all staff) | recruiter_admin → assigned clients; else subtree; platform_admin → null (all) |

`recruiterOwnsResource` / `enforceOwnership` return TRUE for non-recruiter roles by
design, so admin / recruiter_admin scope is enforced by the tenant/data-scope layer
that staff paths must apply **before** the ownership gate.

---

## 2. Two-recruiter disjoint sweep table (one route per converted file)

Coverage is now **executed end-to-end for every converted Tier-2 file.** The primary
harness (`recruiter-ownership-sweep.test.ts`, 40/40) runs the REAL route handlers over
HTTP on a bare Express app with two same-tenant recruiters holding **disjoint**
requisition assignments (recrX owns jobX, recrY owns jobY) plus a `tenant_admin` (a
non-recruiter) control. As recrX we hit recrY's resources (and vice-versa) across one
route per file and observe the peer denial; the admin control confirms the ceiling does
not change non-recruiter behavior. Two files (agents run/run-selection and candidates
parse-cvs) are executed in the companion `agent-parse-tenant-gate.test.ts` under the same
disjoint-recruiter model — marked `E(pg)` — because their seed pre-dates this sweep;
they are executed proof, just in a sibling harness, not code-trace.

**The peer-denial status is the one the real handler returns — reported verbatim, not
normalized.** Three distinct denial shapes are correct by design:
- **404** — `enforceOwnership` / `recruiterOwnsResource` read/action routes (existence
  hidden to prevent id enumeration).
- **403** — the explicit WRITE-access gates (`requireRequisitionWriteAccess`,
  `requireIcpWriteAccess`): the caller is a known-in-tenant recruiter being told the
  write is not theirs.
- **empty 200** — the payload-scoped governance LIST queue: a peer still gets a 200 but
  the queue is narrowed away from the other recruiter's items.

Evidence codes: `E` = executed in this sweep, `E(pg)` = executed in
`agent-parse-tenant-gate.test.ts`, `U` = ownership unit test (`ownership.test.ts`).

| # | File | Route swept | Owner | Peer | Admin | Evidence |
|---|---|---|---|---|---|---|
| 1 | intelligence.ts | `GET /intelligence/job/:jobId` | 200 | 404 | 200 | E + U |
| 2 | outreach.ts | `GET /outreach/messages/:id` (→ jobId) | 200 | 404 | 200 | E |
| 2b | outreach.ts | `GET /outreach/campaigns/:campaignId` | 200 | 404 | 200 | E |
| 2c | outreach.ts | `PATCH /outreach/step-messages/:id` (→ enrollment→campaign) | 200 | 404 | 200 | E |
| 3 | ai-messages.ts | `PATCH /ai-messages/:id` (→ generation.jobId) | 200 | 404 | 200 | E + U |
| 4 | verify.ts | `GET /verify/:candidateId` (enforceOwnership candidateId) | 200 | 404 | 200 | E + U |
| 5 | outcomes.ts | `GET /outcomes?applicationId=` (→ application.jobId) | 200 | 404 | 200 | E |
| 6 | interviews.ts | `GET /interviews/plans/:planId` (→ plan.jobId) | 200 | 404 | 200 | E |
| 7 | candidate-events.ts | `GET /candidates/:candidateId/events` (enforceOwnership candidateId) | 200 | 404 | 200 | E + U |
| 8 | invites.ts | `POST /invites/generate` (recruiterOwnsResource candidateId) | 200† | 404 | 200† | E + U |
| 9 | prep.ts (staff) | `GET /prep/sessions` (assigned-jobs filter) | own only | none | all | E |
| 9b | prep.ts (candidate self) | `POST /prep/answer` (owner check post-load) | self | 404 | n/a | E |
| 10 | agents.ts | `POST /agents/:agentId/run` (jobId+candidateId) | 202 | 404 | 202 | E(pg) |
| 10b | agents.ts | `POST /agents/run-selection` | 202 | 404 | 202 | E(pg) |
| 10c | agents.ts | `GET /agents/events/candidate/:candidateId` (candidate timeline) — `resolveAgentViewer` (AGENT_VIEW_ROLES staff gate) + ceiling | 200 | 404 | 200 | E + U |
| 10d | agents.ts | `GET /agents/proctoring/:sessionId` (→ session's candidateId) — `resolveAgentViewer` (AGENT_VIEW_ROLES staff gate) + ceiling | 200 | 404 | 200 | E + U |
| 11 | recruiter-avatar.ts | `GET /recruiter-avatar/video-jobs/:id` — tenant/data-scoped (`resolveStaff`), **NOT** req-ceilinged | in-scope staff ✓ | same-tenant peer ✓ (by design) | ✓ | E (gate: 401 / non-staff 403 / unknown 404) |
| 12 | candidates.ts | `POST /candidates/parse-cvs` (jobId) | 200 | 404 | 200 | E(pg) |
| 13 | conversation-drafts.ts | `POST /:id/reject` (→ recruiterOwnsDraft draft.jobId; same gate as `/:id/send`) | 200 | 404 | 200 | E |
| 14 | talent_match.ts | `POST /talent-match` write: `requireRequisitionWriteAccess` | 200 | **403** | 200 | E |
| 14a | sourcing.ts | `GET /sourcing/candidates` — tenant-wide READ (`SOURCED_POOL_VISIBILITY`) | all-in-tenant | all-in-tenant | all | E |
| 14b | sourcing.ts | `POST /sourcing/merge` (recruiter ceiling on primary + all duplicates) | 200 | 404 | 200 | E + U |
| 15 | icp.ts | `PATCH /jobs/:jobId/icp` write: `requireIcpWriteAccess` | 200 | **403** | 200 | E |
| 16 | governance.ts | `GET /applications/pending-human-review` (payload-scoped via `resolveQueueScope`) | sees appX | **empty 200** | sees appX | E |

Prep self-path (row 9b) is candidate-scoped, not recruiter-scoped: model is
`user.id → candidates.userId → candidate.id`; a cross-candidate answer resolves to 404
after load; unassigned recruiter → 404; owner and admin → 200.

† **Row 8 (invites) — owner/peer/admin all executed, email neutralized.** The
`recruiterOwnsResource(candidateId)` ceiling fires and 404s the peer BEFORE any side
effect. The owner/admin success path mints a portal user (`ensureCandidateUser`) and
then sends a magic-link email; on every call that would be a **live** SES send to the
fake `@t.test` addresses. The sweep therefore temporarily unsets the AWS credentials for
the duration of this one test, forcing `email.ts` down its `isEmailConfigured()===false`
SIMULATED-SEND branch (logs only, still returns ok) — `isEmailConfigured()` reads the
creds live from `process.env`, so this flips at call-time with no module reload, and the
creds are restored in `finally`. Owner-200 / peer-404 / admin-200 are thus all genuinely
executed with zero external side effects.

**Row 11 (recruiter-avatar) is the one converted file whose by-id route is NOT
requisition-ceilinged** — avatar renders are recruiter-authored assets scoped by
tenant/data-scope (`resolveStaff`), so a same-tenant peer recruiter legitimately
succeeds. The disjoint-recruiter denial test does not apply; instead the executed proof
covers the gate that *does* guard it (no-token → 401, non-staff candidate → 403,
unknown id → 404, all firing before the HeyGen poll). See §3.

---

## 3. Exemption list (named justifications)

Every opt-out references a named `OWNERSHIP_EXEMPTION` constant (`lib/ownership.ts`);
`exemptFromOwnership()` throws on an anonymous justification, and
`readScopeExemption(TALENT_REDISCOVERY)` documents read-wide sourcing.

| Constant | Justification | Applied at |
|---|---|---|
| `CANDIDATE_SELF_PATH` | candidate self-path gated by interview capability-token cookie or authId↔candidateId, not recruiter ownership | prep candidate self-path, interview cookie routes |
| `TALENT_REDISCOVERY_READ` / `TALENT_REDISCOVERY` | read-only talent rediscovery: agency-wide candidate discovery is intentional; **writes still require requisition assignment** | `sourcing.ts` (nl-search), `talent_match.ts` (L170, L321) |
| `SOURCED_POOL_VISIBILITY` | read-only sourced-pool visibility: the tenant's SHARED sourced candidate pool is browsable tenant/subtree-wide so a recruiter can find matches for their reqs; **writes (`/sourcing/merge`, source-onto-req) still require requisition assignment** | `sourcing.ts` `GET /sourcing/candidates` |
| `NO_OWNABLE_RESOURCE` | route carries no candidate/job/application/campaign id to own (list/create scoped by tenant only) | tenant-only list/create routes |
| `ADMIN_ONLY_ROUTE` | route already restricted to admin-class roles that bypass the recruiter ceiling by design | admin-gated routes |

**TALENT_REDISCOVERY is the deliberate read-wide exemption**: recruiters can *discover*
candidates agency-wide, but any write (source-onto-req, screen, ICP) is gated to an
assigned requisition. This asymmetry is intentional and is the one place read scope is
broader than write scope.

---

## 4. Old-guard-vs-middleware disagreement report (FLAG — not deleted)

Route files still calling the older agency-wide `getAllowedTenantIds` (vs. the
narrower `getDataScopeTenantIds` used by the ceiling). **Flagged, not changed** — per
the "keep code as-is" directive. Files inside rows 1–16 legitimately mix both (the old
helper is used in non-recruiter / already-admin-gated branches); files outside rows
1–16 are the class-audit backlog for a future scoping decision.

| File | `getAllowedTenantIds` count | In rows 1–16? | Disposition |
|---|---|---|---|
| interviews.ts | 18 | Yes (row 6 staff routes only) | mixed by design; candidate cookie routes must NOT use data-scope — **keep** |
| sourcing.ts | 2 | Yes (row 14) | read-wide via TALENT_REDISCOVERY — **keep** |
| governance.ts | 3 | Yes (row 16) | admin/view branches — **keep** |
| icp.ts | 1 (active, L145) | Yes (row 15) | non-recruiter branch — **keep** |
| candidates.ts | 0 active (comment/import only) | Yes (row 12) | already on `getDataScopeTenantIds` — no flag |
| jobs.ts | 7 | No | class-audit backlog — flag |
| users.ts / recruiter-admins.ts | 5 / 4 | No | staff-admin management surface — flag |
| dnc.ts / anti-ghost.ts / learning.ts | 4 / 2 / 3 | No | class-audit backlog — flag |
| recruiter-performance.ts | 2 | No | cohort derives from jobs.assigned_recruiter_id (see memory) — flag |
| storage.ts / applications.ts / analytics.ts | 1 each | No | class-audit backlog — flag |
| ai-workorder / ai-jobs / ai-documents / ai-brand / agent-runs | 1 each | No | class-audit backlog — flag |

No *contradiction* was found where an old guard would grant access the new ceiling
denies on the same route: the ceiling layers are always applied **after** the tenant
guard, so the two are complementary, never conflicting. The above are scope-breadth
flags (agency-wide vs. assigned-client), not security regressions.

---

## 5. Rows 14–16 confirmation (now executed)

The write-gate (403) and payload-scope (empty-200) denial shapes below were confirmed by
**code-trace** and are now additionally **executed** in the sweep (rows 14, 15, 16).

- **Row 14 — talent_match / sourcing.** Reads intentionally agency-wide via
  `readScopeExemption(TALENT_REDISCOVERY)`. Writes gated:
  `talent_match.ts` `requireRequisitionWriteAccess(res,user,job)` (L97, called L278/L370)
  — **executed**: `POST /talent-match` peer → **403** (owner/admin 200);
  `sourcing.ts` recruiter write gate `recruiterIsAssignedToJob` → 403 "not assigned to
  this requisition" (L206–216), after `getDataScopeTenantIds` tenant gate.
- **Row 14a/14b — sourced pool read vs. merge (ratified split).** `GET
  /sourcing/candidates` is a deliberate tenant/subtree-wide READ marked with
  `readScopeExemption(SOURCED_POOL_VISIBILITY)` — the sourced pool is the tenant's
  SHARED talent pool, so a plain recruiter browsing it is the feature, not a leak
  (proven **executed** in the sweep: both disjoint recruiters see the whole pool).
  `POST /sourcing/merge` is the corresponding WRITE and now carries the FULL
  recruiter ownership ceiling: `recruiterOwnsResource` is checked on the primary
  AND every duplicate candidateId (all are re-pointed), 404 on non-owned/unknown,
  admin bypass. Its tenant-scope gate also returns **404 (not 403)** on an
  out-of-scope primary so unknown and out-of-scope are indistinguishable (no
  cross-tenant existence probe). `POST /sourcing/ingest` was also de-hardcoded —
  the destination tenant is now resolved from the authenticated caller (was
  `tenantId:"acme"`).

- **Rows 10c/10d — agents.ts staff reads.** Both `GET
  /agents/events/candidate/:candidateId` and `GET /agents/proctoring/:sessionId`
  route through `resolveAgentViewer`, which enforces 401 (no token) + the
  `AGENT_VIEW_ROLES` staff allowlist BEFORE the tenant/ownership checks. The role
  gate is load-bearing: `recruiterOwnsResource` returns `true` for every
  non-recruiter role, so an in-tenant candidate/interviewer token would otherwise
  read staff data. After the role gate: 404 unknown/out-of-scope target
  (existence hidden) → 404 recruiter ceiling (proctoring resolves the ceiling via
  the session's `candidateId`). Regression-tested: candidate token → 403 on both.
- **Row 15 — ICP writes.** `ICP_WRITE_ADMIN_ROLES = {platform_admin, tenant_admin,
  recruiter_admin}` (L154); `requireIcpWriteAccess` (L162, called L188/L269) → 403
  "ICPs for unassigned requisitions can only be edited by an administrator" for a plain
  recruiter on an unassigned req — **executed**: `PATCH /jobs/:jobId/icp` peer → **403**
  (owner/admin 200; PATCH edits the latest ICP version in-place, no LLM).
- **Row 16 — governance queues.** `HUMAN_DECIDER_ROLES` (decide, L62/L147/L516) vs
  `QUEUE_VIEW_ROLES = HUMAN_DECIDER_ROLES ∪ {recruiter_admin}` (view, L75/L203/L437);
  `resolveQueueScope` (L84) returns `{jobIds: getRecruiterAssignedJobIds(user)}` for a
  plain recruiter so peers never see each other's items — **executed**: `GET
  /applications/pending-human-review` returns a 200 to the peer but the payload is
  scoped away from the owner's queued application (`appX`), which the owner and admin
  both see.

---

## 6. Test evidence

New:
- `src/routes/recruiter-ownership-sweep.test.ts` — **40/40** (extended from 28 to cover
  every remaining converted Tier-2 file end-to-end). Two disjoint same-tenant recruiters
  (recrX↔jobX, recrY↔jobY) + a `tenant_admin` control run the REAL handlers over HTTP.
  Coverage now includes, in addition to the original prep / outreach-alias / intelligence
  / agents-reads / sourcing cases:
  - **ai-messages** `PATCH /ai-messages/:id` — owner-200 / peer-404 / admin-200.
  - **verify** `GET /verify/:candidateId` — owner-200 / peer-404 / admin-200.
  - **outcomes** `GET /outcomes?applicationId=` — owner-200 / peer-404 / admin-200.
  - **interviews** `GET /interviews/plans/:planId` — owner-200 / peer-404 / admin-200.
  - **candidate-events** `GET /candidates/:candidateId/events` — owner-200 / peer-404 /
    admin-200.
  - **invites** `POST /invites/generate` — owner-200 / peer-404 / admin-200, with AWS
    creds temporarily unset so `email.ts` takes its simulated-send branch (no live SES
    invite email; see the row-8 † note in §2).
  - **recruiter-avatar** `GET /recruiter-avatar/video-jobs/:id` — tenant/data-scoped, not
    req-ceilinged: gate proven at 401 (no token) / 403 (candidate, non-staff) / 404
    (unknown id, before the HeyGen poll).
  - **conversation-drafts** `POST /:id/reject` — owner-200 / peer-404 / admin-200.
  - **talent-match** `POST /talent-match` — owner-200 / peer-**403** (write gate) /
    admin-200.
  - **icp** `PATCH /jobs/:jobId/icp` — owner-200 / peer-**403** (write gate) / admin-200.
  - **governance** `GET /applications/pending-human-review` — owner sees `appX` / peer
    gets an **empty 200** (scoped away) / admin sees `appX`.
- `src/routes/agent-parse-tenant-gate.test.ts` — 11/11 (fixed surgically: `jobA` now
  ASSIGNED to `recA` so the "legitimate caller" case satisfies the new assigned-req
  ceiling; the pre-ceiling seed made the recruiter under-privileged → false 404).

Existing suites green: ownership 25/25, recruiter-admin-permissions 28/28,
recruiter-admin-extended 14/14, recruiter-admin-intel-analytics-scoping 12/12,
recruiter-admins 18/18, agents-read-scoping 8/8, agent-write-role-gate 8/8.
