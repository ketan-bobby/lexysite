# Technical Memo: AI Interview Consent — Jurisdiction Capability (Current State)

**Prepared for:** Outside counsel
**Date:** July 7, 2026
**Scope:** Factual description of the Lexy platform's current consent/disclosure implementation. No legal conclusions or proposed consent language. All quoted text is verbatim from the running system.

---

## 1. Current state — what the candidate sees before consenting

There is **one fixed AI-interview disclosure, shown identically to every candidate everywhere**, defined in a single source file (`artifacts/api-server/src/lib/ai-consent.ts`) under version string **`ai-interview-2026-06`**. It is served to two consent surfaces (the logged-in candidate portal consent page, and the in-room consent gate on public interview links); both render the same structured object. Verbatim content:

**Intended use:**
> "Lexy will conduct a structured video / voice interview with you and produce a summary of your answers for the recruiting team. The recruiter, not Lexy, decides whether to advance you in the process."

**Model providers disclosed:** "OpenAI (GPT-4o family)", "Anthropic (Claude 3.5 Sonnet)"
**Decision maker disclosed as:** "human-in-the-loop"

**Evaluated traits (shown as a list):**
> - "Role-relevant skills and experience as expressed in your resume"
> - "Role-relevant skills and experience as expressed during the interview"
> - "Clarity and structure of your spoken answers"
> - "Demonstrated reasoning on the questions asked"

**Explicitly NOT evaluated (shown as a list):**
> - "Race, ethnicity, or national origin (beyond work authorisation, which you self-report)"
> - "Age, religion, sexual orientation"
> - "Disability, family or marital status"
> - "Gender identity"
> - "Accent, pitch, or speech characteristics as a proxy for ability"
> - "Facial expressions or any video-based personality inference"

**Candidate rights:**
> - "You may withdraw consent at any time from your candidate portal."
> - "You may request deletion of your interview recording and transcript within 30 days under the Illinois AIVI Act, or at any time under GDPR Article 17 / CCPA."
> - "You may request a copy of your data."

**Retention:**
> "Interview recordings are retained for the duration of the active hiring process plus 12 months for audit purposes, then deleted. Deletion requests are honored within statutory windows."

**Biometric section — identifiers collected:**
> - "A scan of your facial geometry and gaze / attention signals captured from your webcam during the proctored interview"
> - "A recording of your voice and a video recording of the interview session"

**Biometric purpose:**
> "These biometric identifiers and biometric information are collected only to (a) confirm that it is you taking the interview, (b) maintain interview integrity (proctoring), and (c) create a record of your interview for the recruiting team to review. They are NEVER used to infer personality, emotion, demographics, or any protected characteristic."

**Biometric retention schedule:**
> "Your biometric identifiers and biometric information are permanently destroyed when the initial purpose for collecting them has been satisfied — i.e. when the hiring process concludes — or within 1 year of your last interaction with Lexy, whichever occurs first, in accordance with the Illinois Biometric Information Privacy Act (740 ILCS 14). You may request earlier deletion at any time."

**No sale/sharing:**
> "Lexy does not sell, lease, trade, or otherwise profit from your biometric data, and does not disclose it to any third party without your consent or as required by law."

**Consent mechanics:** the candidate must affirm **two separate checkboxes** — the AI-interview disclosure and a separate biometric release — both required as literal `true` values by the server. The consent record stores: candidate ID, version string, a **full snapshot of the disclosure text as shown** (so the exact copy is reconstructable even after later edits), timestamp, user-agent, IP, the separate biometric affirmation, and a revocation timestamp if later withdrawn (rows are never deleted). English only; no translations exist.

**Storage/versioning:** text lives in code (one constant + one function), versioned by the string `ai-interview-2026-06`. Changing the copy requires a code deployment and a manual version bump; a bump forces all candidates to re-consent.

---

## 2. Does any jurisdiction variance exist today?

**For the AI-interview/biometric consent above: no.** One disclosure, one version, every candidate, every location.

**However, the platform already contains two OTHER consent/disclosure systems that DO vary by geography** (facts counsel should know exist):

**(a) Jurisdiction-aware pre-decision notices (separate from interview consent).** A governance layer classifies candidates/jobs into jurisdiction codes — `US-NY-NYC`, `US-CO`, `US-IL`, `EU` — from free-text location fields (`lib/governance/jurisdictions.ts`). It is deliberately over-inclusive: an empty/unknown location is treated as ALL four regulated jurisdictions; "New York" (state) is treated as NYC. A database table (`jurisdiction_disclosure_templates`) stores notice copy **keyed by (jurisdiction_code, language, template_key)** with template keys `aedt_notice`, `co_pre_decision`, `il_aivi`, `eu_ai_act` — currently seeded with placeholder copy the code comments say "Legal will edit." Candidates' acknowledgements of these notices are recorded append-only (exact template + policy version IDs, IP, UA; the table has database triggers preventing UPDATE/DELETE). This system serves *notices*; it is **not wired into the interview consent gate**.

**(b) Region-aware voluntary self-identification (demographics).** The self-ID flow already swaps disclosure copy by region: EU/UK tenants get GDPR Article 9 special-category explicit-consent text; US/CA/AU tenants get OFCCP-style "Voluntary Self-Identification" text. Region is derived from the **tenant's (employer's) configured region**, not the candidate's location. Versioned separately (`self-id-2026-05`), snapshotted on save.

---

## 3. Technical capability for variance — where a jurisdiction-keyed consent would plug in

- The consent text is rendered from a **single constant and a single function** (`CURRENT_AI_CONSENT_VERSION` / `getCurrentDisclosure()`), consumed by all consent surfaces and all enforcement gates. Replacing these with a jurisdiction-keyed lookup is a **localized change with moderate effort**: every surface would inherit the variant automatically.
- The **classifier already exists** (§2a) and could supply the jurisdiction key; its "unknown location → all regulated jurisdictions" posture would default unknown candidates to the strictest applicable variant.
- The **audit storage already supports variants**: the consent table snapshots the full disclosure as shown and records a free-form version string, so per-jurisdiction versions (e.g. `ai-interview-2026-06/US-IL`) would be self-documenting with no schema change.
- The **database-template pattern already exists** (§2a's jurisdiction/language-keyed table with placeholder copy awaiting legal edit) and could be extended or mirrored for interview consent if counsel wants copy editable without code deployments.
- What does NOT exist: any per-jurisdiction consent *logic* (e.g., differing checkbox requirements, cooling-off periods, guardian consent, or jurisdiction-specific revocation mechanics). Only the text-selection layer has precedent; behavioral differences would be new construction.

---

## 4. Is candidate location captured anywhere the system could key off?

Yes — several signals exist today, of varying reliability:

| Signal | Where | Nature |
|---|---|---|
| Self-reported location | `candidates.location` (free text, e.g. "Chicago, IL") | Optional; candidate- or recruiter-entered; the jurisdiction classifier (§2a) is built to parse exactly this field |
| Job location | `jobs.location` (free text) | Used by the classifier alongside candidate location |
| IP address at consent | Stored in the consent record's capture context | Recorded for audit; **not** currently geo-resolved to a jurisdiction |
| Phone number | `candidates.phone` (free text) | Country code not parsed or used for geography |
| Work-authorization country | `sponsorship_country` on candidates | Self-reported during interviews; indicates authorization target, not residence |
| Employer region | `tenants.region` | Configured per employer; already drives the self-ID copy variant (§2b) |

No geocoding/IP-geolocation service is integrated. The classifier's stated design position (in code comments): free-text heuristics are acceptable for compliance gating because it fails toward over-inclusion; a real geocoder would be added "when precision matters more."

---

## 5. Named regimes already referenced in the product's own code/notices (surface area only)

Factual inventory of regimes the system's disclosures, comments, or tables name today — listed for orientation, with no interpretation:

- **Illinois AIVI Act (820 ILCS 42)** — named in the disclosure's deletion-rights text and consent-table documentation
- **Illinois BIPA (740 ILCS 14)** — named verbatim in the biometric retention schedule shown to candidates
- **NYC Local Law 144 (§ 5-301)** — named in the notice system (§2a); `aedt_notice` template key seeded
- **Colorado SB24-205** — named in the notice system; `co_pre_decision` template key and `US-CO` policy seeded
- **EU AI Act (incl. Article 26(11))** — named in consent-table docs and notice system; `eu_ai_act` template key seeded
- **GDPR** — Article 17 (deletion) named in the candidate-rights text; Article 9 (special categories) drives the EU/UK self-ID copy
- **CCPA** — named in the candidate-rights deletion text
- **OFCCP voluntary self-identification** — drives the US/CA/AU self-ID copy and the decoupled demographics store (k-anonymized aggregates only, never joined to recruiter views)

---

## Summary for counsel

One fixed, English-only AI/biometric disclosure (version `ai-interview-2026-06`) is shown to all candidates globally, with full-text snapshot auditing and two-part affirmation. No jurisdiction branching exists in the interview consent flow today, but the platform already operates (i) a jurisdiction classifier over self-reported locations, (ii) a jurisdiction/language-keyed notice-template table awaiting legal copy, and (iii) a region-varied self-ID disclosure — so the technical pattern for per-jurisdiction consent text exists and the plug-in point is a single constant/function. Candidate location exists as free text plus consent-time IP (not geo-resolved); no geocoding is integrated. Behavioral (non-text) per-jurisdiction consent differences would be new construction.
