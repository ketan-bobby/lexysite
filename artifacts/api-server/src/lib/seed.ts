/**
 * seed.ts — Primary Demo Data Seeder
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Seeds a complete, self-consistent demo dataset for the "Acme Corp" tenant.
 * Creates one tenant, one platform admin, several recruiter users, sample jobs
 * with ICPs and pipeline configs, a pool of candidates with applications,
 * interview plans and sessions, outreach campaigns, inbox items, communication
 * events, ghosting risk rows, talent match scores, resume screens, and
 * candidate notifications.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * Checks whether the "acme-corp" tenant slug exists before inserting anything.
 * Safe to call on every server boot — skips if data already exists.
 *
 * ─── Also calls ──────────────────────────────────────────────────────────────
 *   seedClientHierarchy()  (seedClients.ts) — adds the NexGen staffing hierarchy
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/app.ts  — invoked once after the DB connection is established
 */
import { db } from "@workspace/db";
import {
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  icpTable,
  interviewPlansTable,
  interviewSessionsTable,
  interviewSchedulesTable,
  outreachCampaignsTable,
  recruiterInboxTable,
  communicationEventsTable,
  ghostingRisksTable,
  talentMatchesTable,
  resumeScreensTable,
  verificationRecordsTable,
  candidateNotificationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

export async function seedDemoData() {
  // Idempotency guard: bail out entirely if the demo tenant already exists so
  // repeated boots never duplicate rows.
  const existingTenant = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "acme-corp")).limit(1);
  if (existingTenant.length > 0) return;

  // ─── Tenant ────────────────────────────────────────────────────────────────
  const [tenant] = await db.insert(tenantsTable).values({
    name: "Acme Corp",
    slug: "acme-corp",
    plan: "enterprise",
    status: "active",
    primaryColor: "#4F46E5",
  }).returning();

  const [adminUser] = await db.insert(usersTable).values({
    tenantId: tenant.id,
    email: "admin@demo.com",
    name: "Alex Admin",
    // "demo" sentinel = passwordless legacy hash recognised by routes/auth.ts.
    // Used only for seeded demo accounts, never for real customer tenants.
    passwordHash: "demo",
    role: "platform_admin",
  }).returning();

  // ─── Users (admin / recruiter / candidate) ──────────────────────────────────
  const [recruiterUser] = await db.insert(usersTable).values({
    tenantId: tenant.id,
    email: "recruiter@demo.com",
    name: "Rachel Recruiter",
    passwordHash: "demo",
    role: "recruiter",
  }).returning();

  const [candidateUser] = await db.insert(usersTable).values({
    tenantId: tenant.id,
    email: "candidate@demo.com",
    name: "Chris Candidate",
    passwordHash: "demo",
    role: "candidate",
  }).returning();

  // ─── Jobs (mix of active/draft across departments) ──────────────────────────
  const jobs = await db.insert(jobsTable).values([
    {
      tenantId: tenant.id,
      title: "Senior Software Engineer",
      department: "Engineering",
      location: "San Francisco, CA",
      workType: "hybrid",
      employmentType: "full_time",
      salaryMin: 150000,
      salaryMax: 200000,
      description: "We are looking for a Senior Software Engineer to join our growing engineering team. You will be responsible for building and maintaining our core platform infrastructure.",
      status: "active",
    },
    {
      tenantId: tenant.id,
      title: "Product Manager",
      department: "Product",
      location: "New York, NY",
      workType: "remote",
      employmentType: "full_time",
      salaryMin: 130000,
      salaryMax: 170000,
      description: "Seeking an experienced Product Manager to drive our B2B SaaS roadmap. You will work closely with engineering, design, and go-to-market teams.",
      status: "active",
    },
    {
      tenantId: tenant.id,
      title: "Data Scientist",
      department: "Data",
      location: "Austin, TX",
      workType: "onsite",
      employmentType: "full_time",
      salaryMin: 120000,
      salaryMax: 160000,
      description: "Join our data science team to build ML models and analytics pipelines. Experience with Python, SQL, and machine learning frameworks required.",
      status: "draft",
    },
    {
      tenantId: tenant.id,
      title: "Head of Marketing",
      department: "Marketing",
      location: "Chicago, IL",
      workType: "hybrid",
      employmentType: "full_time",
      salaryMin: 140000,
      salaryMax: 180000,
      description: "Lead our marketing organization and drive growth across demand gen, brand, and product marketing.",
      status: "active",
    },
  ]).returning();

  // ─── Candidates (varied sources + verification states for demo realism) ─────
  const candidates = await db.insert(candidatesTable).values([
    {
      tenantId: tenant.id,
      firstName: "Sarah",
      lastName: "Chen",
      email: "sarah.chen@email.com",
      phone: "+1 (415) 555-0101",
      location: "San Francisco, CA",
      currentTitle: "Staff Engineer",
      currentCompany: "Stripe",
      linkedinUrl: "https://linkedin.com/in/sarahchen",
      githubUrl: "https://github.com/sarahchen",
      skills: ["TypeScript", "React", "Node.js", "PostgreSQL", "AWS", "System Design"],
      source: "linkedin",
      verificationStatus: "verified",
      talentMatchScore: 92,
      resumeScreenScore: 88,
    },
    {
      tenantId: tenant.id,
      firstName: "Marcus",
      lastName: "Johnson",
      email: "marcus.johnson@email.com",
      phone: "+1 (212) 555-0102",
      location: "New York, NY",
      currentTitle: "Senior Product Manager",
      currentCompany: "Spotify",
      linkedinUrl: "https://linkedin.com/in/marcusjohnson",
      skills: ["Product Strategy", "Roadmapping", "A/B Testing", "SQL", "User Research"],
      source: "referral",
      verificationStatus: "verified",
      talentMatchScore: 87,
      resumeScreenScore: 82,
    },
    {
      tenantId: tenant.id,
      firstName: "Priya",
      lastName: "Patel",
      email: "priya.patel@email.com",
      phone: "+1 (650) 555-0103",
      location: "Mountain View, CA",
      currentTitle: "Senior Data Scientist",
      currentCompany: "Google",
      linkedinUrl: "https://linkedin.com/in/priyapatel",
      githubUrl: "https://github.com/priyapatel",
      skills: ["Python", "TensorFlow", "SQL", "BigQuery", "Machine Learning", "Statistics"],
      source: "pdl",
      verificationStatus: "unverified",
      talentMatchScore: 79,
      resumeScreenScore: 85,
    },
    {
      tenantId: tenant.id,
      firstName: "David",
      lastName: "Kim",
      email: "david.kim@email.com",
      phone: "+1 (512) 555-0104",
      location: "Austin, TX",
      currentTitle: "Backend Engineer",
      currentCompany: "Cloudflare",
      skills: ["Go", "Rust", "Kubernetes", "PostgreSQL", "gRPC"],
      source: "github",
      verificationStatus: "flagged",
      talentMatchScore: 63,
      resumeScreenScore: 70,
    },
    {
      tenantId: tenant.id,
      firstName: "Emma",
      lastName: "Williams",
      email: "emma.williams@email.com",
      location: "Boston, MA",
      currentTitle: "Product Marketing Manager",
      currentCompany: "HubSpot",
      skills: ["Demand Generation", "Content Strategy", "SEO", "Marketing Automation", "Salesforce"],
      source: "internal",
      verificationStatus: "verified",
      talentMatchScore: 85,
      resumeScreenScore: 80,
    },
    {
      tenantId: tenant.id,
      firstName: "Chris",
      lastName: "Candidate",
      email: "candidate@demo.com",
      phone: "+1 (555) 555-0100",
      location: "Remote",
      currentTitle: "Full Stack Developer",
      currentCompany: "TechStartup Inc",
      skills: ["React", "TypeScript", "Node.js", "Docker"],
      source: "applied",
      verificationStatus: "unverified",
      talentMatchScore: 76,
      resumeScreenScore: 73,
    },
  ]).returning();

  const [sarah, marcus, priya, david, emma, chris] = candidates;

  // ─── Applications (spread across pipeline stages) ────────────────────────────
  const applications = await db.insert(applicationsTable).values([
    { tenantId: tenant.id, jobId: jobs[0].id, candidateId: sarah.id, stage: "interview", matchScore: 92 },
    { tenantId: tenant.id, jobId: jobs[0].id, candidateId: david.id, stage: "screening", matchScore: 63 },
    { tenantId: tenant.id, jobId: jobs[0].id, candidateId: priya.id, stage: "sourced", matchScore: 79 },
    { tenantId: tenant.id, jobId: jobs[1].id, candidateId: marcus.id, stage: "offer", matchScore: 87 },
    { tenantId: tenant.id, jobId: jobs[3].id, candidateId: emma.id, stage: "hired", matchScore: 85 },
    { tenantId: tenant.id, jobId: jobs[0].id, candidateId: chris.id, stage: "applied", matchScore: 76 },
  ]).returning();

  // ─── ICP (ideal-candidate profile) for the Senior Engineer role ─────────────
  await db.insert(icpTable).values({
    tenantId: tenant.id,
    jobId: jobs[0].id,
    version: 1,
    jobTitle: "Senior Software Engineer",
    roleFamily: "Engineering",
    seniority: "Senior",
    requiredSkills: ["TypeScript", "React", "Node.js", "PostgreSQL", "REST APIs"],
    preferredSkills: ["GraphQL", "Redis", "AWS", "Docker"],
    yearsExperienceMin: 5,
    yearsExperienceMax: 10,
    industryBackground: ["SaaS", "Enterprise Software"],
    educationRequirements: "Bachelor's in CS or equivalent",
    mustHaves: ["5+ years full-stack", "TypeScript proficiency", "Production experience"],
    niceToHaves: ["Open source contributions", "Startup experience"],
    disqualifiers: ["No TypeScript experience", "Less than 3 years"],
    expandedSkillGraph: {
      TypeScript: ["JavaScript", "Node.js", "React", "Type safety"],
      React: ["Next.js", "Redux", "React Query"],
      "Node.js": ["Express", "NestJS", "REST APIs"],
    },
    weightedAttributes: { TypeScript: 0.9, React: 0.85, "Node.js": 0.85, PostgreSQL: 0.75 },
  });

  // ─── Interview plan + a completed session + upcoming schedules ──────────────
  const [interviewPlan] = await db.insert(interviewPlansTable).values({
    tenantId: tenant.id,
    jobId: jobs[0].id,
    title: "Senior Software Engineer Interview",
    interviewType: "technical",
    estimatedDurationMinutes: 45,
    questions: [
      { id: "q1", text: "Describe a complex distributed system you've built or maintained.", category: "technical", followUpPrompts: ["How did you handle consistency?", "What was the biggest challenge?"], order: 1 },
      { id: "q2", text: "How do you approach code reviews and ensuring code quality?", category: "technical", followUpPrompts: ["What tools do you use?", "Give a specific example."], order: 2 },
      { id: "q3", text: "Tell me about a time you had to make a difficult technical decision with incomplete information.", category: "behavioral", followUpPrompts: ["What was the outcome?", "What would you do differently?"], order: 3 },
      { id: "q4", text: "Walk me through how you would design a URL shortening service.", category: "technical", followUpPrompts: ["How would you scale to 1B URLs?", "How do you handle redirects efficiently?"], order: 4 },
      { id: "q5", text: "How do you stay current with new technologies and best practices?", category: "competency", followUpPrompts: ["Give a recent example.", "How do you evaluate new tech?"], order: 5 },
    ],
  }).returning();

  const [interviewSession] = await db.insert(interviewSessionsTable).values({
    tenantId: tenant.id,
    applicationId: applications[0].id,
    planId: interviewPlan.id,
    candidateId: sarah.id,
    status: "completed",
    currentQuestionIndex: 5,
    totalQuestions: 5,
    score: 87,
    startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 45 * 60 * 1000),
    answers: [
      { questionId: "q1", answer: "At Stripe, I built a distributed payment reconciliation system handling 50M transactions daily...", score: 90 },
      { questionId: "q2", answer: "I believe code reviews are essential. I use PRs with required approvals, automated linting, and encourage small focused changes...", score: 85 },
    ],
  }).returning();

  await db.insert(interviewSchedulesTable).values([
    {
      tenantId: tenant.id,
      applicationId: applications[0].id,
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      durationMinutes: 60,
      type: "Technical Interview - Round 2",
      status: "confirmed",
      notes: "System design focus",
    },
    {
      tenantId: tenant.id,
      applicationId: applications[5].id,
      scheduledAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      durationMinutes: 30,
      type: "AI Screening Interview",
      status: "pending",
    },
  ]);

  // ─── Outreach campaign + recruiter inbox items it generated ─────────────────
  const [campaign] = await db.insert(outreachCampaignsTable).values({
    tenantId: tenant.id,
    jobId: jobs[0].id,
    name: "Senior Engineer Q1 Pipeline",
    status: "active",
    autopilotEnabled: true,
    targetPositiveReplies: 20,
    enrollmentThresholdScore: 70,
    enrolledCount: 47,
    repliedCount: 18,
    positiveRepliesCount: 8,
    sentCount: 94,
    openRate: 0.52,
    replyRate: 0.19,
  }).returning();

  await db.insert(recruiterInboxTable).values([
    {
      tenantId: tenant.id,
      type: "positive_reply",
      candidateId: sarah.id,
      campaignId: campaign.id,
      subject: "Re: Exciting Senior Engineer opportunity at Acme",
      preview: "Hi Rachel, thanks for reaching out! I'd definitely be interested in learning more about this role...",
      isRead: false,
      priority: "high",
    },
    {
      tenantId: tenant.id,
      type: "question",
      candidateId: marcus.id,
      campaignId: campaign.id,
      subject: "Question about the role",
      preview: "Can you tell me more about the team structure and tech stack you're working with?",
      isRead: false,
      priority: "normal",
    },
    {
      tenantId: tenant.id,
      type: "needs_followup",
      candidateId: priya.id,
      campaignId: campaign.id,
      subject: "Following up on our conversation",
      preview: "I haven't heard back from Priya in 5 days. Consider sending a follow-up.",
      isRead: true,
      priority: "urgent",
    },
  ]);

  // ─── Communication events (delivered/sent message history) ──────────────────
  await db.insert(communicationEventsTable).values([
    {
      tenantId: tenant.id,
      candidateId: sarah.id,
      applicationId: applications[0].id,
      type: "interview_reminder",
      channel: "email",
      status: "delivered",
      subject: "Reminder: Your interview is tomorrow",
      body: "Hi Sarah, just a reminder that your technical interview is scheduled for tomorrow at 2pm PST.",
      sentAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    },
    {
      tenantId: tenant.id,
      candidateId: priya.id,
      type: "scheduling_nudge",
      channel: "email",
      status: "sent",
      subject: "Let's get you scheduled",
      body: "Hi Priya, we'd love to move forward with your application. Please pick a time for your screening call.",
      sentAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    },
  ]);

  // ─── Anti-ghosting risk rows (drives the recruiter risk dashboard) ──────────
  await db.insert(ghostingRisksTable).values([
    {
      tenantId: tenant.id,
      candidateId: priya.id,
      applicationId: applications[2].id,
      riskLevel: "high",
      daysSinceLastContact: 7,
      lastContactType: "scheduling_nudge",
      nextRequiredAction: "Send follow-up email or mark as unresponsive",
    },
    {
      tenantId: tenant.id,
      candidateId: david.id,
      applicationId: applications[1].id,
      riskLevel: "critical",
      daysSinceLastContact: 14,
      lastContactType: "interview_reminder",
      nextRequiredAction: "Call candidate directly",
    },
  ]);

  // ─── Talent-match score + resume screen + verification records ──────────────
  await db.insert(talentMatchesTable).values([
    {
      tenantId: tenant.id,
      candidateId: sarah.id,
      jobId: jobs[0].id,
      fitScore: 92,
      matchExplanation: "Exceptional match. Sarah's experience at Stripe aligns perfectly with the technical requirements. Strong TypeScript, React, and Node.js skills exceed minimum requirements.",
      strengths: ["TypeScript expert", "Enterprise-scale experience", "Full-stack proficiency", "System design skills"],
      gaps: ["No Kubernetes experience", "GraphQL limited exposure"],
      recommendation: "strong_yes",
    },
  ]);

  await db.insert(resumeScreensTable).values([
    {
      tenantId: tenant.id,
      candidateId: sarah.id,
      jobId: jobs[0].id,
      screeningScore: 88,
      extractedSkills: ["TypeScript", "React", "Node.js", "PostgreSQL", "AWS", "Redis"],
      missingSkills: ["Kubernetes", "GraphQL"],
      adjacentSkills: ["JavaScript", "Python", "Terraform"],
      workHistory: [
        { company: "Stripe", title: "Staff Engineer", startDate: "2021-01", endDate: null, current: true },
        { company: "Airbnb", title: "Senior Engineer", startDate: "2018-03", endDate: "2020-12", current: false },
      ],
      education: ["BS Computer Science, MIT"],
      recruiterSummary: "Strong senior engineer candidate with 7 years of relevant experience. Excellent TypeScript and systems skills from Stripe. Minor gaps in infrastructure tools but strong fundamentals.",
    },
  ]);

  await db.insert(verificationRecordsTable).values([
    {
      tenantId: tenant.id,
      candidateId: sarah.id,
      status: "verified",
      riskScore: 5,
      identityVerified: true,
      duplicateDetected: false,
      resumeConsistencyScore: 95,
      flags: [],
    },
    {
      tenantId: tenant.id,
      candidateId: david.id,
      status: "flagged",
      riskScore: 68,
      identityVerified: false,
      duplicateDetected: true,
      resumeConsistencyScore: 52,
      flags: [
        { type: "duplicate_profile", severity: "high", description: "Similar profile found under different email", detectedAt: new Date().toISOString() },
        { type: "resume_inconsistency", severity: "medium", description: "Employment dates don't match LinkedIn", detectedAt: new Date().toISOString() },
      ],
    },
  ]);

  // ─── Candidate-facing notifications (portal bell) ───────────────────────────
  await db.insert(candidateNotificationsTable).values([
    {
      tenantId: tenant.id,
      candidateId: chris.id,
      type: "interview_scheduled",
      title: "Interview Scheduled",
      message: "Your AI screening interview has been scheduled for tomorrow at 10am.",
      isRead: false,
      actionUrl: "/portal/interviews",
    },
    {
      tenantId: tenant.id,
      candidateId: chris.id,
      type: "application_update",
      title: "Application Update",
      message: "Your application for Senior Software Engineer has moved to the screening stage.",
      isRead: false,
    },
    {
      tenantId: tenant.id,
      candidateId: chris.id,
      type: "prep_ready",
      title: "Interview Prep Ready",
      message: "We've generated a personalized prep plan for your upcoming interview. Start preparing now!",
      isRead: true,
      actionUrl: "/portal/prep",
    },
  ]);
}
