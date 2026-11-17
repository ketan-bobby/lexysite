type Capability = { title: string; description: string };

const employerCapabilities: Capability[] = [
  {
    title: "Talent pools and internal mobility",
    description:
      "Rediscover people in your existing candidate pool and consider eligible employees for internal roles. Shared talent discovery respects candidate consent and employer access.",
  },
  {
    title: "Search, enrichment and role intelligence",
    description:
      "Search in natural language, review role-fit evidence and enrich profiles through configured sources. Market-intelligence tools provide context where data is available—not guaranteed contact details or hiring predictions.",
  },
  {
    title: "Work orders, teams and approvals",
    description:
      "Define the role and ideal candidate profile, assign recruiters, review work orders and manage candidates through a shared pipeline. Hiring managers can review permitted candidate packages and provide feedback.",
  },
  {
    title: "Outreach, replies and a shared inbox",
    description:
      "Edit message drafts before approval, track interest and replies, and manage follow-ups and notifications. Connected Outlook email and configured sending services depend on your account setup.",
  },
  {
    title: "Calendars, panels and candidate booking",
    description:
      "Connect authorized Outlook or Google calendars, coordinate panel availability and offer selected booking slots. Candidates can request time changes or withdraw a request without seeing anyone’s full calendar.",
  },
  {
    title: "Meeting links, recordings and notes",
    description:
      "Use configured Google Meet and Zoom workflows, review consented recordings and transcripts, and keep source-linked human-interview notes. Optional Recall attendance for managed Zoom meetings requires host approval, consent, setup and live acceptance.",
  },
  {
    title: "Reports, activity and oversight",
    description:
      "Review candidate evaluation reports, job and recruiter analytics, decision queues, activity history and fairness-monitoring tools. AI recommendations remain reviewable; monitoring tools do not certify legal compliance.",
  },
  {
    title: "Controlled offers and employer handoff",
    description:
      "Keep offer preparation, ownership, review, approval and deliberate sending with authorized people. Track responses and handoff history; an accepted offer is not proof of employment. Connected ATS offers require separate activation and acceptance.",
  },
];

const candidateCapabilities: Capability[] = [
  {
    title: "A career workspace, not just an interview",
    description:
      "Keep your career profile, goals, career-direction insights and suggested next steps together. Explore role and market context where supporting data is available.",
  },
  {
    title: "Learning, assessments and voice practice",
    description:
      "Explore enabled courses and learning paths, complete learning activities and assessments, and use available voice-progress exercises. Compare like-for-like progress where evidence supports it—not a guaranteed hiring outcome.",
  },
  {
    title: "Encouragement as you progress",
    description:
      "Track completed activities, progress reports and available badges or activity credits. These are private development tools, not employer scores, money or a promise of paid-feature access.",
  },
  {
    title: "Applications and interview appointments",
    description:
      "Follow your applications, access assigned interviews and confirmed meeting links, and manage appointment requests through the options offered for your interview. A requested change is not confirmed until approved.",
  },
  {
    title: "Your introduction and discovery choices",
    description:
      "Review the introduction you approve for employers, manage discovery preferences and control available role-alert subscriptions. Private practice, learning and baseline recordings are not repurposed as employer assessments.",
  },
  {
    title: "Notifications and privacy controls",
    description:
      "Manage account settings, notifications and supported privacy choices, including discovery withdrawal and deletion requests. Employer-directed interviews have their own purpose and consent process.",
  },
];

export default function ProductCapabilities({ audience }: { audience: "employers" | "candidates" }) {
  const employer = audience === "employers";
  const capabilities = employer ? employerCapabilities : candidateCapabilities;
  return (
    <section id="capabilities" className="py-24 px-6 border-t border-border/50">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-4">
            {employer ? "Across the hiring workflow" : "Across your career journey"}
          </p>
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
            {employer ? "More than sourcing. More than interviews." : "More ways to take your next step."}
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            {employer
              ? "The supporting tools that keep your team, evidence and candidate experience connected."
              : "Your profile, preparation, learning and opportunities belong in one connected experience."}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {capabilities.map(({ title, description }) => (
            <article key={title} className="marketing-panel rounded-2xl p-7">
              <h3 className="font-semibold text-lg mb-3">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            </article>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted-foreground max-w-3xl mx-auto">
          {employer
            ? "Capabilities depend on your workspace, permissions and connected accounts. External integrations require setup and acceptance checks; a connection is not a promise of every provider feature."
            : "Courses, exercises and programme access vary. Explore what is enabled in your account; development activity stays separate from job-specific employer assessment."}
        </p>
      </div>
    </section>
  );
}
