/**
 * tours.ts — Product tour definitions for the Lexy recruiter app.
 *
 * Each tour is a list of react-joyride Step objects. Targets are CSS selectors
 * that point at `data-tour="..."` attributes spread across the app.
 *
 * Tours are scoped to a route prefix so they only auto-launch on the relevant
 * page. The TourProvider tracks completion in localStorage per tour-id so a
 * recruiter never sees the same tour twice unless they replay it from the
 * Help menu.
 */
import type { Step } from "react-joyride";

export type TourId =
  | "welcome"
  | "jobs-list"
  | "job-detail"
  | "sourcing"
  | "outreach";

export interface TourDef {
  id: TourId;
  title: string;
  description: string;
  /** Route prefix(es) this tour auto-launches on. */
  routes: string[];
  steps: Step[];
}

const baseStep: Partial<Step> = {
  skipBeacon: true,
  spotlightPadding: 6,
  zIndex: 10000,
};

export const tours: Record<TourId, TourDef> = {
  welcome: {
    id: "welcome",
    title: "Welcome tour",
    description: "60-second tour of the L3xy sidebar and main flow.",
    routes: ["/dashboard"],
    steps: [
      {
        ...baseStep,
        target: '[data-tour="help-button"]',
        placement: "bottom-end",
        title: "Welcome to L3xy 👋",
        content:
          "This is a 60-second tour of how to hire with Lexy AI. You can replay it anytime from this Help icon.",
      },
      {
        ...baseStep,
        target: '[data-tour="nav-jobs"]',
        placement: "right",
        title: "1. Work Orders",
        content:
          "All your active roles live here. Each role has its own AI-driven workflow — ICP, sourcing, outreach, screening, interviews.",
      },
      {
        ...baseStep,
        target: '[data-tour="nav-candidates"]',
        placement: "right",
        title: "2. Candidates",
        content:
          "Every candidate sourced or imported across all your roles. Search, filter, and add to roles from here.",
      },
      {
        ...baseStep,
        target: '[data-tour="nav-inbox"]',
        placement: "right",
        title: "3. Inbox",
        content:
          "All candidate replies — emails, LinkedIn DMs, SMS — show up here, classified by Lexy AI (Interested / Pass / Question).",
      },
      {
        ...baseStep,
        target: '[data-tour="nav-engagement"]',
        placement: "right",
        title: "4. Engagement",
        content:
          "See how every candidate in your pipeline is engaging — opens, clicks, ghosts, and AI-suggested next actions.",
      },
    ],
  },

  "jobs-list": {
    id: "jobs-list",
    title: "Work Orders tour",
    description: "How to read your jobs board.",
    routes: ["/jobs"],
    steps: [
      {
        ...baseStep,
        target: '[data-tour="jobs-page-title"]',
        placement: "bottom-start",
        title: "Your jobs board",
        content:
          "Every card below is a role you're hiring for. Each role has its own AI-driven workflow — ICP, sourcing, outreach, candidates, interviews.",
      },
      {
        ...baseStep,
        target: '[data-tour="jobs-create-button"]',
        placement: "bottom-end",
        title: "Create a new role",
        content:
          "Click here to spin up a new work order. Lexy will help you draft the ICP, then source and screen candidates against it.",
      },
    ],
  },

  "job-detail": {
    id: "job-detail",
    title: "Hiring workflow tour",
    description: "How to run a role end-to-end.",
    routes: ["/jobs/"],
    steps: [
      {
        ...baseStep,
        target: '[data-tour="job-tabs"]',
        placement: "bottom",
        title: "The 6-step hiring workflow",
        content:
          "Every role flows left-to-right through these tabs: Overview → Workflow → ICP → Pipeline → Outreach → Anti-Ghost. Follow them in order.",
      },
      {
        ...baseStep,
        target: '[data-tour="tab-icp"]',
        placement: "bottom",
        title: "Step 1 — ICP (AI)",
        content:
          "Start here. The Ideal Candidate Profile is what every downstream AI agent uses to score candidates. No ICP = no scoring = no good sourcing.",
      },
      {
        ...baseStep,
        target: '[data-tour="tab-pipeline"]',
        placement: "bottom",
        title: "Step 2 — Pipeline / Sourcing",
        content:
          "Once the ICP is generated, hit Pipeline to source from LinkedIn, GitHub, AngelList, BuiltIn, or our enriched database (EnrichLayer).",
      },
      {
        ...baseStep,
        target: '[data-tour="tab-candidates"]',
        placement: "bottom",
        title: "Step 3 — Candidates",
        content:
          "All sourced + imported candidates land here, scored against the ICP. Move them through the pipeline stages.",
      },
      {
        ...baseStep,
        target: '[data-tour="tab-outreach"]',
        placement: "bottom",
        title: "Step 4 — Outreach",
        content:
          "Send AI-personalized outreach. Lexy drafts the message using the candidate's profile + ICP + your tone.",
      },
    ],
  },

  sourcing: {
    id: "sourcing",
    title: "Sourcing tour",
    description: "How to source candidates for a role.",
    routes: ["/sourcing"],
    steps: [
      {
        ...baseStep,
        target: '[data-tour="sourcing-page-title"]',
        placement: "bottom-start",
        title: "Multi-source sourcing",
        content:
          "Pick a role on this page, then run sourcing across LinkedIn, GitHub, AngelList, BuiltIn, and our EnrichLayer-enriched database — all in one click. Results are scored against the ICP.",
      },
    ],
  },

  outreach: {
    id: "outreach",
    title: "Inbox tour",
    description: "How to triage replies.",
    routes: ["/outreach/inbox"],
    steps: [
      {
        ...baseStep,
        target: '[data-tour="nav-inbox"]',
        placement: "right",
        title: "Smart inbox",
        content:
          "Every reply is auto-classified — Interested, Question, Pass, Ghost. Quick-reply suggestions are AI-generated based on the candidate, role, and conversation history.",
      },
    ],
  },
};

/** Lookup a tour that auto-launches for the given pathname, if any. */
export function tourForPath(pathname: string): TourDef | null {
  const matches = Object.values(tours).filter(t =>
    t.routes.some(r => pathname === r || pathname.startsWith(r)),
  );
  if (matches.length === 0) return null;
  // Prefer the most specific match (longest prefix).
  matches.sort((a, b) => {
    const al = Math.max(...a.routes.map(r => r.length));
    const bl = Math.max(...b.routes.map(r => r.length));
    return bl - al;
  });
  return matches[0];
}
