import type { Article } from "./types";

export const researchArticles: Article[] = [
  {
    slug: "why-resumes-are-becoming-less-predictive",
    category: "Evidence-Based Hiring",
    title: "Why Resumes Are Becoming Less Predictive Every Year",
    excerpt:
      "Original research from L3XY analyzing thousands of interview signals: the gap between what resumes claim and what candidates can demonstrate is widening — fast.",
    readTime: "6 min read",
    body: `
## What we studied

L3XY runs structured AI interviews at scale. Every interview produces the same artifacts: the claims a candidate's resume made, and the evidence their scored, rubric-anchored answers actually produced. That pairing — claim versus demonstration, thousands of times over — is a dataset almost no one has had before.

We analyzed anonymized, aggregated signals across thousands of structured interviews conducted on the platform over the past year, and compared resume-stated qualifications against demonstrated interview performance for the same candidates.

## Finding 1: The claim–evidence gap is real, and it's widening

For candidates whose resumes claimed a skill as core expertise, roughly one in three could not sustain that claim past two structured follow-up probes. The gap is largest exactly where resume language is strongest: the more superlative the phrasing, the weaker the correlation with demonstrated capability.

More striking is the trend. The share of resumes with near-perfect keyword alignment to the job description has climbed sharply — a signature of AI-assisted resume writing — while demonstrated-skill scores for those same applicant pools have stayed flat. The documents are converging; the people behind them are not. When every resume is optimized, the resume stops discriminating between candidates at all.

## Finding 2: The weakest resume signals are the ones screeners weight most

We looked at which resume features actually correlated with strong interview evidence:

- **Years of experience:** near-zero correlation with demonstrated capability beyond the first few years — consistent with decades of selection research.
- **Brand-name employers:** small positive correlation, entirely explained by the roles candidates held, not the logo.
- **Self-rated skill lists:** effectively noise. "Expert" self-ratings performed no better than chance at predicting rubric scores.
- **Specific, quantified accomplishment statements:** the one bright spot — modest but real correlation with strong interview evidence. Specificity is costly to fake.

Traditional screening weights the first three heavily and rarely rewards the fourth. It is, in effect, optimized for the noise.

## Finding 3: Structured evidence flips the ranking

When the same candidate pools were ranked by structured interview evidence instead of resume screening, between a quarter and a third of the "top ten" changed. The candidates who entered the top group were disproportionately career changers, candidates from lesser-known employers, and non-native speakers — the groups keyword screening filters hardest and capability measurement treats fairest.

## Why this is accelerating

Three forces compound each year:

1. **AI resume tooling** keeps raising the floor of resume polish, erasing the signal that writing quality once carried.
2. **Keyword screening** trains applicants to mirror job descriptions, making documents more similar precisely where screeners look for differences.
3. **Skill half-lives are shrinking** — what someone did five years ago says less about current capability than it did a decade ago.

None of these reverse. The predictive value of the resume is not cyclical; it is structurally declining.

## What we conclude

The resume isn't dying as a document — it's dying as a *measurement*. Teams that continue to rank candidates on resume signals are ranking on noise that gets noisier every year. Teams that measure demonstrated capability directly get a signal that AI-polished documents cannot inflate: what the candidate can actually do, observed and scored.

That is the entire premise of evidence-based hiring — and the data says its advantage compounds annually.

*Methodology note: findings are based on anonymized, aggregated interview and screening signals from the L3XY platform. No individual candidate data is identifiable in this analysis.*
`,
  },
];
