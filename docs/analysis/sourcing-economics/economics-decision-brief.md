# Lexy tier economics — preliminary sensitivity model

**Decision: do not commit to the proposed 100/500 profiles or new interview allowances yet.**
This is an assumption-led cost model, not verified profitability. No paid searches/model calls, billing edits, app changes or service restarts were performed.

Evidence captured: 2026-10-05 15:56:42.522894+00 from workspace/development, not production or invoices.
US active monthly catalog: Starter $299, Growth $799, Enterprise custom. Other countries differ; USD catalog prices include Starter $39 and Growth $99. Non-USD FX is deliberately unset.

## Known versus unknown
- No sourcing ledger/account-rate rows were returned; zero dispatched/settled sourcing operations. This does not mean overall vendor spend is zero.
- Recorded activity: 2 interview credit units; 3 completed interviews with usable timing averaging 30 wall-clock minutes. These may include fixtures and are not representative production utilization.
- 120 speech events (64 Whisper, 41 Sarvam, 15 none) do not retain billed audio minutes or USD costs.
- The main AI text helper does not retain complete token usage. Missing data is UNKNOWN, not $0.
- Discovery, speech, hosting, support, commitments and other reserves are editable hypothetical assumptions. GPT-4o token prices are dated public audit references, not verified private account rates.

## Internal economics table
Delivery margin includes modeled direct support/operations, before sales, R&D, general administration and income tax.

| Workload | Low margin | Base margin | High margin | Base monthly delivery costs |
|---|---:|---:|---:|---:|
| Starter proposed-use | 85.7% | 40.2% | -110.1% | $178.81 |
| Growth proposed-use | 78.8% | 4.6% | -243.0% | $762.07 |
| Starter independent-bucket stress | 64.8% | -52.8% | -537.1% | $456.76 |
| Growth independent-bucket stress | 39.9% | -169.3% | -1041.8% | $2,151.86 |

Proposed-use workload: Starter 100 profiles/20 interviews/100 standalone AI tasks/100 emails/5 recruiter intro-video renders; Growth 500/100/500/500/25 renders. The 20% interview conversion is assumed. A separate candidate learning/practice allocation is a placeholder, not a measured cost.
Independent-bucket stress uses 100/500 interviews, 1,000/5,000 ADDITIONAL standalone tasks and 500/2,500 emails. Actual AI credit overlap is unknown; reduce standalone quantities if they already include profile/interview tasks. This is not validated simultaneous entitlement enforcement.
Stress also assumes 20/100 intro-video renders. These are hypothetical cache misses, not one render per interview. Candidate learning is allocated by an unverified fixed provision. SMS and specialist checks still need additional explicit budgets if included.

## Conditional allowance tradeoffs at 75%
These are arithmetic under BASE placeholder costs, not launch recommendations. Core delivery reserves and pilot AI/email usage remain included.

| Tier | Interviews/month | Maximum profiles/month under assumptions | Status |
|---|---:|---:|---|
| starter | 0 | 22 | Conditional, not verified |
| starter | 5 | 0 | Core alone exceeds budget |
| starter | 10 | 0 | Core alone exceeds budget |
| starter | 20 | 0 | Core alone exceeds budget |
| starter | 100 | 0 | Core alone exceeds budget |
| growth | 0 | 42 | Conditional, not verified |
| growth | 10 | 0 | Core alone exceeds budget |
| growth | 25 | 0 | Core alone exceeds budget |
| growth | 100 | 0 | Core alone exceeds budget |
| growth | 500 | 0 | Core alone exceeds budget |

## Customer-facing tier table — draft, not for publication
| Capability | Starter | Growth | Enterprise |
|---|---|---|---|
| Monthly US base price | $299 | $799 | Custom contract |
| Included seats | 3 | 10 | Contracted size |
| Active work orders | 5 | 25 | Contracted capacity |
| Positioning | Small hiring team | Recruiting team / agency | Scale, governance and service |
| External sourcing | Monthly quantity pending cost validation | Larger monthly quantity pending cost validation | Contracted monthly volume |
| AI interviews | Future package quantity under review; existing terms unchanged | Future package quantity under review; existing terms unchanged | Contracted volume and duration |
| Core screening and reports | Included, with explicit usage scope | Included, with explicit usage scope | Custom workflow scope |
| Privacy / consent / fairness | Included | Included | Included |
| At the source limit | Existing candidates remain accessible; new discovery pauses | Existing candidates remain accessible; new discovery pauses | Contracted exhaustion policy |
| Extra spending | No automatic top-ups or surprise charges | No automatic top-ups or surprise charges | Explicit approval required |

## Next evidence required
1. Retain actual input/cached/output tokens and model/version for every relevant AI attempt, including retries; avoid raw prompts and candidate PII.
2. Capture speech duration/characters and provider billing units for STT/TTS, conversation and assessment; wall-clock session length is not sufficient.
3. Obtain account/invoice costs and allocate consumed versus unused vendor commitments, infrastructure and direct support. Reconcile already recorded activity without launching a paid test.
4. Recalculate by country and contract, test full utilization, then approve a bounded pilot separately. Do not silently alter existing prices, contracts or safeguards.

Workbook verified: 2003 cached, recalculating formulas; no external workbook links or macros. All calculated outputs remain unvalidated cost sensitivities.
