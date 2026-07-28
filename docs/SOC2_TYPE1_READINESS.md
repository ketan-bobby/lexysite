# SOC 2 Type 1 Readiness — Lexy

**Last updated:** 16 May 2026
**Owner:** founder / eng-lead
**Target attestation date:** + 8 weeks from kickoff

## TL;DR

SOC 2 Type 1 is a point-in-time attestation by an independent CPA firm
that, on a specific date, Lexy had a set of security controls designed to
meet the Trust Services Criteria. It is the minimum security artefact
mid-market enterprise buyers require before signing.

Type 1 ≠ Type 2. Type 2 requires those controls to operate continuously
over a 3-12 month observation window and is the eventual goal, but Type 1
unblocks ~80 % of enterprise procurement gates and can be obtained in 6-8
weeks using a compliance-automation vendor (Vanta, Drata, Secureframe).

This document is the readiness checklist. Each control either points at
the file where it is already implemented, or names the gap to close.

## Scope

* **Trust Services Criteria:** **Security** (mandatory). Optionally add
  **Confidentiality** (recommended for an HR-tech product handling
  candidate PII). Skip Availability, Processing Integrity, Privacy for
  Type 1 — add in Type 2.
* **System boundary:** Lexy production environment (api-server, lexy
  recruiter app, candidate portal, Postgres at Neon, Resend for email,
  OpenAI / Anthropic for inference). Lexy marketing site (lexy-site) is
  out of scope.
* **In-scope personnel:** all employees and contractors with production
  access.

## Recommended vendor: Vanta vs Drata vs Secureframe

| | Vanta | Drata | Secureframe |
|---|---|---|---|
| Cost (Type 1, < 50 employees) | ~$14k/yr platform + ~$10k auditor | ~$12k + ~$10k | ~$10k + ~$10k |
| Time to readiness (typical) | 6-8 weeks | 6-8 weeks | 8-10 weeks |
| Auto-evidence integrations | Best (~300+) | Strong (~200) | Strong |
| Recommendation | **Pick if budget allows** | **Pick if cost-sensitive** | Skip for now |

Pick one in week 1; the choice is reversible but switching mid-engagement
costs ~2 weeks.

## Controls inventory (CC = Common Criteria)

### CC1 — Control environment
- [ ] **CC1.1** Code of conduct / employee handbook published. *Gap:
      need to write or buy template (Vanta provides one).*
- [ ] **CC1.2** Board / advisor oversight documented. *Gap: write
      one-pager naming founder + advisor accountability.*
- [x] **CC1.4** Background check policy. *Implement before first hire;
      document as N/A until then.*

### CC2 — Communication and information
- [x] **CC2.1** Internal security policy. *See `docs/PII_HANDLING.md`.*
- [ ] **CC2.2** External communication of security (security@ inbox,
      public security page). *Closing: see `/security` page on
      lexy-site.*
- [ ] **CC2.3** Incident response runbook. *Gap: one-page runbook
      naming on-call, breach criteria, customer notification template,
      72-hour GDPR clock procedure.*

### CC3 — Risk assessment
- [ ] **CC3.1** Annual risk assessment performed and documented. *Gap:
      threat-model the system; the `threat_modeling` skill output is a
      good starting point.*
- [ ] **CC3.2** Risk register maintained. *Gap: spreadsheet of top 10
      risks, owner, mitigation.*

### CC4 — Monitoring activities
- [ ] **CC4.1** Continuous control monitoring. *Vanta/Drata provides
      this automatically once connected to AWS / GitHub / Google
      Workspace / Neon.*

### CC5 — Control activities
- [x] **CC5.1** Logical access controls (RBAC). *See
      `lib/auth-token.ts`, `routes/tenants.ts`.*
- [x] **CC5.2** Change management via PR review. *GitHub PRs require
      review.*
- [ ] **CC5.3** Vendor management (subprocessor inventory). *Closing:
      see `legal/subprocessors.md`.*

### CC6 — Logical and physical access
- [x] **CC6.1** Authentication (Clerk + tokens). *See
      `.local/skills/clerk-auth/`.*
- [x] **CC6.2** Authorization (role-based). *See
      `routes/tenants.ts` requireRole.*
- [x] **CC6.3** User provisioning / deprovisioning policy. *Document
      Clerk-driven flow.*
- [ ] **CC6.6** Encryption in transit. *Document: TLS 1.3 enforced by
      Replit at the edge and by Neon for DB connections.*
- [x] **CC6.7** Encryption at rest. *Neon AES-256.*
- [ ] **CC6.8** Production access logging. *Closing: existing
      `audit_logs` table covers this; document the policy.*

### CC7 — System operations
- [ ] **CC7.1** Vulnerability management. *Gap: enable Dependabot or
      Renovate; document monthly review cadence.*
- [ ] **CC7.2** Anomaly detection. *Use Sentry alerts + Neon query
      stats; document.*
- [ ] **CC7.3** Incident response. *See CC2.3.*
- [x] **CC7.4** System backups. *Neon point-in-time recovery; document
      restore-drill cadence (quarterly).*

### CC8 — Change management
- [x] **CC8.1** PR review + CI checks. *Document the GitHub flow.*

### CC9 — Risk mitigation
- [ ] **CC9.1** Business continuity / DR plan. *Gap: 1-pager.*
- [ ] **CC9.2** Vendor risk review. *See CC5.3.*

### Confidentiality (C-series — optional)
- [x] **C1.1** Data classification (PII vs metadata). *See
      `docs/PII_HANDLING.md`.*
- [x] **C1.2** Disposal procedures. *Closing: see deletion-request
      flow + `docs/RUNBOOK_DATA_DELETION.md`.*

## Evidence collection plan

Vanta/Drata will auto-collect about 60 % of the evidence below once
connected. The remaining ~40 % is one-off documents / screenshots.

| Evidence | Source | Status |
|---|---|---|
| Org chart | Founder one-pager | [ ] |
| Employee acknowledgement of policies | Vanta workflow | [ ] |
| Background check records | Background-check vendor | [ ] |
| Access review (quarterly) | Vanta or manual spreadsheet | [ ] |
| Change-management evidence (PRs) | GitHub via Vanta | [ ] |
| Vulnerability scan results | GitHub Dependabot + manual SAST | [ ] |
| Encryption-at-rest attestation | Neon SOC 2 report | [x] |
| Encryption-in-transit attestation | Cloudflare + Replit attestations | [x] |
| Subprocessor inventory | `legal/subprocessors.md` | [x] |
| Backup restore drill log | Quarterly drill notes | [ ] |
| Incident response runbook | `docs/INCIDENT_RESPONSE.md` (to write) | [ ] |
| Risk register | Spreadsheet | [ ] |

## 8-week timeline

| Week | Milestone |
|---|---|
| 1 | Pick vendor; sign SOW with CPA auditor; connect Vanta to GitHub, Neon, Resend, Stripe |
| 2 | Write incident response, BCP, risk register; publish security and subprocessor pages (this work is now done) |
| 3 | Close CC1 / CC3 / CC7 gaps; configure Dependabot; perform first backup restore drill |
| 4 | Internal readiness review with Vanta auditor success manager |
| 5 | Auditor walkthrough; evidence package frozen |
| 6 | Auditor fieldwork |
| 7 | Auditor drafting |
| 8 | **Type 1 report issued** |

## Open questions for the founder

1. Will Lexy carry cyber-insurance? If yes, the policy must be named in the
   risk register.
2. Will background checks be required for engineering hires? Recommended
   yes.
3. Is there a separate production AWS account, or is everything on
   Replit's managed compute? If the latter, CC6.4 (physical security) is
   inherited from Replit's own SOC 2 — request their report.
