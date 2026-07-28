/**
 * lib/pipeline-defaults.ts — canonical default pipeline agent config.
 *
 * Extracted from routes/pipeline.ts so any route that must AUTO-CREATE a
 * job_pipelines row (e.g. the internal-talent review marker in routes/sourcing.ts)
 * seeds it with the same 10-agent default the pipeline canvas expects. Creating a
 * bare row with empty `agents` would suppress the canvas's first-load seeding and
 * leave the workflow with zero agents.
 */
export const DEFAULT_PIPELINE_AGENTS = [
  { id: "icp",          order: 1,  enabled: true,  label: "ICP Generation",    config: {} },
  { id: "sourcing",     order: 2,  enabled: true,  label: "Candidate Sourcing", config: { maxCandidates: 20, minScore: 60 } },
  { id: "screening",    order: 3,  enabled: true,  label: "Resume Screening",  config: { minScore: 70 } },
  { id: "verification", order: 4,  enabled: true,  label: "Verification",      config: {} },
  { id: "outreach",     order: 5,  enabled: true,  label: "Outreach",          config: {} },
  { id: "interview",    order: 6,  enabled: true,  label: "AI Interview",       config: { questionCount: 5, interviewType: "general" } },
  { id: "scheduling",   order: 7,  enabled: false, label: "Scheduling",        config: {} },
  { id: "anti-ghosting",order: 8,  enabled: false, label: "Anti-Ghosting",     config: {} },
  { id: "proctoring",   order: 9,  enabled: false, label: "Proctoring",        config: {} },
  { id: "analytics",   order: 10,  enabled: false, label: "Analytics",         config: {} },
];
