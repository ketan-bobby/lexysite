import type { Article } from "./types";
import { researchArticles } from "./articles-research";
import { evidenceArticles } from "./articles-evidence";
import { structuredArticles } from "./articles-structured";
import { aiArticles } from "./articles-ai";
import { candidateArticles } from "./articles-candidate";
import { enterpriseArticles } from "./articles-enterprise";
import { evidenceArticles2 } from "./articles-evidence2";
import { structuredArticles2 } from "./articles-structured2";
import { aiArticles2 } from "./articles-ai2";
import { intelligenceArticles } from "./articles-intelligence";
import { candidateArticles2 } from "./articles-candidate2";
import { enterpriseArticles2 } from "./articles-enterprise2";

export type { Article, DownloadAsset, ArticleFormat, ArticleLevel } from "./types";
import type { ArticleFormat, ArticleLevel, DownloadAsset } from "./types";

export const FORMAT_META: Record<ArticleFormat, { icon: string; label: string }> = {
  guide: { icon: "📘", label: "Guide" },
  research: { icon: "📊", label: "Research" },
  template: { icon: "🛠", label: "Template" },
  report: { icon: "📈", label: "Report" },
};

export const LEVEL_META: Record<ArticleLevel, { label: string; className: string }> = {
  beginner: {
    label: "Beginner",
    className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  },
  intermediate: {
    label: "Intermediate",
    className: "bg-primary/10 text-primary border-primary/20",
  },
  advanced: {
    label: "Advanced",
    className: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  },
};

const SLUG_LEVELS: Record<string, ArticleLevel> = {
  // Beginner — explainers, intros, and candidate-facing guides
  "why-resumes-are-a-weak-hiring-signal": "beginner",
  "resume-screening-is-broken": "beginner",
  "hiring-signals": "beginner",
  "interview-scorecards": "beginner",
  "ai-recruiting-explained": "beginner",
  "ai-interviews-explained": "beginner",
  "ai-interview-myths": "beginner",
  "ai-hiring-glossary": "beginner",
  "what-is-hiring-intelligence": "beginner",
  "career-readiness": "beginner",
  "interview-preparation": "beginner",
  "build-a-hiring-profile": "beginner",
  "resume-vs-profile": "beginner",
  "career-signals": "beginner",
  "interview-readiness": "beginner",
  "skills-validation-for-candidates": "beginner",
  "personal-hiring-profile": "beginner",
  "acing-ai-interviews": "beginner",
  "storytelling-in-interviews": "beginner",
  // Advanced — research, analytics, calibration, compliance, and governance
  "why-resumes-are-becoming-less-predictive": "advanced",
  "interview-validity-research": "advanced",
  "predictive-hiring": "advanced",
  "years-of-experience-vs-performance": "advanced",
  "evidence-based-hiring-framework": "advanced",
  "interview-calibration": "advanced",
  "ai-bias-in-hiring": "advanced",
  "ai-hiring-compliance": "advanced",
  "ai-hiring-laws": "advanced",
  "candidate-capability-mapping": "advanced",
  "interview-analytics": "advanced",
  "hiring-dashboards": "advanced",
  "quality-of-hire-measurement": "advanced",
  "hiring-funnel-metrics": "advanced",
  "hiring-consistency": "advanced",
  "global-hiring": "advanced",
  "hiring-governance": "advanced",
  "enterprise-hiring-analytics": "advanced",
  "hiring-process-audit": "advanced",
};

export const DOWNLOADS: Record<string, DownloadAsset> = {
  scorecard: {
    label: "Interview Scorecard",
    description: "Per-candidate scoring sheet with evidence fields and debrief rules.",
    file: "l3xy-interview-scorecard.pdf",
  },
  rubric: {
    label: "Interview Rubric",
    description: "Anchored 1–5 scoring scale with a worked example and writing rules.",
    file: "l3xy-interview-rubric.pdf",
  },
  competencyMatrix: {
    label: "Competency Matrix",
    description: "Define 4–6 observable competencies per role, with a filled example.",
    file: "l3xy-competency-matrix.pdf",
  },
  questionBank: {
    label: "Interview Question Bank",
    description: "24 behavioral and situational questions across 6 competencies, plus probes.",
    file: "l3xy-interview-question-bank.pdf",
  },
  evidenceChecklist: {
    label: "Hiring Evidence Checklist",
    description: "Run every hire — and every rejection — through the evidence standard.",
    file: "l3xy-hiring-evidence-checklist.pdf",
  },
  vendorChecklist: {
    label: "AI Vendor Evaluation Checklist",
    description:
      "The questions to ask any AI hiring vendor, and the red flags that end the meeting.",
    file: "l3xy-ai-vendor-evaluation-checklist.pdf",
  },
  storyBank: {
    label: "Story Bank Worksheet",
    description: "Prepare six interview-proof stories from your real experience.",
    file: "l3xy-story-bank-worksheet.pdf",
  },
  rollout: {
    label: "Structured Hiring Rollout Checklist",
    description: "A 30/60/90 plan for moving your organization to evidence-based hiring.",
    file: "l3xy-structured-hiring-rollout.pdf",
  },
};

const CATEGORY_DOWNLOADS: Record<string, string[]> = {
  "Evidence-Based Hiring": ["evidenceChecklist", "scorecard", "rubric"],
  "Structured Interviews": ["scorecard", "rubric", "competencyMatrix", "questionBank"],
  "AI Hiring": ["vendorChecklist", "evidenceChecklist"],
  "Hiring Intelligence": ["evidenceChecklist", "scorecard"],
  Candidate: ["storyBank"],
  Enterprise: ["rollout", "competencyMatrix", "evidenceChecklist"],
};

const SLUG_DOWNLOADS: Record<string, string[]> = {
  "structured-interview-guide": ["scorecard", "rubric", "competencyMatrix", "questionBank"],
  "structured-interview-template": ["questionBank", "rubric", "scorecard"],
  "interview-scorecards": ["scorecard", "rubric", "competencyMatrix"],
  "interview-evaluation-forms": ["scorecard", "rubric"],
  "interview-scoring-rubric": ["rubric", "scorecard", "questionBank"],
  "skills-based-hiring": ["competencyMatrix", "rollout", "evidenceChecklist"],
  "fair-hiring": ["rubric", "scorecard", "rollout"],
  "interview-preparation": ["storyBank", "questionBank"],
  "ai-interview-software": ["vendorChecklist"],
};

export const FEATURED_SLUG = "why-resumes-are-becoming-less-predictive";

const SLUG_FORMATS: Record<string, ArticleFormat> = {
  "why-resumes-are-becoming-less-predictive": "research",
  "structured-interview-template": "template",
  "interview-scorecards": "template",
  "interview-scoring-rubric": "template",
  "hiring-intelligence": "report",
  "hiring-consistency": "report",
  "interview-validity-research": "research",
  "years-of-experience-vs-performance": "research",
  "interview-analytics": "report",
  "hiring-dashboards": "report",
  "quality-of-hire-measurement": "report",
  "hiring-funnel-metrics": "report",
  "enterprise-hiring-analytics": "report",
  "candidate-comparison-matrix-guide": "template",
  "ai-hiring-glossary": "guide",
};

export const CLUSTERS: Record<string, string[]> = {
  "Evidence-Based Hiring": [
    "why-resumes-are-becoming-less-predictive",
    "why-resumes-are-a-weak-hiring-signal",
    "resume-screening-is-broken",
    "hiring-signals",
    "capability-vs-experience",
    "what-hiring-evidence-actually-looks-like",
    "hiring-intelligence",
  ],
  "Structured Interviews": [
    "structured-interview-guide",
    "structured-interview-template",
    "interview-scoring-rubric",
    "interview-scorecards",
    "interview-evaluation-forms",
  ],
  "AI Hiring": [
    "ai-recruiting-explained",
    "ai-interview-agents",
    "ai-candidate-evaluation",
    "ai-interview-software",
  ],
  "Candidate Success": ["career-readiness", "interview-preparation", "build-a-hiring-profile"],
  "Enterprise Hiring": [
    "hiring-consistency",
    "fair-hiring",
    "skills-based-hiring",
    "global-hiring",
  ],
  "Selection Science": [
    "interview-validity-research",
    "predictive-hiring",
    "work-samples-in-hiring",
    "years-of-experience-vs-performance",
    "degree-requirements-rethink",
    "reference-checks-evidence",
    "gut-feel-vs-data",
    "hiring-decision-frameworks",
    "evidence-based-hiring-framework",
  ],
  "Running Structured Interviews": [
    "interview-question-library",
    "competency-framework-guide",
    "interview-calibration",
    "behavioral-vs-situational-questions",
    "interview-debrief-guide",
    "panel-interviews-structure",
    "candidate-comparison-matrix-guide",
    "hiring-manager-playbook",
    "interviewer-training",
    "common-interviewer-biases",
  ],
  "Responsible AI Hiring": [
    "ai-interviews-explained",
    "responsible-ai-hiring",
    "ai-interview-myths",
    "ai-bias-in-hiring",
    "ai-hiring-compliance",
    "ai-hiring-laws",
    "ai-vs-human-interviews",
    "candidate-experience-ai-interviews",
    "ai-hiring-glossary",
  ],
  "Hiring Intelligence": [
    "what-is-hiring-intelligence",
    "verified-hiring-signals",
    "hiring-confidence-scores",
    "interview-analytics",
    "hiring-dashboards",
    "candidate-capability-mapping",
    "quality-of-hire-measurement",
    "hiring-funnel-metrics",
  ],
  "Candidate Playbook": [
    "resume-vs-profile",
    "career-signals",
    "interview-readiness",
    "skills-validation-for-candidates",
    "personal-hiring-profile",
    "acing-ai-interviews",
    "storytelling-in-interviews",
  ],
  "Enterprise Hiring Operations": [
    "volume-hiring",
    "campus-recruiting",
    "internal-mobility",
    "hiring-governance",
    "enterprise-hiring-analytics",
    "recruiter-productivity",
    "hiring-process-audit",
  ],
};

export function getCluster(slug: string): { name: string; slugs: string[] } | null {
  for (const [name, slugs] of Object.entries(CLUSTERS)) {
    if (slugs.includes(slug)) return { name, slugs };
  }
  return null;
}

export const articles: Article[] = [
  ...researchArticles,
  ...evidenceArticles,
  ...structuredArticles,
  ...aiArticles,
  ...candidateArticles,
  ...enterpriseArticles,
  ...evidenceArticles2,
  ...structuredArticles2,
  ...aiArticles2,
  ...intelligenceArticles,
  ...candidateArticles2,
  ...enterpriseArticles2,
].map((a) => ({
  ...a,
  downloads: a.downloads ?? SLUG_DOWNLOADS[a.slug] ?? CATEGORY_DOWNLOADS[a.category] ?? [],
  format: a.format ?? SLUG_FORMATS[a.slug] ?? "guide",
  level: a.level ?? SLUG_LEVELS[a.slug] ?? "intermediate",
}));

export const CATEGORIES = [
  "All",
  "Evidence-Based Hiring",
  "Structured Interviews",
  "AI Hiring",
  "Hiring Intelligence",
  "Candidate",
  "Enterprise",
] as const;

export function getArticle(slug: string): Article | undefined {
  return articles.find((a) => a.slug === slug);
}
