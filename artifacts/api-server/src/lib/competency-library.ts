/**
 * lib/competency-library.ts — Role-adaptive competency library
 *
 * A curated, code-owned catalogue of evaluation competencies. Each entry has a
 * stable `key` (persisted on candidate_evaluations.competency_keys), a
 * client-facing `label`, a plain-language `definition`, and `anchors` (what
 * strong vs. developing looks like) that ground the model's scoring.
 *
 * `selectCompetencies(roleFamily, seniority, domain)` deterministically picks a
 * role-appropriate subset (core professional competencies + family-specific +
 * seniority-specific). This is the DEFAULT set; recruiters override it per
 * evaluation (the whole point of "human-driven"), so the picker in the UI reads
 * `COMPETENCY_LIBRARY` to show every option.
 *
 * Deterministic by design — same inputs always yield the same set, so a
 * regenerate is reproducible and an evaluation never silently changes shape.
 */

export interface Competency {
  key: string;
  label: string;
  /** Plain-language description shown in the override picker + PDF glossary. */
  definition: string;
  /** Grounding anchors the synthesiser injects so scores mean the same thing. */
  anchors: { strong: string; developing: string };
  /** Broad grouping for the picker UI. */
  group:
    | "core"
    | "leadership"
    | "technical"
    | "commercial"
    | "product"
    | "analytical"
    | "operational"
    | "creative";
}

export const COMPETENCY_LIBRARY: Record<string, Competency> = {
  // ── Core (relevant to virtually every role) ────────────────────────────────
  communication: {
    key: "communication",
    label: "Communication & Clarity",
    definition:
      "Expresses ideas clearly, listens actively, and tailors the message to the audience.",
    anchors: {
      strong:
        "Structures answers logically, checks for understanding, and explains complex ideas simply.",
      developing: "Answers are vague, rambling, or leave key points unaddressed.",
    },
    group: "core",
  },
  problem_solving: {
    key: "problem_solving",
    label: "Problem Solving",
    definition:
      "Breaks down ambiguous problems, reasons through trade-offs, and reaches sound conclusions.",
    anchors: {
      strong: "Decomposes the problem, states assumptions, and weighs options before deciding.",
      developing: "Jumps to a solution without exploring the problem or alternatives.",
    },
    group: "core",
  },
  ownership: {
    key: "ownership",
    label: "Ownership & Accountability",
    definition:
      "Takes responsibility for outcomes, follows through, and drives work to completion.",
    anchors: {
      strong: "Describes owning a result end-to-end, including setbacks and how they were handled.",
      developing: "Frames outcomes as things that happened to them, with little personal agency.",
    },
    group: "core",
  },
  collaboration: {
    key: "collaboration",
    label: "Collaboration",
    definition: "Works effectively across people and teams, handling disagreement constructively.",
    anchors: {
      strong: "Gives concrete examples of aligning others and resolving cross-team friction.",
      developing: "Describes working in isolation or attributes friction only to others.",
    },
    group: "core",
  },
  adaptability: {
    key: "adaptability",
    label: "Adaptability",
    definition:
      "Adjusts to changing priorities, learns quickly, and stays effective under uncertainty.",
    anchors: {
      strong: "Shows examples of changing course thoughtfully and learning from new information.",
      developing: "Resists change or struggles to operate without full certainty.",
    },
    group: "core",
  },

  // ── Leadership (senior / lead / executive) ─────────────────────────────────
  leadership: {
    key: "leadership",
    label: "Leadership & Influence",
    definition:
      "Motivates and directs others toward shared goals without relying solely on authority.",
    anchors: {
      strong: "Describes setting direction, earning buy-in, and lifting a team's performance.",
      developing: "Leadership examples are thin or centre on directive control only.",
    },
    group: "leadership",
  },
  strategic_thinking: {
    key: "strategic_thinking",
    label: "Strategic Thinking",
    definition:
      "Connects day-to-day work to longer-term goals and anticipates second-order effects.",
    anchors: {
      strong: "Links decisions to business outcomes and considers downstream consequences.",
      developing: "Stays purely tactical with little line of sight to the bigger picture.",
    },
    group: "leadership",
  },
  stakeholder_management: {
    key: "stakeholder_management",
    label: "Stakeholder Management",
    definition: "Aligns competing interests and communicates effectively with senior stakeholders.",
    anchors: {
      strong: "Navigates conflicting priorities and keeps stakeholders informed and aligned.",
      developing: "Struggles to manage upward or across competing agendas.",
    },
    group: "leadership",
  },
  people_development: {
    key: "people_development",
    label: "People Development",
    definition: "Coaches, mentors, and grows the capability of others.",
    anchors: {
      strong: "Gives specific examples of developing individuals and building team capability.",
      developing: "Little evidence of investing in others' growth.",
    },
    group: "leadership",
  },

  // ── Technical / engineering ────────────────────────────────────────────────
  technical_depth: {
    key: "technical_depth",
    label: "Technical Depth",
    definition: "Demonstrates strong, current command of the technical fundamentals of the role.",
    anchors: {
      strong: "Explains technical choices with precision and awareness of trade-offs.",
      developing: "Technical explanations are surface-level or contain notable gaps.",
    },
    group: "technical",
  },
  system_design: {
    key: "system_design",
    label: "System & Solution Design",
    definition: "Designs robust, scalable solutions and reasons about architecture trade-offs.",
    anchors: {
      strong: "Considers scale, failure modes, and maintainability in design choices.",
      developing: "Designs are incomplete or ignore key non-functional concerns.",
    },
    group: "technical",
  },
  code_quality: {
    key: "code_quality",
    label: "Craft & Quality",
    definition:
      "Produces high-quality, maintainable work with attention to correctness and detail.",
    anchors: {
      strong: "Values testing, readability, and correctness; catches edge cases.",
      developing: "Prioritises speed over quality or overlooks edge cases.",
    },
    group: "technical",
  },
  debugging: {
    key: "debugging",
    label: "Troubleshooting",
    definition: "Diagnoses and resolves problems methodically under real-world constraints.",
    anchors: {
      strong: "Isolates root causes systematically rather than guessing.",
      developing: "Approaches problems by trial and error with little structure.",
    },
    group: "technical",
  },

  // ── Commercial / GTM ───────────────────────────────────────────────────────
  commercial_acumen: {
    key: "commercial_acumen",
    label: "Commercial Acumen",
    definition: "Understands the business, value drivers, and how work translates to revenue.",
    anchors: {
      strong: "Connects activity to revenue, margin, or customer value.",
      developing: "Focuses on activity with little sense of commercial impact.",
    },
    group: "commercial",
  },
  negotiation: {
    key: "negotiation",
    label: "Negotiation & Closing",
    definition: "Guides conversations to mutually beneficial outcomes and closes effectively.",
    anchors: {
      strong: "Handles objections and drives to a clear, agreed outcome.",
      developing: "Avoids hard conversations or leaves outcomes ambiguous.",
    },
    group: "commercial",
  },
  pipeline_management: {
    key: "pipeline_management",
    label: "Pipeline & Territory Management",
    definition: "Builds and manages a healthy pipeline with disciplined prioritisation.",
    anchors: {
      strong: "Describes a repeatable, data-informed approach to managing pipeline.",
      developing: "Pipeline management is reactive or ad hoc.",
    },
    group: "commercial",
  },
  customer_empathy: {
    key: "customer_empathy",
    label: "Customer Empathy",
    definition: "Deeply understands customer needs and advocates for them.",
    anchors: {
      strong: "Grounds decisions in real customer understanding and outcomes.",
      developing: "Talks about the product/process more than the customer's needs.",
    },
    group: "commercial",
  },

  // ── Product ────────────────────────────────────────────────────────────────
  product_sense: {
    key: "product_sense",
    label: "Product Sense",
    definition: "Shows strong judgement about what to build and why it matters to users.",
    anchors: {
      strong: "Balances user value, feasibility, and business impact in decisions.",
      developing: "Product judgement is thin or driven by features over outcomes.",
    },
    group: "product",
  },
  prioritization: {
    key: "prioritization",
    label: "Prioritisation",
    definition: "Focuses effort on the highest-impact work and says no deliberately.",
    anchors: {
      strong: "Uses clear criteria to sequence work and defend trade-offs.",
      developing: "Treats everything as equally urgent or lacks a rationale.",
    },
    group: "product",
  },
  user_empathy: {
    key: "user_empathy",
    label: "User Empathy",
    definition: "Understands and designs for real user needs and behaviours.",
    anchors: {
      strong: "Demonstrates genuine insight into users and their context.",
      developing: "Assumes user needs rather than grounding them in evidence.",
    },
    group: "product",
  },

  // ── Analytical / data ──────────────────────────────────────────────────────
  analytical_rigor: {
    key: "analytical_rigor",
    label: "Analytical Rigour",
    definition: "Reasons quantitatively, questions data, and draws defensible conclusions.",
    anchors: {
      strong: "Interrogates assumptions and supports conclusions with evidence.",
      developing: "Draws conclusions loosely or without checking the data.",
    },
    group: "analytical",
  },
  data_fluency: {
    key: "data_fluency",
    label: "Data Fluency",
    definition: "Works confidently with data and communicates insight clearly.",
    anchors: {
      strong: "Turns data into clear, actionable insight for others.",
      developing: "Reports numbers without interpretation or context.",
    },
    group: "analytical",
  },

  // ── Operational ────────────────────────────────────────────────────────────
  execution_reliability: {
    key: "execution_reliability",
    label: "Execution & Reliability",
    definition: "Delivers consistently, on time, and to a dependable standard.",
    anchors: {
      strong: "Shows a track record of dependable, well-organised delivery.",
      developing: "Delivery is inconsistent or dependent on others chasing.",
    },
    group: "operational",
  },
  process_optimization: {
    key: "process_optimization",
    label: "Process & Efficiency",
    definition: "Improves how work gets done and removes friction for the team.",
    anchors: {
      strong: "Identifies and implements meaningful process improvements.",
      developing: "Accepts existing process without seeking improvement.",
    },
    group: "operational",
  },

  // ── Creative / design ──────────────────────────────────────────────────────
  design_craft: {
    key: "design_craft",
    label: "Design Craft",
    definition: "Produces high-quality, user-centred design work with strong fundamentals.",
    anchors: {
      strong: "Balances aesthetics, usability, and constraints with clear rationale.",
      developing: "Design choices lack rationale or ignore usability.",
    },
    group: "creative",
  },
};

const CORE_KEYS = ["communication", "problem_solving", "ownership"];
const GENERIC_EXTRA = ["collaboration", "adaptability", "execution_reliability"];

/** Family → the competencies that best characterise that kind of role. */
const FAMILY_KEYS: Record<string, string[]> = {
  engineering: ["technical_depth", "system_design", "code_quality", "debugging"],
  software: ["technical_depth", "system_design", "code_quality", "debugging"],
  data: ["analytical_rigor", "data_fluency", "technical_depth"],
  analytics: ["analytical_rigor", "data_fluency"],
  product: ["product_sense", "prioritization", "user_empathy"],
  design: ["design_craft", "user_empathy", "collaboration"],
  sales: ["commercial_acumen", "negotiation", "pipeline_management", "customer_empathy"],
  marketing: ["commercial_acumen", "analytical_rigor", "customer_empathy"],
  operations: ["execution_reliability", "process_optimization", "collaboration"],
  finance: ["analytical_rigor", "commercial_acumen", "execution_reliability"],
  customer_success: ["customer_empathy", "communication", "commercial_acumen"],
  support: ["customer_empathy", "communication", "execution_reliability"],
  hr: ["people_development", "communication", "collaboration"],
  general: [...GENERIC_EXTRA],
};

const LEADERSHIP_KEYS = ["leadership", "strategic_thinking", "stakeholder_management"];

const SENIOR_TOKENS = [
  "senior",
  "sr",
  "lead",
  "principal",
  "staff",
  "manager",
  "head",
  "director",
  "vp",
  "chief",
  "executive",
  "president",
];

/** Map a free-text role family / title fragment to a FAMILY_KEYS bucket. */
export function normalizeRoleFamily(roleFamily?: string | null, title?: string | null): string {
  const hay = `${roleFamily ?? ""} ${title ?? ""}`.toLowerCase();
  if (
    /\b(software|engineer|developer|programmer|devops|sre|backend|frontend|full[-\s]?stack)\b/.test(
      hay,
    )
  )
    return "engineering";
  if (/\b(data scientist|machine learning|ml|ai engineer|data engineer)\b/.test(hay)) return "data";
  if (/\b(data analyst|analytics|business intelligence|bi analyst)\b/.test(hay)) return "analytics";
  if (/\b(product manager|product owner|\bpm\b|product lead)\b/.test(hay)) return "product";
  if (/\b(designer|design|ux|ui)\b/.test(hay)) return "design";
  if (/\b(sales|account executive|\bae\b|business development|\bbdr\b|\bsdr\b)\b/.test(hay))
    return "sales";
  if (/\b(marketing|growth|demand gen|content|brand)\b/.test(hay)) return "marketing";
  if (/\b(operations|ops|logistics|supply chain|program manager)\b/.test(hay)) return "operations";
  if (/\b(finance|accounting|controller|fp&a|financial)\b/.test(hay)) return "finance";
  if (/\b(customer success|\bcsm\b|account manager)\b/.test(hay)) return "customer_success";
  if (/\b(support|help desk|service desk)\b/.test(hay)) return "support";
  if (/\b(recruit|talent|people|human resources|\bhr\b)\b/.test(hay)) return "hr";
  return "general";
}

function isSenior(seniority?: string | null, title?: string | null): boolean {
  const hay = `${seniority ?? ""} ${title ?? ""}`.toLowerCase();
  return SENIOR_TOKENS.some((t) => new RegExp(`\\b${t}\\b`).test(hay));
}

/**
 * Deterministically select a role-adaptive competency set. Returns library keys.
 * Order: core → family-specific → (leadership if senior) → generic top-up, capped.
 */
export function selectCompetencies(
  roleFamily?: string | null,
  seniority?: string | null,
  domain?: string | null,
  title?: string | null,
  max = 7,
): string[] {
  const family = normalizeRoleFamily(roleFamily, title);
  const senior = isSenior(seniority, title);

  const ordered: string[] = [];
  const push = (keys: string[]) => {
    for (const k of keys) {
      if (COMPETENCY_LIBRARY[k] && !ordered.includes(k)) ordered.push(k);
    }
  };

  push(CORE_KEYS);
  push(FAMILY_KEYS[family] ?? FAMILY_KEYS.general);
  if (senior) push(LEADERSHIP_KEYS);
  push(GENERIC_EXTRA); // top-up so we never fall short

  return ordered.slice(0, max);
}

/** Resolve keys → full competency objects, dropping any unknown key. */
export function resolveCompetencies(keys: string[]): Competency[] {
  return keys.map((k) => COMPETENCY_LIBRARY[k]).filter((c): c is Competency => !!c);
}
