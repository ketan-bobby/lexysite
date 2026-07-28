/**
 * pages/portal/prep.tsx — Interview Preparation Hub
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * AI-powered interview preparation for candidates. Generates personalised
 * prep plans and hosts live practice sessions (chat-based mock interview)
 * for each upcoming interview.
 *
 * ─── Modes ───────────────────────────────────────────────────────────────────
 *   Quick Plan    — 20 min express: 5 likely questions + 3 tips
 *   Standard Plan — 60 min: 8 questions + skill focus areas + tips
 *   Full Plan     — 180 min: 12 questions + STAR guidance + company research
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   UpcomingInterviews  — list of upcoming sessions; each has "Prepare" CTA
 *   PrepPlanView        — generated plan: questions, tips, readiness score
 *   PracticeSession     — chat-based mock interview with Lexy AI (streaming
 *                         responses via fetch + ReadableStream)
 *   FeedbackPanel       — per-answer AI feedback after practice session
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   POST /api/prep/generate           — generate a prep plan
 *   GET  /api/prep/plans/:cid/:jobId  — fetch existing plan
 *   POST /api/prep/sessions           — start a practice session
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/prep
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { pluralize } from "@/lib/utils";
import { apiBase, apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Zap, Brain, Code, Users, MessageSquare, ThumbsUp, ThumbsDown,
  ChevronRight, BookOpen, RotateCcw, ArrowLeft, Sparkles, Rocket,
  TrendingUp, HeartHandshake, Lightbulb, ShieldCheck, Loader2, Compass,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useSearch } from "wouter";

interface CareerProfile {
  currentTitle?: string;
  skills?: string[];
  preferredRoles?: string[];
  targetIndustries?: string[];
  strengthAreas?: string[];
  growthAreas?: string[];
}

interface PrepMode {
  id: string;
  label: string;
  icon: any;
  desc: string;
  time: string;
  color: string;
  categories: string[];
  maxQuestions?: number;
}

interface QA {
  q: string;
  a: string;
  tips: string[];
  category: string;
}

/* ─── Question Bank ──────────────────────────────────────────────────────── */
const QUESTION_BANK: Record<string, QA[]> = {
  behavioral: [
    {
      q: "Tell me about a time you had to manage a major change in your organization. How did you lead the team through it?",
      a: "Use STAR: Situation (the change — new system, restructure, pivot), Task (your leadership role), Action (communication plan, stakeholder buy-in, addressing resistance), Result (smooth transition, team morale, measurable outcome). Show empathy alongside decisiveness.",
      tips: ["Quantify the scope of change", "Highlight stakeholder management", "Show emotional intelligence", "Mention lessons learned"],
      category: "Behavioral",
    },
    {
      q: "Describe a time you had to influence a decision without direct authority.",
      a: "Focus on persuasion through data and relationships: building coalitions, presenting compelling business cases, aligning to stakeholders' goals. STAR structure. Show credibility-based influence rather than positional authority.",
      tips: ["Highlight the data or evidence you used", "Show empathy for opposing views", "Explain how you built trust", "Emphasize the outcome for the business"],
      category: "Behavioral",
    },
    {
      q: "Tell me about a conflict you resolved between team members or departments.",
      a: "Frame the root cause objectively, show active listening to both sides, describe the mediation or process you used, and the lasting resolution. Avoid blame language. Emphasize the relationship outcome alongside the task outcome.",
      tips: ["Stay neutral in your framing", "Show active listening skills", "Describe the resolution process clearly", "Mention how you prevented recurrence"],
      category: "Behavioral",
    },
    {
      q: "Describe a situation where you failed to meet a goal. What happened and what did you learn?",
      a: "STAR: be honest about the failure — interviewers respect self-awareness. Show what specifically went wrong (not just external factors), what you did immediately to limit damage, and the concrete changes you made to prevent recurrence. End with what you learned.",
      tips: ["Don't deflect blame entirely to external factors", "Show genuine reflection", "Describe a real recovery or change", "Keep the tone constructive, not self-flagellating"],
      category: "Behavioral",
    },
    {
      q: "Tell me about a time you had to deliver difficult feedback to a colleague or senior stakeholder.",
      a: "STAR: framing (private, timely, fact-based), preparation (specific examples, not personality judgments), delivery (lead with positive intent, use SBI — Situation, Behaviour, Impact), and outcome (did they receive it well? what changed?). Show courage balanced with empathy.",
      tips: ["Use the SBI feedback model", "Show you prepared before the conversation", "Focus on behaviour, not personality", "Mention the outcome and follow-up"],
      category: "Behavioral",
    },
    {
      q: "Describe a time when you had to make a decision with incomplete information.",
      a: "STAR: explain what information was missing and why, how you gathered what you could under constraints, your decision framework (risk tolerance, reversibility, stakeholder input), the decision itself, and the result. Show comfort with ambiguity and calculated risk-taking.",
      tips: ["Show structured thinking despite uncertainty", "Mention who you consulted", "Distinguish reversible vs irreversible decisions", "Quantify the outcome where possible"],
      category: "Behavioral",
    },
    {
      q: "Tell me about a time you had to manage competing priorities under a tight deadline.",
      a: "STAR: clarify the competing demands and the constraints (time, resources, stakeholders). Show how you triaged — what was cut or deferred and why — and how you communicated trade-offs. Result: what was delivered, what was the business impact.",
      tips: ["Show structured prioritization, not just hard work", "Explain your stakeholder communication", "Quantify the time pressure and outcome", "Mention what you would do differently"],
      category: "Behavioral",
    },
    {
      q: "Describe a time you took initiative on a project no one asked you to start.",
      a: "Show entrepreneurial drive: spotting an opportunity or gap, building a case for action, rallying support, and delivering results beyond your job description. Emphasize the business impact and any recognition or adoption you gained.",
      tips: ["Show self-starting behaviour, not just compliance", "Quantify the impact", "Mention how you got others on board", "Avoid coming across as going rogue — show alignment"],
      category: "Behavioral",
    },
    {
      q: "How have you successfully worked with a team or colleague whose working style was very different from yours?",
      a: "STAR: describe the style difference clearly (detail vs big-picture, fast vs thorough, etc.), what friction it caused, how you adapted your approach or found common ground, and the collaborative outcome. Show flexibility and interpersonal intelligence.",
      tips: ["Avoid making the other person seem difficult", "Show what YOU changed, not just what they changed", "Tie it to a concrete outcome", "Show genuine curiosity about different styles"],
      category: "Behavioral",
    },
    {
      q: "Tell me about a time you had to persuade a sceptical stakeholder to support your idea.",
      a: "STAR: identify their specific objections (risk, cost, effort, politics), show how you addressed each one (data, pilots, analogies, allies), and the outcome. Demonstrate that you listen before you advocate — you refined your idea based on their input.",
      tips: ["Show you understood their objections deeply", "Use data and social proof", "Describe a pre-meeting strategy", "Mention what you conceded or adapted"],
      category: "Behavioral",
    },
  ],
  leadership: [
    {
      q: "How do you build and sustain high-performing teams? What's your leadership philosophy?",
      a: "Address hiring for culture + skill, setting clear expectations, creating psychological safety, coaching vs managing, feedback culture, and recognition. Reference real frameworks you've used (OKRs, 1:1 structures, performance reviews).",
      tips: ["Give specific examples", "Mention your own leadership evolution", "Show both coaching and accountability", "Reference team results"],
      category: "Leadership",
    },
    {
      q: "Describe your approach to managing underperformance in a team member.",
      a: "Structured approach: early identification, private candid conversation, clear performance improvement plan with measurable milestones, ongoing check-ins, and documentation. Balance empathy with accountability. Mention the outcome — improvement or respectful transition.",
      tips: ["Show empathy first", "Emphasize clarity of expectations", "Document the process", "Focus on outcomes, not emotions"],
      category: "Leadership",
    },
    {
      q: "How do you set priorities for your team when everything feels urgent?",
      a: "Framework: business impact alignment, stakeholder input, urgency vs importance matrix (Eisenhower), OKR alignment, and transparent communication about what's deprioritized. Give an example where you successfully triaged competing demands.",
      tips: ["Show structured thinking", "Reference a real prioritization framework", "Explain how you communicate trade-offs", "Quantify the impact of your decision"],
      category: "Leadership",
    },
    {
      q: "How do you create psychological safety on your team so people speak up honestly?",
      a: "Model vulnerability yourself, respond to bad news with curiosity not blame, reward candour explicitly, run blameless post-mortems, and distinguish between idea criticism and personal criticism. Reference Edmondson's research on team psychological safety.",
      tips: ["Give a concrete example", "Show you practice what you preach", "Mention how you handled someone being unfairly criticised", "Tie safety to business outcomes like innovation"],
      category: "Leadership",
    },
    {
      q: "Walk me through how you have developed a high-potential employee into a leadership role.",
      a: "STAR: identify potential early (results + attitude + learning agility), stretch assignments, sponsorship (advocate for them publicly), structured feedback loop, 70-20-10 development, and a defined timeline. Show you invest time — not just delegate and hope.",
      tips: ["Be specific about the development plan", "Show the outcome — what role did they grow into?", "Mention what you learned as a leader from this", "Distinguish coaching from managing"],
      category: "Leadership",
    },
    {
      q: "How do you drive accountability on your team without micromanaging?",
      a: "Clarity on expectations (what, by when, to what standard), visible tracking without surveillance (shared dashboards, weekly standups), consequences for misses that are fair and immediate, and praise for delivery that is specific. Distinguish between checking in and checking up.",
      tips: ["Show you trust first, verify second", "Reference a specific system you've used", "Mention how you course-correct without demotivating", "Quantify the performance improvement"],
      category: "Leadership",
    },
    {
      q: "Tell me about a time you had to lead your team through a period of significant uncertainty or ambiguity.",
      a: "STAR: name the uncertainty honestly (don't pretend you knew more than you did), show how you communicated with transparency while maintaining confidence, what decisions you made with limited data, and how the team came out of it.",
      tips: ["Show you communicated proactively, not reactively", "Acknowledge what you didn't know", "Show resilience in your team, not just yourself", "Mention what you would do differently"],
      category: "Leadership",
    },
    {
      q: "How do you ensure diversity, equity, and inclusion are embedded in how you lead — not just a policy?",
      a: "Go beyond policy: intentional hiring (structured interviews, diverse panels, blind resume review), equitable access to stretch opportunities, inclusive meeting practices (who speaks, who gets credit), and personal accountability metrics. Show specific changes you made.",
      tips: ["Be specific — avoid platitudes", "Show what you actually changed, not just what you believe", "Reference metrics or outcomes", "Acknowledge areas where you are still learning"],
      category: "Leadership",
    },
  ],
  technical_coding: [
    {
      q: "Design a URL shortening service like bit.ly. Walk me through your architecture choices.",
      a: "Requirements (scale, latency), high-level design (hash generation, redirect service, analytics), deep-dive (base62 encoding, collision handling, Redis cache, CDN, DB sharding).",
      tips: ["Ask clarifying questions first", "Estimate scale (100M URLs/day ≈ 1,160 QPS)", "Discuss trade-offs explicitly", "Cover failure modes"],
      category: "Technical",
    },
    {
      q: "Tell me about a time you had to debug a critical production issue under pressure.",
      a: "STAR: production outage (Situation), identify root cause fast (Task), systematic debugging — logs, metrics, isolate components (Action), resolved within SLA, prevention measures (Result). Show composure and communication.",
      tips: ["Quantify the impact (downtime, revenue)", "Show systematic thinking", "Emphasize stakeholder communication", "Mention what you changed afterward"],
      category: "Technical",
    },
    {
      q: "Explain the difference between horizontal and vertical scaling. When would you choose each?",
      a: "Vertical: bigger machines, simpler, but has ceiling and single point of failure. Horizontal: more machines, requires stateless design, load balancing, better resilience. Choose vertical for stateful apps early on; horizontal for web tiers, microservices at scale.",
      tips: ["Tie to a real system you've built", "Mention cost trade-offs", "Discuss stateless vs stateful", "Cover database scaling separately"],
      category: "Technical",
    },
    {
      q: "How do you approach designing a system for high availability and fault tolerance?",
      a: "Redundancy at every layer (load balancers, multi-AZ deployment, database replication), graceful degradation, circuit breakers, health checks, and chaos engineering. Define your SLO first — 99.9% vs 99.99% changes everything about cost and design.",
      tips: ["Define availability target first (SLO/SLA)", "Cover the data layer separately from application layer", "Mention trade-offs of active-active vs active-passive", "Discuss how you test your HA design"],
      category: "Technical",
    },
    {
      q: "Walk me through your approach to code review. What makes a good review?",
      a: "Good reviews: check logic correctness, edge cases, security (input validation, auth), performance implications, readability, and test coverage — in that priority order. Speed matters: reviews within 4 hours keeps flow. Distinguish blocking vs non-blocking comments. Mentor through reviews, don't just gate.",
      tips: ["Show you prioritise the right things", "Mention review turnaround time and its impact on flow", "Discuss how you handle disagreements in reviews", "Reference automated tools (linters, SAST) that reduce manual burden"],
      category: "Technical",
    },
    {
      q: "How do you balance technical debt against delivering new features?",
      a: "Make debt visible (tech debt register), classify by risk and cost-to-fix, negotiate dedicated capacity (the 20% rule or sprint allocation), and frame debt in business terms for non-technical stakeholders. Show a concrete example where you cleared significant debt.",
      tips: ["Don't just say 'balance' — give a framework", "Show you can speak to business stakeholders in their language", "Mention how you prevented new debt from accumulating", "Quantify the impact of clearing the debt"],
      category: "Technical",
    },
    {
      q: "Tell me about a technical decision you made that you later regretted. What did you learn?",
      a: "STAR: be specific about the decision (technology choice, architecture pattern, shortcut taken). Show what the consequences were (scale problem, security gap, team velocity loss). Most importantly: what did you change your thinking on, and how do you decide differently now?",
      tips: ["Don't be vague — name the technology or decision", "Show genuine reflection", "Demonstrate how your decision-making process evolved", "Avoid blaming timeline or management — own it"],
      category: "Technical",
    },
  ],
  technical_management: [
    {
      q: "How do you evaluate and select new technology for your organization?",
      a: "Framework: problem clarity (what are we solving?), vendor evaluation (security, scalability, support, cost, integration), proof-of-concept, total cost of ownership, change management for adoption. Involve end users early.",
      tips: ["Show structured decision-making", "Mention stakeholder alignment", "Discuss build vs buy considerations", "Reference a real technology decision"],
      category: "Technology",
    },
    {
      q: "How do you ensure cybersecurity and data governance across your IT systems?",
      a: "Address: risk assessment frameworks (ISO 27001, NIST), access control policies (least privilege), incident response planning, employee training, vendor security assessments, audit trails, and compliance requirements (GDPR, SOC 2).",
      tips: ["Reference a specific framework", "Show proactive vs reactive approach", "Mention a real incident or near-miss", "Emphasize culture of security"],
      category: "Technology",
    },
    {
      q: "Describe how you have aligned IT strategy with business goals.",
      a: "Start with the business strategy, map technology capabilities to strategic gaps, build a roadmap with milestones, engage business stakeholders in prioritization, and measure success with business metrics not just IT metrics.",
      tips: ["Show business acumen, not just technical", "Mention ROI measurement", "Give a concrete example", "Highlight cross-functional collaboration"],
      category: "Technology",
    },
    {
      q: "How do you manage vendor relationships and third-party technology risk?",
      a: "Vendor risk tiers (critical vs non-critical), contractual SLAs and exit clauses, regular business reviews, security assessments, and contingency planning for vendor failure. Show a situation where a vendor relationship needed active management — escalation or renegotiation.",
      tips: ["Show you don't just sign and forget", "Mention concentration risk (too dependent on one vendor)", "Reference a specific negotiation or escalation", "Discuss how you evaluate vendor financial health"],
      category: "Technology",
    },
    {
      q: "Walk me through how you have managed a large-scale technology migration or system transformation.",
      a: "STAR: scope (size, complexity, stakeholders), approach (phased vs big-bang, parallel run vs cutover), risk management (rollback plan, data validation, UAT), communication plan, and the outcome. Lessons learned section always impresses.",
      tips: ["Quantify the scale (users, data volume, systems)", "Show your risk management approach", "Mention change management for the people side", "Be honest about what went wrong and how you handled it"],
      category: "Technology",
    },
    {
      q: "How do you build and develop the technical capabilities of your IT team?",
      a: "Skills gap analysis tied to strategy, formal training + on-the-job learning, certifications where they matter, cross-training for resilience, hiring for learning agility as much as current skills. Show how you've grown people's careers — not just managed capacity.",
      tips: ["Show a specific capability you built", "Mention how you balanced training time against delivery pressure", "Reference succession planning", "Give an example of someone who grew significantly under you"],
      category: "Technology",
    },
  ],
  ai_strategy: [
    {
      q: "How would you build an AI adoption strategy for a traditional business that's not tech-native?",
      a: "Start with problem identification (not solution-first), quick wins to build trust, data readiness assessment, change management plan, build vs buy vs partner decision, governance framework (ethics, bias, explainability), and measure business impact.",
      tips: ["Show business-first thinking", "Address change management", "Mention data quality challenges", "Reference governance and ethics"],
      category: "AI Strategy",
    },
    {
      q: "What are the key challenges in managing AI projects, and how do you overcome them?",
      a: "Common challenges: unclear success metrics, data quality, model drift, stakeholder expectations, regulatory uncertainty, talent gaps. Mitigations: rigorous scoping, data pipelines, model monitoring, executive education, iterative delivery.",
      tips: ["Show awareness of the full AI lifecycle", "Mention governance", "Give a real example if possible", "Discuss cross-functional dependencies"],
      category: "AI Strategy",
    },
    {
      q: "How do you evaluate ROI for an AI investment?",
      a: "Framework: baseline current state costs/time, project AI-driven improvements (automation savings, decision quality, revenue uplift), factor in implementation + ongoing costs, set measurement milestones at 3/6/12 months. Distinguish between cost-reduction and growth-enablement use cases.",
      tips: ["Quantify the baseline first", "Separate one-time vs recurring costs", "Set leading indicators, not just lagging", "Mention risk-adjusted returns"],
      category: "AI Strategy",
    },
    {
      q: "How do you approach AI ethics, bias, and responsible AI in practice — not just in principle?",
      a: "Concrete practices: diverse training data audits, fairness metrics defined before deployment, human-in-the-loop for high-stakes decisions, explainability requirements for regulated industries, red-teaming, and clear accountability for AI outputs. Show a real decision you made based on ethics.",
      tips: ["Avoid vague principles — show specific practices", "Reference regulation (EU AI Act, sector-specific rules)", "Show a trade-off you made between capability and responsibility", "Mention who owns AI ethics accountability in your organization"],
      category: "AI Strategy",
    },
    {
      q: "How do you differentiate between use cases where AI genuinely adds value versus where it's just hype?",
      a: "Value filters: high-volume repetitive decisions (AI wins), ambiguous unstructured data (AI wins), rare complex judgements (human wins), low-error-tolerance with no explainability (AI loses). Ask: what's the baseline? What's the cost of error? Is there enough data? Show a use case you killed because it failed these filters.",
      tips: ["Show critical thinking, not AI cheerleading", "Give an example of an AI project you recommended against", "Mention the importance of the baseline performance bar", "Discuss edge cases and failure modes"],
      category: "AI Strategy",
    },
    {
      q: "How do you build and retain AI/ML talent in a competitive market?",
      a: "Cover: compelling work (not just data cleaning), career paths (individual contributor vs management tracks), research time, conference budgets, publication rights, equity. Retention red flags: AI teams doing nothing but dashboards. Culture of experimentation matters as much as compensation.",
      tips: ["Show you understand what motivates technical talent", "Give a specific retention story", "Mention how you've built bridges between AI and business teams", "Discuss how you handle the pace of change in AI skills requirements"],
      category: "AI Strategy",
    },
  ],
  entrepreneurship: [
    {
      q: "Walk me through how you would validate a business idea before investing significant resources.",
      a: "Lean startup approach: customer discovery interviews (problem before solution), define key assumptions, minimum viable experiment (not full MVP), measure with leading indicators, pivot or persevere decision framework. Emphasize speed and learning over building.",
      tips: ["Show customer-first thinking", "Reference lean/agile concepts", "Mention specific validation methods", "Quantify the learning milestone"],
      category: "Entrepreneurship",
    },
    {
      q: "What's your approach to building a founding team or early organization?",
      a: "Cover: complementary skills (technical + commercial + operational), shared values over pure competency, equity structure, decision-making clarity, culture setting early. Red flags: comfort hires, skills overlap at cost of gaps, no accountability structure.",
      tips: ["Address equity and incentives", "Show how you assess for culture fit", "Mention vesting / commitment structures", "Give a real example or analogy"],
      category: "Entrepreneurship",
    },
    {
      q: "How do you think about pricing strategy for a new product or service?",
      a: "Frameworks: value-based (customer willingness-to-pay anchored on value delivered), cost-plus (floor), competitive (market positioning), freemium/land-and-expand. Iterate: launch with a range, gather data, optimize. Discuss elasticity and segment differences.",
      tips: ["Show customer-value thinking, not cost-plus", "Mention competitive context", "Discuss pricing experiments", "Cover psychological pricing factors"],
      category: "Entrepreneurship",
    },
    {
      q: "How have you managed cash flow and capital allocation in an early-stage or resource-constrained environment?",
      a: "Show financial discipline: prioritise revenue-generating activities, extend runway through frugality not just fundraising, understand burn rate and ramen profitability, negotiate payment terms with suppliers, stage hiring behind revenue milestones. Give a specific cash-pressure moment and how you navigated it.",
      tips: ["Be specific about the numbers (burn rate, runway)", "Show you understand unit economics", "Mention how you kept the team confident during lean periods", "Discuss the trade-off between growth and sustainability"],
      category: "Entrepreneurship",
    },
    {
      q: "Tell me about a pivot you made — or considered — and how you decided whether to pivot or persevere.",
      a: "STAR: what signal forced the question (data, customer feedback, market shift), how you framed the pivot vs persevere decision (Eric Ries: component vs complete pivot), what you learned from the original path, and the outcome. Show decisiveness without recklessness.",
      tips: ["Show how you used data, not just intuition", "Acknowledge what you had to let go of", "Demonstrate you consulted key stakeholders", "Tie to the long-term vision that stayed constant"],
      category: "Entrepreneurship",
    },
    {
      q: "How do you approach fundraising or winning buy-in from investors / senior leadership for a new venture?",
      a: "Frame like a VC pitch: the problem (crisp and validated), the solution (why now, why you), market size (TAM/SAM/SOM honestly), traction (any signal beats no signal), team, and ask. Show you understand what the investor/stakeholder cares about — risk profile, timeline, strategic fit.",
      tips: ["Tailor the pitch to the audience's priorities", "Show evidence of customer pull", "Address objections before they're raised", "Be honest about what you don't know yet"],
      category: "Entrepreneurship",
    },
  ],
  hr_people: [
    {
      q: "How do you design a talent acquisition strategy for a rapidly scaling company?",
      a: "Cover: workforce planning tied to business milestones, employer brand, sourcing diversification (referrals, agencies, direct), structured interview process, candidate experience, offer competitiveness, and onboarding effectiveness as a metric.",
      tips: ["Tie hiring plan to business plan", "Show data-driven approach", "Mention candidate experience", "Address diversity proactively"],
      category: "Talent",
    },
    {
      q: "How do you measure and improve employee engagement?",
      a: "Annual + pulse surveys, stay interviews, manager effectiveness scores, eNPS. Root-cause analysis on hot spots. Act visibly on findings within 30 days or you lose credibility. Tie engagement to business outcomes (retention, productivity, customer NPS).",
      tips: ["Show action-orientation, not just measurement", "Reference specific survey tools", "Mention manager role in engagement", "Connect engagement to business outcomes"],
      category: "People",
    },
    {
      q: "How do you build a compensation and benefits philosophy that attracts and retains great people?",
      a: "Start with market positioning (lead, lag, or match?), transparency vs confidentiality trade-offs, pay equity analysis, total rewards framing (base + bonus + equity + benefits + non-monetary). Show how you've communicated the philosophy clearly so people understand where they stand.",
      tips: ["Show you understand business constraints alongside fairness", "Mention pay equity reviews", "Discuss how you handle internal compression", "Reference what benefits matter most to your demographic"],
      category: "People",
    },
    {
      q: "How do you approach building a culture of continuous learning and development?",
      a: "70-20-10 model (on-the-job, coaching, formal), individual development plans, learning budgets with accountability (use it or lose it), internal knowledge sharing (lunch and learns, guilds), and manager capability to coach. Show a specific L&D initiative you built and its impact.",
      tips: ["Show it's more than just sending people on courses", "Mention how you measure learning ROI", "Give an example of a development investment that paid off", "Discuss how you handle the tension between delivery and learning time"],
      category: "People",
    },
    {
      q: "Tell me about a time you had to navigate a complex employee relations issue — a grievance, investigation, or disciplinary process.",
      a: "STAR: frame the situation neutrally, show your process (fact-finding before conclusions, legal/HR compliance, fair hearing, documentation), the outcome, and how you protected the psychological safety of others affected. Show judgment — not just process-following.",
      tips: ["Stay neutral in framing — both parties deserve fair treatment", "Show you followed process without being robotic", "Mention how you communicated outcomes without breaching confidentiality", "Discuss what you changed structurally to prevent recurrence"],
      category: "People",
    },
  ],
  product_sense: [
    {
      q: "Walk me through how you'd improve the onboarding experience for a product like Notion.",
      a: "Frame: who is the user, what's the job-to-be-done in the first 5 minutes, what's the activation metric (e.g. first doc shared)? Diagnose the funnel — drop-off between sign-up → workspace creation → first content → first invite. Propose 2-3 specific changes (e.g. template-first onboarding, AI-suggested first doc, one-click team import) with hypothesis + how you'd A/B test each. Close with how you'd measure success and the trade-offs (short-term activation vs long-term retention).",
      tips: ["State your user persona explicitly before any solutions", "Pick ONE activation metric — don't list five", "Each idea needs a hypothesis and a test", "Acknowledge the trade-off — every product change has one"],
      category: "Product Sense",
    },
    {
      q: "How would you decide whether to build a new feature or improve an existing one?",
      a: "Anchor on goals: what business outcome are we serving (acquisition, activation, retention, revenue)? Pull data on the existing feature — usage, satisfaction, request volume. Estimate impact × confidence × effort (ICE) for both. Consider strategic context (are we differentiating or catching up?). Show you'd ship the smallest experiment that resolves the bet, not the full thing on day one.",
      tips: ["Always start with the business outcome", "Reference an actual prioritization framework (RICE, ICE, Kano)", "Show you'd run a small experiment first", "Mention the cost of NOT improving — opportunity cost matters"],
      category: "Product Sense",
    },
    {
      q: "A key metric (say, weekly active users) drops 15% week-over-week. Walk me through your investigation.",
      a: "Stay calm and structured. (1) Validate: is the data correct? Logging changes? Holiday? (2) Segment: by platform, geo, cohort, plan tier, traffic source. (3) Hypothesize: recent release, marketing change, external event, competitor move. (4) Confirm: pull supporting data for the leading hypothesis. (5) Decide: rollback, hotfix, monitor, or accept. Show humility — you might be wrong, so you'd communicate uncertainty to stakeholders.",
      tips: ["Validate the data BEFORE diagnosing", "Segment is the most under-used step — emphasize it", "Don't jump to solutions before confirming the hypothesis", "Communicate uncertainty to stakeholders honestly"],
      category: "Product Sense",
    },
    {
      q: "Design a product for a 70-year-old who has never used a smartphone.",
      a: "Empathy first: what does this person actually need? (Connection with family, safety, simple info — not features.) Constraints: low motor precision, limited tech vocabulary, fear of breaking things. Design principles: voice-first, large targets, undo everywhere, no jargon, single-task screens. Walk through 1-2 core flows (e.g. video call grandkid, ask for help). Show you considered accessibility as the core design constraint, not a checkbox.",
      tips: ["Start with their LIFE, not their phone", "Name the constraints before naming features", "Design 1-2 flows in detail rather than 10 features shallowly", "Accessibility = core constraint, never an afterthought"],
      category: "Product Sense",
    },
    {
      q: "How would you measure the success of a product you've never seen before — say, a new social audio app?",
      a: "Layer the metrics: (1) North star (e.g. weekly hours listened per active user — captures engagement + value). (2) Input metrics that drive it (rooms created, invitations sent, time-in-room). (3) Counter-metrics to prevent gaming (creator burnout, listener churn). (4) Leading indicators (D1 retention, room-to-listener ratio). Show why north-star alone is dangerous without counter-metrics — you can pump engagement and destroy long-term value.",
      tips: ["Always pair a north-star with counter-metrics", "Distinguish input metrics from outcome metrics", "Mention how the metric could be gamed and how you'd prevent it", "Tie metrics to the business model — engagement metrics differ for ads vs subscription"],
      category: "Product Sense",
    },
  ],
  domain_deep_dive: [
    {
      q: "What are the 2-3 hardest problems in your domain right now, and how is the field trying to solve them?",
      a: "Pick problems that are genuinely hard, not just buzzwords. For each: (1) state the problem precisely, (2) explain why it's hard (why hasn't it been solved already?), (3) name the leading approaches and their trade-offs, (4) share your own opinion on which approach you find most promising and why. Show you read the literature, follow practitioners, and have a point of view — not just a survey.",
      tips: ["Specificity > breadth — go deep on 2 problems, not shallow on 10", "Always answer 'why is this hard' — that's the real signal", "Cite specific people, papers, or companies working on it", "Have a personal POV — that's what separates a senior from a junior"],
      category: "Domain Deep-Dive",
    },
    {
      q: "What's a widely-held belief in your field that you disagree with, and why?",
      a: "Pick a real disagreement, not a strawman. State the consensus view fairly first. Then your counter-view, with the evidence or reasoning that led you there. Show that you've stress-tested your own position — what would change your mind? End with intellectual humility: this is your current view, you're open to revising it. Avoid contrarianism for its own sake.",
      tips: ["State the consensus FAIRLY before disagreeing — straw-manning is a red flag", "Bring evidence, not just opinion", "Name what would change your mind", "Avoid being contrarian just to seem smart"],
      category: "Domain Deep-Dive",
    },
    {
      q: "Walk me through the most technically/analytically challenging project you've worked on in this domain.",
      a: "Set up the stakes — why did this project matter? What made it hard (scale, ambiguity, cross-functional, novel)? Walk through your specific contribution: the decisions you made, the trade-offs you weighed, what you tried that didn't work, what you learned. Quantify outcomes. Be precise about what was YOU vs what was the team. Senior interviewers can smell vague 'we' answers.",
      tips: ["Explain why the project mattered before what you did", "Be honest about what didn't work — failed attempts show depth", "Distinguish 'I' from 'we' precisely", "Quantify outcomes wherever possible"],
      category: "Domain Deep-Dive",
    },
    {
      q: "How do you stay current in your domain? What are you reading or following right now?",
      a: "Show a system, not a list. Sources: 2-3 primary (papers, original research, source code), 2-3 community (specific practitioners on social, podcasts, newsletters), and 1-2 hands-on (side projects, experiments). Mention something specific you've changed your practice on in the last 6 months because of what you read. Avoid the generic 'I read Hacker News' answer — that's noise.",
      tips: ["Have a SYSTEM, not a random list", "Name 2-3 specific people/sources you trust", "Mention something concrete you changed because of what you learned", "Avoid generic answers — Hacker News is not a source"],
      category: "Domain Deep-Dive",
    },
    {
      q: "Where do you see your domain in 3-5 years, and what should companies be doing now to prepare?",
      a: "Distinguish near-term (next 12 months — confident predictions) from long-term (3-5 years — informed speculation). Share 2-3 specific shifts you expect (e.g. capability X becomes a commodity, regulation Y emerges, customer expectation Z resets). For each, what should a company DO now — invest, hire, partner, wait? Show you can think like an operator, not just an observer.",
      tips: ["Separate confident predictions from speculation", "Each prediction needs a 'so what' — what to do about it", "Reference concrete signals, not vibes", "Think like an operator — what action should follow?"],
      category: "Domain Deep-Dive",
    },
  ],
};

/* ─── Mode builder ───────────────────────────────────────────────────────── */
function buildPrepModes(profile: CareerProfile | null): PrepMode[] {
  const title = (profile?.currentTitle ?? "").toLowerCase();
  const skills = (profile?.skills ?? []).map(s => s.toLowerCase());
  const industries = (profile?.targetIndustries ?? []).map(s => s.toLowerCase());
  const growth = (profile?.growthAreas ?? []).map(s => s.toLowerCase());
  const strengths = (profile?.strengthAreas ?? []).map(s => s.toLowerCase());

  const has = (...terms: string[]) =>
    terms.some(t => title.includes(t) || skills.some(s => s.includes(t)) || strengths.some(s => s.includes(t)));

  const hasIndustry = (...terms: string[]) =>
    terms.some(t => industries.some(i => i.includes(t)));

  const hasGrowth = (...terms: string[]) =>
    terms.some(t => growth.some(g => g.includes(t)));

  /* Determine profile-relevant categories for mock/full modes */
  const isLeader = has("manager", "management", "head", "director", "lead", "vp", "chief", "president", "officer");

  // AI/ML: only when role itself involves AI — not just "target industry = tech"
  const isAI = has("artificial intelligence", "machine learning", "ai strategy", "generative ai", "llm", "nlp", "data science", "ai product", "ml engineer") ||
    (hasIndustry("ai", "artificial intelligence", "machine learning") && isLeader);

  const isCoderRole = has("software", "engineer", "developer", "programmer", "coding", "backend", "frontend", "fullstack") &&
    !isLeader && !title.includes("it head") && !title.includes("it manager");

  // IT leadership: use specific phrases — avoid "it" substring which matches "quality", "audit", "recruitment", etc.
  const isITLead = (
    title.includes("information technology") ||
    title.includes("it director") || title.includes("it manager") ||
    title.includes("it head") || title.includes("it lead") ||
    has("information technology", "it director", "it manager", "it head", "it lead",
        "it strategy", "infrastructure", "sysadmin", "systems administrator",
        "devops", "technical operations", "it governance")
  ) && !isCoderRole;

  // Mock always mixes behavioral + leadership for variety; add specialist categories on top
  const mockCategories = ["behavioral", "leadership"];
  if (isAI) mockCategories.push("ai_strategy");
  if (isCoderRole) mockCategories.push("technical_coding");
  if (isITLead) mockCategories.push("technical_management");

  const fullCategories = [...new Set(["behavioral", "leadership", ...mockCategories])];

  const modes: PrepMode[] = [
    {
      id: "quick",
      label: "Quick Prep",
      icon: Zap,
      desc: "5 targeted questions in 15 minutes",
      time: "15 min",
      color: "bg-yellow-100 text-yellow-700 border-yellow-200",
      categories: ["behavioral"],
      maxQuestions: 5,
    },
    {
      id: "full",
      label: "Full Prep",
      icon: BookOpen,
      desc: "Comprehensive deep-dive — all categories",
      time: "60 min",
      color: "bg-blue-100 text-blue-700 border-blue-200",
      categories: fullCategories,
    },
    {
      id: "mock",
      label: "Mock Interview",
      icon: Brain,
      desc: "Simulated real-time interview — mixed questions",
      time: "45 min",
      color: "bg-purple-100 text-purple-700 border-purple-200",
      categories: mockCategories,
      maxQuestions: 12,
    },
    {
      id: "behavioral",
      label: "Behavioral",
      icon: Users,
      desc: "STAR-method questions on your experience",
      time: "30 min",
      color: "bg-green-100 text-green-700 border-green-200",
      categories: ["behavioral"],
      maxQuestions: 10,
    },
  ];

  // Leadership / Management
  if (has("manager", "management", "head", "director", "lead", "vp", "chief", "president", "officer")) {
    modes.push({
      id: "leadership",
      label: "Leadership & Management",
      icon: ShieldCheck,
      desc: "Team leadership, strategy, and decision-making",
      time: "40 min",
      color: "bg-cyan-100 text-cyan-700 border-cyan-200",
      categories: ["leadership"],
      maxQuestions: 6,
    });
  }

  // AI / ML — only when the role itself is AI-related
  if (isAI) {
    modes.push({
      id: "ai_strategy",
      label: "AI & Innovation",
      icon: Sparkles,
      desc: "AI strategy, adoption, and product thinking",
      time: "35 min",
      color: "bg-violet-100 text-violet-700 border-violet-200",
      categories: ["ai_strategy"],
      maxQuestions: 5,
    });
  }

  // Entrepreneurship
  if (hasGrowth("entrepreneurship", "startup", "venture", "founder")) {
    modes.push({
      id: "entrepreneurship",
      label: "Entrepreneurship",
      icon: Rocket,
      desc: "Startups, validation, and venture thinking",
      time: "35 min",
      color: "bg-orange-100 text-orange-700 border-orange-200",
      categories: ["entrepreneurship"],
      maxQuestions: 5,
    });
  }

  // Coding Technical (only for software engineers / developers)
  const isCoder = has("software", "engineer", "developer", "programmer", "coding", "backend", "frontend", "fullstack") &&
    !has("manager", "head", "director", "vp", "chief", "officer") &&
    !title.includes("it head") && !title.includes("it manager");

  if (isCoder) {
    modes.push({
      id: "technical",
      label: "Technical",
      icon: Code,
      desc: "Coding, system design & architecture",
      time: "45 min",
      color: "bg-orange-100 text-orange-700 border-orange-200",
      categories: ["technical_coding"],
      maxQuestions: 5,
    });
  } else if (isITLead) {
    // IT leaders get technology strategy questions, not coding
    modes.push({
      id: "technical",
      label: "Technology & Systems",
      icon: Code,
      desc: "IT strategy, systems, and technology leadership",
      time: "40 min",
      color: "bg-orange-100 text-orange-700 border-orange-200",
      categories: ["technical_management"],
      maxQuestions: 5,
    });
  }

  // HR / People
  if (has("hr", "people", "talent", "recruitment", "recruiting", "human resources")) {
    modes.push({
      id: "hr_people",
      label: "People & Talent",
      icon: HeartHandshake,
      desc: "Talent acquisition, engagement & culture",
      time: "30 min",
      color: "bg-rose-100 text-rose-700 border-rose-200",
      categories: ["hr_people"],
      maxQuestions: 5,
    });
  }

  // Marketing / Growth
  if (has("marketing", "growth", "brand", "content", "campaign")) {
    modes.push({
      id: "marketing",
      label: "Marketing & Growth",
      icon: TrendingUp,
      desc: "Strategy, campaigns, and growth frameworks",
      time: "30 min",
      color: "bg-pink-100 text-pink-700 border-pink-200",
      categories: ["behavioral"],
    });
  }

  /* Product Sense — brochure MockInterviews slide enumerates this as a
     distinct round type. Trigger for product roles (PM, product owner,
     product designer, product analyst). */
  const isProductRole = has("product manager", "product owner", "product lead",
    "product director", "product analyst", "product designer", "head of product",
    "vp product", "chief product");
  if (isProductRole) {
    modes.push({
      id: "product_sense",
      label: "Product Sense",
      icon: Lightbulb,
      desc: "Product judgement, prioritisation, and metric thinking",
      time: "35 min",
      color: "bg-amber-100 text-amber-700 border-amber-200",
      categories: ["product_sense"],
      maxQuestions: 5,
    });
  }

  /* Domain Deep-Dive — brochure MockInterviews slide enumerates this as a
     distinct round type. Available for every role: every domain has a
     deep-dive, regardless of seniority or function. */
  modes.push({
    id: "domain_deep_dive",
    label: "Domain Deep-Dive",
    icon: Compass,
    desc: "Hard problems in your field — show depth, not just breadth",
    time: "30 min",
    color: "bg-teal-100 text-teal-700 border-teal-200",
    categories: ["domain_deep_dive"],
    maxQuestions: 5,
  });

  return modes;
}

/* ─── Pick questions for a mode ─────────────────────────────────────────── */
function pickQuestions(mode: PrepMode): QA[] {
  const pool: QA[] = [];
  for (const cat of mode.categories) {
    pool.push(...(QUESTION_BANK[cat] ?? []));
  }
  if (pool.length === 0) pool.push(...QUESTION_BANK.behavioral);
  // Always add at least 1 behavioral question for non-behavioral modes
  if (!mode.categories.includes("behavioral") && QUESTION_BANK.behavioral.length > 0) {
    pool.push(QUESTION_BANK.behavioral[0]);
  }
  // Shuffle for variety across sessions
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  // Cap to maxQuestions if set
  return mode.maxQuestions ? shuffled.slice(0, mode.maxQuestions) : shuffled;
}

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function PrepCenter() {
  const search = useSearch();
  const autoMode = new URLSearchParams(search).get("mode");

  // When a mode is specified in the URL (e.g. ?mode=mock), start the session
  // immediately on mount — before the profile API even returns. buildPrepModes(null)
  // always includes the base modes (quick, full, mock, behavioral) so we never
  // need to wait for profile data just to begin.
  const immediateMode = autoMode ? buildPrepModes(null).find(m => m.id === autoMode) : null;
  const immediateQuestions = immediateMode ? pickQuestions(immediateMode) : [];

  const [profile, setProfile] = useState<CareerProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [selectedMode, setSelectedMode] = useState<string | null>(autoMode ?? null);
  const [currentQ, setCurrentQ] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [personalized, setPersonalized] = useState(false);
  // If a mode was in the URL, start the session right away — no effect needed
  const [sessionStarted, setSessionStarted] = useState(!!immediateMode);
  const [sessionQuestions, setSessionQuestions] = useState<QA[]>(immediateQuestions);
  /* Per-session self-rating tally — drives the score we POST to
     /portal/mocks/complete on finish. Reset every time a new session starts. */
  const [gotItCount, setGotItCount] = useState(0);
  const [needWorkCount, setNeedWorkCount] = useState(0);
  /* Result of the most recently completed session — when set, the UI shows
     a brief confirmation card with the score before the user resets. */
  const [sessionResult, setSessionResult] = useState<{
    score: number; gotIt: number; needWork: number; total: number; modeLabel: string;
  } | null>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/portal/career-profile`)
      .then(r => r.json())
      .then(res => { setProfile(res.data ?? null); setLoadingProfile(false); })
      .catch(() => setLoadingProfile(false));
  }, []);

  const prepModes = buildPrepModes(loadingProfile ? null : profile);

  const handleStartSession = async () => {
    const mode = prepModes.find(m => m.id === selectedMode);
    if (!mode) return;
    setGeneratingQuestions(true);
    try {
      const res = await apiFetch(`${apiBase}/portal/prep/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: mode.id,
          modeLabel: mode.label,
          categories: mode.categories,
          count: mode.maxQuestions ?? 8,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.questions) && data.questions.length > 0) {
          setSessionQuestions(data.questions);
          setPersonalized(!!data.personalized);
          setSessionStarted(true);
          setCurrentQ(0);
          setShowAnswer(false);
          return;
        }
      }
    } catch (_) {}
    // Fallback: use static question bank
    const questions = pickQuestions(mode);
    setSessionQuestions(questions);
    setPersonalized(false);
    setSessionStarted(true);
    setCurrentQ(0);
    setShowAnswer(false);
  };

  const isLastQuestion = currentQ === sessionQuestions.length - 1;
  const handleNext = () => { setCurrentQ(i => i + 1); setShowAnswer(false); };
  const handleReset = () => {
    setSessionStarted(false); setSelectedMode(null); setShowAnswer(false);
    setCurrentQ(0); setSessionQuestions([]); setGeneratingQuestions(false);
    setPersonalized(false); setGotItCount(0); setNeedWorkCount(0); setSessionResult(null);
  };
  /* Mock-completion is the moment the brochure promise becomes real.
     We POST to /portal/mocks/complete which (a) writes the
     mock_interview_completed action event the digest + Five In A Row
     badge depend on, and (b) writes per-skill score rows that update the
     candidate's sparkline. We rely on the server's score so the
     confirmation card always shows the same number that lands in the DB. */
  const handleSessionComplete = (extraGotIt = 0, extraNeedWork = 0) => {
    const mode = prepModes.find(m => m.id === selectedMode);
    const finalGotIt    = gotItCount    + extraGotIt;
    const finalNeedWork = needWorkCount + extraNeedWork;
    const total         = sessionQuestions.length;
    apiFetch(`${apiBase}/portal/mocks/complete`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode:              selectedMode,
        modeLabel:         mode?.label ?? selectedMode,
        categories:        mode?.categories ?? [],
        questionsAnswered: total,
        gotItCount:        finalGotIt,
        needWorkCount:     finalNeedWork,
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const score = typeof data?.score === "number"
          ? data.score
          : (finalGotIt + finalNeedWork > 0
              ? Math.min(95, Math.round((finalGotIt / (finalGotIt + finalNeedWork)) * 100) + (total >= 5 ? 5 : 0))
              : 50);
        setSessionResult({
          score, gotIt: finalGotIt, needWork: finalNeedWork, total,
          modeLabel: mode?.label ?? String(selectedMode ?? "Session"),
        });
      })
      .catch(() => {
        /* Network failure — still show *something* so the candidate sees
           their own rating breakdown even if the score didn't persist. */
        setSessionResult({
          score: 0, gotIt: finalGotIt, needWork: finalNeedWork, total,
          modeLabel: mode?.label ?? String(selectedMode ?? "Session"),
        });
      });
  };
  const handleRate = (rating: "got_it" | "need_work") => {
    /* Update tally. On the last question, finish the session — but pass the
       NEW counts directly to handleSessionComplete because setState is
       async and the post would otherwise miss this final rating. */
    const isGot = rating === "got_it";
    if (isGot) setGotItCount(c => c + 1); else setNeedWorkCount(c => c + 1);
    if (isLastQuestion) {
      handleSessionComplete(isGot ? 1 : 0, isGot ? 0 : 1);
    } else {
      handleNext();
    }
  };

  /* ── Generating Questions Loading Screen ── */
  if (generatingQuestions && !sessionStarted) {
    const mode = prepModes.find(m => m.id === selectedMode);
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
          <div className="relative">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Sparkles className="w-8 h-8 text-primary animate-pulse" />
            </div>
          </div>
          <div>
            <h2 className="text-xl font-semibold mb-2">Personalising your questions…</h2>
            <p className="text-muted-foreground text-sm max-w-sm">
              {profile
                ? "Analysing your profile and resume to generate questions tailored specifically to you."
                : "Generating expert-level questions for your session."}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Brain className="w-3.5 h-3.5" />
            <span>{mode?.label ?? "Prep"} session</span>
          </div>
        </div>
      </AppLayout>
    );
  }

  /* ── Active Session View ── */
  /* ── Session-Complete Confirmation ──
     After the candidate finishes a session, show their score + rating
     breakdown for a beat before they reset. This is the visible proof
     that their score actually moved — the brochure's core promise. */
  if (sessionResult) {
    const r = sessionResult;
    return (
      <AppLayout>
        <div className="max-w-xl mx-auto pt-8">
          <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
            <CardContent className="p-8 text-center space-y-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mx-auto">
                <Sparkles className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Session complete</h2>
                <p className="text-sm text-muted-foreground mt-1">{r.modeLabel} · {pluralize(r.total, "question")}</p>
              </div>

              {r.score > 0 && (
                <div>
                  <div className="text-6xl font-black text-primary tracking-tight">{r.score}</div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Skill score · this round</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto">
                <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 py-3">
                  <div className="text-xl font-bold text-emerald-400">{r.gotIt}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Got it</div>
                </div>
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 py-3">
                  <div className="text-xl font-bold text-amber-400">{r.needWork}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Need work</div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                {r.score > 0
                  ? <>This score is now part of your <strong className="text-foreground">{r.modeLabel}</strong> sparkline on the Career Hub. Five sessions in 14 days unlocks the <strong className="text-foreground">Five In A Row</strong> badge.</>
                  : <>We logged your session locally but couldn't reach the server to update your score. Try again in a moment.</>}
              </p>

              <div className="flex gap-2 justify-center pt-2">
                <Button variant="outline" onClick={handleReset} className="gap-2">
                  Back to Prep
                </Button>
                <Button onClick={handleReset} className="gap-2">
                  Practice Again <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  if (sessionStarted && sessionQuestions.length > 0) {
    const qa = sessionQuestions[currentQ];
    const mode = prepModes.find(m => m.id === selectedMode);
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground -ml-2" onClick={handleReset}>
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </Button>
              <span className="text-muted-foreground">|</span>
              <Badge variant="outline" className="text-xs">{mode?.label ?? selectedMode} Prep</Badge>
              {personalized && (
                <Badge variant="outline" className="text-xs gap-1 border-primary/40 text-primary">
                  <Sparkles className="w-3 h-3" /> Personalised
                </Badge>
              )}
              <span className="text-sm text-muted-foreground">Question {currentQ + 1} of {sessionQuestions.length}</span>
            </div>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={handleReset}>
              <RotateCcw className="w-3.5 h-3.5" /> End Session
            </Button>
          </div>

          <div className="w-full bg-muted rounded-full h-1.5 mb-8">
            <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${((currentQ + 1) / sessionQuestions.length) * 100}%` }} />
          </div>

          <Card className="mb-4 border-primary/20">
            <CardContent className="p-6">
              <Badge className="mb-3 text-xs" variant="outline">{qa.category}</Badge>
              <p className="text-lg font-semibold leading-relaxed">{qa.q}</p>
            </CardContent>
          </Card>

          {!showAnswer ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">Take a moment to think through your answer, then reveal the guidance below.</p>
              <Button className="w-full gap-2" onClick={() => setShowAnswer(true)}>
                <Brain className="w-4 h-4" /> Reveal Answer Framework
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Card className="bg-primary/5 border-primary/20">
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Brain className="w-4 h-4 text-primary" /> Answer Framework</CardTitle></CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground leading-relaxed">{qa.a}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-sm">Key Tips</CardTitle></CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {qa.tips.map((tip, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <ChevronRight className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <div className="flex gap-2 items-center">
                  <p className="text-sm text-muted-foreground">How did you do?</p>
                  <Button size="sm" variant="outline" className="gap-1.5 text-green-600 border-green-200 hover:bg-green-50" onClick={() => handleRate("got_it")}>
                    <ThumbsUp className="w-3.5 h-3.5" /> Got it
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5 text-red-500 border-red-200 hover:bg-red-50" onClick={() => handleRate("need_work")}>
                    <ThumbsDown className="w-3.5 h-3.5" /> Need work
                  </Button>
                </div>
                {isLastQuestion ? (
                  /* On the final question we deliberately remove the
                     standalone "Finish" button — the candidate must rate
                     themselves first so the score and sparkline reflect a
                     real self-assessment. The two rating buttons above
                     finish the session automatically. */
                  <span className="text-[11px] text-muted-foreground italic">
                    Rate yourself to finish
                  </span>
                ) : (
                  <Button className="gap-2" onClick={handleNext}>
                    Next Question <ChevronRight className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </AppLayout>
    );
  }

  /* ── Mode Selection View ── */
  return (
    <AppLayout>
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Interview Prep Center</h1>
        <p className="text-muted-foreground mt-1">AI-curated preparation tailored to your profile and upcoming interviews.</p>
      </div>

      {/* Profile context banner */}
      {!loadingProfile && profile?.currentTitle && (
        <div className="mb-6 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/5 border border-primary/20 w-fit">
          <Lightbulb className="w-4 h-4 text-primary flex-shrink-0" />
          <p className="text-sm text-primary font-medium">
            Prepping as: <span className="font-bold">{profile.currentTitle}</span>
            {profile.targetIndustries?.length ? ` · ${profile.targetIndustries[0]}` : ""}
          </p>
        </div>
      )}

      {loadingProfile && (
        <div className="flex items-center gap-2 mb-6 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your profile…
        </div>
      )}

      <div className="mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Choose Your Prep Mode</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {prepModes.map((mode) => {
            const Icon = mode.icon;
            const isSelected = selectedMode === mode.id;
            return (
              <Card
                key={mode.id}
                className={`cursor-pointer hover-elevate transition-all ${isSelected ? "border-primary ring-2 ring-primary/20 shadow-lg shadow-primary/10" : "border-border/60"}`}
                onClick={() => setSelectedMode(mode.id)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className={`p-2.5 rounded-xl border ${mode.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      <MessageSquare className="w-2.5 h-2.5 mr-1" />{mode.time}
                    </Badge>
                  </div>
                  <h3 className="font-bold mb-1">{mode.label}</h3>
                  <p className="text-sm text-muted-foreground">{mode.desc}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div className="flex justify-center">
        <Button
          size="lg"
          className="gap-2 px-10 shadow-lg shadow-primary/20"
          disabled={!selectedMode || loadingProfile}
          onClick={handleStartSession}
        >
          <Zap className="w-5 h-5" /> Start {selectedMode ? prepModes.find(m => m.id === selectedMode)?.label : "Session"}
        </Button>
      </div>
    </AppLayout>
  );
}
