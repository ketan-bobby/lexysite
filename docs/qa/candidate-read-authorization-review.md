# Candidate-read authorization review

## Local findings and corrections

On 2026-11-02, isolated synthetic HTTP fixtures reproduced:

- A candidate could call the staff candidate-detail endpoint for a same-tenant
  candidate. The endpoint now requires a current database staff role before
  looking up the requested candidate ID.
- A suspended staff account could still read candidate detail. The candidate
  router's shared caller resolver now requires an active database account, also
  protecting its candidate-owned developmental reads.

The tests preserve active owner access to the private career profile and active
staff access to candidate detail. Staff and platform administrators do not gain
access to private developmental profiles or recordings.

## Bounded verification

`src/routes/candidate-development-firewall.test.ts` covers owner and staff
positive controls, candidate-directory rejection for existing/missing IDs,
current database role over a stale token role, suspended-account rejection,
anonymous rejection and uniform private-recording denial. HTTP tests use
synthetic records and the egress guard; they do not play recordings or contact
candidates.

The private career-profile/recording Class-B exceptions identify the reviewed
candidate-owner gate and its behavioral evidence.

## Candidate detail privacy follow-through

A subsequent synthetic test reproduced a known-ID privacy bypass: a
platform-pool candidate with an employer tenant ID could be returned by detail
even while discovery correctly hid that row. Pool and tenant are independent;
tenant authorization is not a privacy override.

Candidate detail now applies both canonical hard-exclusion and privacy filters
after tenant/recruiter authorization and before application counts or portal
activation reads. Filtered and missing records both return 404. This preserves
the existing tenant-scope policy; a candidate-database licence does not expand
detail access to foreign tenants.

Thirteen focused HTTP tests across `candidate-development-firewall.test.ts`
and `candidate-database-privacy-seal.test.ts` pass, including:

- An accessible same-tenant platform control, preventing all-empty false passes.
- Pause, hide-from-employer, blocked-domain, match-only, DNC, erasure and
  pending-profile denials on the known-ID detail route.
- A foreign-tenant record and a missing ID returning the same 404 response.
- Recruiter denial before assignment, access after assignment, denial for an
  unrelated candidate and immediate denial after assignment removal.
- Existing active-staff/owner positives and account/role/privacy negatives.

The detail activation-metadata Class-B exception is now verified: the profile
existence query is keyed only to the candidate that passed the preceding gates.
Seven other Class-B exceptions remain separate review work. This pass does not
claim that all candidate routes or all application data are fully audited.

## Candidate-connection insight review

The single-insight exception incorrectly described a recruiter/employer-facing
reader. Its only HTTP caller is the candidate-self-only endpoint. The existing
canonical portal resolver requires an active, non-erased candidate account and
an exact candidate-user link; the route checks the requested candidate ID
before reading the candidate/job pair.

Sixteen egress-guarded HTTP tests in
`candidate-connection-engine-auth.test.ts` pass, including exact owner/job and
peer positive controls, another candidate's job returning only the owner's
no-data state, foreign/missing candidate denial, all five staff roles rejected
even with a stale candidate-role token, and anonymous/suspended/erased denial.
The sibling all-insights baseline description was also corrected: it already
uses the same canonical resolver, rather than the historical local email join.

No runtime authorization or scoring changes were required for this review.
The suite is now included in the assisted release runner; API typecheck passes.
Six Class-B exceptions remain: five analytics reads and the job-create career
profile read, covered by the separately queued analytics and scoring reviews.

No production access, migration, provider configuration or LLM changes were made.
This is not a complete security audit or proof of production readiness.
