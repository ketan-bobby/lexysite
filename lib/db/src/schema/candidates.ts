/**
 * schema/candidates.ts — Core Candidate Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidates   — Central record for every person in the Lexy platform, whether
 *                  they applied directly, were sourced externally, or registered
 *                  via the candidate portal. Stores PII (name, email, phone),
 *                  resume path, AI-assessed skills, parsed work history, and
 *                  DNC / verification status flags.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   verification_status — unverified · pending · verified · flagged
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/candidates.ts       — full CRUD
 *   routes/career-profile.ts   — portal profile reads/writes
 *   lib/intelligence.ts        — scoring input
 */
import { pgTable, text, timestamp, real, integer, pgEnum, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const verificationStatusEnum = pgEnum("verification_status", [
  "unverified",
  "pending",
  "verified",
  "flagged",
]);

export const candidatesTable = pgTable("candidates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  /** Canonical link to the portal user that owns this candidate row.
   *  Populated when the candidate self-registers (/career-register) or
   *  accepts a recruiter portal invite. NULL for sourced/imported candidates
   *  that have never been given portal access. getCandidateId() resolves the
   *  candidate session via this FK — NEVER via email — to prevent a
   *  recruiter/admin whose email matches a candidate's from shadowing that
   *  candidate's PII. UNIQUE per non-NULL value (see migration 0012). */
  userId: text("user_id"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  location: text("location"),
  timezone: text("timezone"),
  currentTitle: text("current_title"),
  currentCompany: text("current_company"),
  linkedinUrl: text("linkedin_url"),
  githubUrl: text("github_url"),
  skills: text("skills").array().notNull().default([]),
  source: text("source"),
  verificationStatus: verificationStatusEnum("verification_status").notNull().default("unverified"),
  /* Full Verification Agent output (linkedinMatch, resumeConsistency,
   * emailValidity, profileCompleteness, riskFlags, checksPerformed,
   * overallScore, verdict, notes). Mirrors what sourced candidates keep in
   * sourced_candidates.rawData.verificationResult so the kanban card and
   * candidate detail dialog can render the verdict for application-based
   * (manual/applied) candidates too. NULL until verification has been run. */
  verificationResult: jsonb("verification_result"),
  resumeUrl: text("resume_url"),
  talentMatchScore: real("talent_match_score"),
  resumeScreenScore: real("resume_screen_score"),
  pool: text("pool").notNull().default("tenant"),
  doNotContact: boolean("do_not_contact").notNull().default(false),
  dncAt: timestamp("dnc_at"),
  dncReason: text("dnc_reason"),
  dncSetBy: text("dnc_set_by"),
  dataErasedAt: timestamp("data_erased_at"),
  hiringManagerApproval: text("hiring_manager_approval"),
  createdById: text("created_by_id"),
  weeklyDigestLastSentAt: timestamp("weekly_digest_last_sent_at"),
  /* ── Work authorization / sponsorship (screening data, NOT demographics) ──
   * These are job-relevant screening fields the candidate self-reports
   * during portal onboarding. Recruiters SEE these on the candidate card
   * (legitimate hiring use). Distinct from `candidate_demographics`, which
   * houses voluntary, non-decisional, aggregate-only data. */
  workAuthorized: boolean("work_authorized"),                 // null = not yet answered
  requiresSponsorship: boolean("requires_sponsorship"),       // null = not yet answered
  sponsorshipCountry: text("sponsorship_country"),            // country the candidate is authorized for / needs sponsorship into
  sponsorshipNotes: text("sponsorship_notes"),                // free-text candidate context (e.g. "H-1B transfer required")
  screeningCompletedAt: timestamp("screening_completed_at"),  // null = onboarding screening step not yet finished
  workAuthSource: text("work_auth_source"),                   // provenance of work-auth answers: 'self_report' | 'baseline_interview' | 'job_interview' | null
  /* True when this candidate is a current employee of `tenantId` (e.g.
     imported via an HRIS/ATS sync the tenant authorized). The sourcing engine
     ALWAYS includes current employees in results so internal mobility is
     never missed, regardless of which external sources are toggled on. */
  isCurrentEmployee: boolean("is_current_employee").notNull().default(false),
  /* Candidate-controlled privacy: hide profile from current employer entirely. */
  hideFromCurrentEmployer: boolean("hide_from_current_employer").notNull().default(false),
  /* Domain (e.g. "stripe.com") used to match the recruiter tenant for hide-from-employer. */
  currentEmployerDomain: text("current_employer_domain"),
  /* Array of domains the candidate has explicitly opted out of. */
  blockedCompanyDomains: jsonb("blocked_company_domains").notNull().default([]),
  /* Match-only visibility: when true, the candidate is only visible to recruiter
     tenants that have at least one open job whose title overlaps with the
     candidate's preferredRoles. Brochure promise: "Show your profile only to
     recruiters whose roles genuinely match." Enforced in candidates route's
     applyCandidatePrivacyFilter alongside the hide/blocklist controls. */
  matchOnlyVisibility: boolean("match_only_visibility").notNull().default(false),
  /* Master "pause discovery" switch — brochure Privacy slide: "Stay invisible
     until you're ready." When true, the candidate is hidden from ALL recruiter
     search/discovery surfaces regardless of any other privacy setting. They
     remain visible to recruiters they've explicitly applied to or interviewed
     with (those relationships are candidate-initiated, not discovery). */
  discoveryPaused: boolean("discovery_paused").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  /* One candidate per real email, per tenant. Synthetic placeholder emails
   * minted for "no-email" candidates (…@unknown.local from manual/pipeline adds,
   * …@import.local from bulk imports) are EXCLUDED so multiple no-email people
   * never collide. Recruiter add/upload paths surface a merge prompt on conflict;
   * async paths (public apply, sourcing, import) merge-by-email instead of
   * inserting a duplicate. This partial unique index is the hard backstop the
   * route code already assumes exists. */
  tenantEmailLowerUniq: uniqueIndex("candidates_tenant_email_lower_uniq")
    .on(t.tenantId, sql`lower(${t.email})`)
    .where(sql`${t.email} NOT LIKE '%@unknown.local' AND ${t.email} NOT LIKE '%@import.local'`),
}));

export const insertCandidateSchema = createInsertSchema(candidatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectCandidateSchema = createSelectSchema(candidatesTable);
export type InsertCandidate = z.infer<typeof insertCandidateSchema>;
export type Candidate = typeof candidatesTable.$inferSelect;
