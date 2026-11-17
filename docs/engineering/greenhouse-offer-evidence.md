# Greenhouse permission evidence and approval reads

**Current integration:** the [controlled assembly](greenhouse-offer-assembly.md)
now connects claim-bound draft/approval operations and independent read-back.
It still requires real custody and independently verified employer-review loaders;
the default app does not obtain that authority from a connection or API key.

## Original evidence increment

The subsequent [configuration reader](greenhouse-offer-configuration.md) consumes
these proofs for scoped metadata reads; the expanded suite now has 75 tests.
It does not replace the independently verified custody/permission source.

The offer transport now requires scoped, credential-bound permission evidence,
not just `privateOfferReadVerified`/`offerCreateVerified` flags. It also supports
read-only Harvest approval-flow queries. The application does not import this
transport or obtain real credentials for it. No routes, schedulers, live financial
buttons, migrations, provider requests or messages were added.

### Permission evidence

`greenhouse-offer-evidence.ts` validates **server-held evidence** for the exact:

- Lexy tenant, actor, workflow and application/candidate/job binding;
- employer account and connection revision;
- credential fingerprint, matched by the transport to `offerDigest(token)`;
- confirmed employer, active identity and explicit scopes;
- observation/expiry window, valid for no more than 60 seconds.

For a subject-bearing Site Admin credential, the verified subject must match and
the advanced private-offer permission must be explicitly verified. A Site Admin
label or successful OAuth connection alone grants nothing here.

For a subject-less integration-user credential, explicitly reviewed integration
access is required instead. This case does not borrow a Site Admin's identity or
silently assume the integration user has access.

The evaluator separates:

| Capability | Required scopes, in addition to verified private access |
| --- | --- |
| Private offer read | `harvest:offers:list` |
| Approval-flow read | Above plus `harvest:approval_flows:list` |
| Draft creation | Both reads plus `harvest:offers:create` |

Missing, stale, foreign, inactive, ambiguous, wildcard-only or malformed evidence
grants nothing. Creation additionally retains the existing human decision,
designated submitter, exact financial review and claimed-attempt checks.
Read authority is evaluated again after response consumption.

**Important:** this module evaluates evidence; it does not discover Greenhouse
permissions, introspect a token, validate a JWT signature or verify an employer
account. A trusted custody resolver must independently obtain and bind those
facts to the actual credential. Neither this evidence nor the permit may be
constructed from client JSON. The resolver and real employer discovery remain
unimplemented; synthetic fixtures are not authorization evidence.

### Approval metadata

`readApprovalFlow(snapshot, "job" | "offer")` uses only fixed GET endpoints:

- `/v3/approval_flows?job_ids=...&approval_type=offer_job&per_page=2`
- `/v3/approval_flows?offer_ids=...&approval_type=offer_candidate&per_page=2`

The offer-level read requires an existing offer-chain ID. The reader rejects
foreign jobs/offers, job-opening flows, offer prototypes with no offer ID,
ambiguous/duplicate results, unsafe IDs, pagination and unsupported schemas.
It inherits the transport's ten-second maximum request deadline, byte limit,
sanitized errors and no-retry behavior. Each call has its own bound; two calls
are not represented as an atomic snapshot.

Interpretation distinguishes **unverified**, **not requested**, **pending**,
**approved** and **rejected**. In particular:

- An empty flow result is not an approval waiver.
- `pending` with `requested_by_id: null` means approvals have not been requested.
- A terminal state without a requesting user is treated as unverified.
- Job-level approval is not approval of the individual candidate's offer.
- Combined approval requires both correctly bound flows to be approved.
- Offer status `Created` never substitutes for approval-flow evidence.

No approval-request, approval-resolution, notification, send or financial-write
operation is triggered by reading or interpreting these states. The aggregate
flow state is the provider's documented computed status; this increment does not
fetch approver groups or reconstruct individual approver decisions.

### Remaining integration

Before any live financial path, implement real employer field/opening and approval
configuration discovery and trusted custody/authority resolution. Then assemble
the provider with fresh pre/post offer-chain reads, exact reviewed terms and
durable claims. Independently obtained job/offer reads must not be presented as
an atomic or version-fenced authorization. Unknown/waived approval configurations
need verified employer-specific handling, not inference from empty lists.

Requesting approval may notify employer approvers and must remain an explicit,
authorized human action. Candidate delivery is separate and is not implemented
by this reader. BUILD-02 remains Blocked.

## Verification

The existing egress-guarded command now passes **51 tests**:

```sh
pnpm --filter @workspace/api-server run test:greenhouse-offer-http
```

This includes the prior 29 transport/encoding tests plus 22 permission/approval
cases. API TypeScript checking and changed-source formatting also passed.
No browser, real-employer, deployment, production-capacity or live-delivery
acceptance is established by these checks.

## Official contract references

Checked on 2026-11-15:

- https://harvestdocs.greenhouse.io/reference/get_v3-offers
- https://harvestdocs.greenhouse.io/reference/post_v3-offers
- https://harvestdocs.greenhouse.io/reference/get_v3-approval-flows
- https://harvestdocs.greenhouse.io/reference/get_v3-approver-groups
- https://harvestdocs.greenhouse.io/reference/get_v3-approvers
